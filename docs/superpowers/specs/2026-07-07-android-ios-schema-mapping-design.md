# Android → iOS WhatsApp Schema Mapping — Design

## Goal

Replace the current bare-minimum `schema-mapper.js` (which only ports chat identity + plain text)
with a fuller mapping that preserves media attachments, group chats/members, locations, contact
cards, stickers, and quoted replies — verified against real schemas pulled from a live Android
device and a real iOS local backup, not assumed from memory.

## Scope

**In scope (v1):**
- Text messages, media (image/video/audio/document), group chats + members, quoted replies,
  locations, contact cards (vCards), stickers.
- Pulling the actual media file bytes off the Android device (not just DB rows referencing them)
  and registering them properly into the iOS local backup (content-addressed file + correct
  `Manifest.db` entry), so a real iOS restore can find them.
- Missing-media handling: if a referenced file no longer exists in WhatsApp's own local Media
  folder on the Android device, the message is still migrated with its text/metadata; the media
  item is marked unavailable rather than blocking or dropping the message.

**Explicitly out of scope (v1):**
- Reactions — no durable local table for them exists anywhere in the real 17-table iOS
  `ChatStorage.sqlite` schema we inspected (`Z_PRIMARYKEY` only lists: BlackListItem,
  ChatProperties, ChatPushConfig, ChatSession, GroupInfo, GroupMember, GroupMembersChange,
  MediaItem, Message, MessageDataItem, MessageInfo, ProfilePictureItem, ProfilePushName,
  VCardMention, Z1PaymentTransaction). Reactions likely live purely in WhatsApp's sync protocol,
  not as a local Core Data row.
- Polls, payments, business/catalog features, AI chat threads, communities, statuses/stories, calls.
- Camera-roll fallback scan for media missing from WhatsApp's own folder — out of scope for this
  pass; a missing file is simply reported, not chased down elsewhere on the device.
- Google Drive backup integration (OAuth flow, Drive API, WhatsApp's separate Drive-backup
  encryption scheme) — this is a real fallback for media WhatsApp itself has deleted locally, but
  is large, independent new work. Deferred to its own future design.

## Architecture

Per-entity mapper modules (chosen over one big function or a two-pass intermediate model — this
codebase has exactly one fixed source/destination schema pair, so a normalization layer isn't
earning its keep; a monolithic function doesn't scale to 7+ entity types + file registration).

```
main/modules/
  schema-mapper.js          — thin orchestrator (rewritten)
  ios-backup-writer.js      — NEW: registers a file into the iOS backup
                               (content-addressed path + Manifest.db row)
  mappers/
    chat.js                 — chat + jid -> ZWACHATSESSION
    message.js              — message -> ZWAMESSAGE (+ classification)
    media.js                — message_media -> ZWAMEDIAITEM (calls ios-backup-writer)
    group.js                — group_participant_user + jid -> ZWAGROUPINFO / ZWAGROUPMEMBER
    quoted-reply.js          — message_quoted -> ZWAMESSAGEDATAITEM (reply variant)
    location.js              — message_location -> ZWAMEDIAITEM (lat/long fields live there)
    vcard.js                 — message_vcard -> ZWAVCARDMENTION + ZWAMEDIAITEM
    sticker.js                — message_sticker_pack join -> ZWAMEDIAITEM (sticker-flavored)
```

**Classification principle:** each mapper decides whether it applies to a given message by
checking for a matching row in the relevant Android side table (`message_media`,
`message_location`, `message_vcard`, `message_quoted`, `message_sticker_pack`) — not by trusting
Android's numeric `message.message_type` column, which has dozens of undocumented values.

## Data flow

0. **New: pull referenced media off the Android device.** After parsing the Android DB, collect
   the distinct `message_media.file_path` values for in-scope messages (paths like
   `Media/WhatsApp Images/IMG-20220826-WA0000.jpg`, confirmed readable via plain `adb pull`
   without root — same access level as the database pull). Only pull what's referenced, not the
   whole `Media/` tree (which also holds AI Media, wallpapers, bug-report attachments we don't
   want). New `adb.js` method: `pullMediaFiles(serial, appId, referencedPaths, outputDir)`. Track
   and report files that no longer exist on-device.
1. Read Android chats/messages via extended `queryChats`/`queryMessages`-style joins (now also
   pulling `message_location`, `message_vcard`, `message_quoted`, `message_sticker_pack` per
   message).
2. Insert `ZWACHATSESSION` rows (`chat.js`) — build `sessionMap` (Android jid → new iOS `Z_PK`).
3. Insert `ZWAGROUPINFO`/`ZWAGROUPMEMBER` for group chats (`group.js`).
4. Per message, in one transaction: insert `ZWAMESSAGE` (`message.js`), then whichever of
   media/location/vcard/sticker/quoted-reply applies, linking back via `ZMESSAGE`/`ZCHATSESSION`.
5. For media/sticker/vcard-photo files: `ios-backup-writer.js` computes the iOS-side
   `relativePath`, hashes `domain-relativePath` (SHA-1) for the file ID, copies bytes to
   `<backupId>/<fileID[0:2]>/<fileID>`, and inserts/updates the `Manifest.db` `Files` row with a
   correctly-built metadata blob.
6. After all inserts: update `Z_PRIMARYKEY.Z_MAX` for every touched entity to the new max `Z_PK`
   (currently missing — required so Core Data doesn't reuse/collide IDs after restore), and set
   the correct `Z_ENT` value on every inserted row (also currently missing).

## Entity mapping table

| Android source | iOS destination | Key fields | Z_ENT |
|---|---|---|---|
| `chat` + `jid` | `ZWACHATSESSION` | `jid.raw_string`→`ZCONTACTJID`, `chat.subject`→`ZPARTNERNAME`, last message timestamp→`ZLASTMESSAGEDATE`, message count→`ZMESSAGECOUNTER` | 4 |
| `message` | `ZWAMESSAGE` | `from_me`→`ZISFROMME`, `timestamp`→`ZMESSAGEDATE`/`ZSENTDATE` (ms→Apple epoch), `text_data`→`ZTEXT`, `status`→`ZMESSAGESTATUS`, `key_id`→`ZSTANZAID`, sender jid (group msgs)→`ZFROMJID` | 9 |
| `message_media` | `ZWAMEDIAITEM` | `file_length`→`ZFILESIZE`, width/height→`ZASPECTRATIO`, `media_duration`→`ZMOVIEDURATION`; bytes registered via `ios-backup-writer.js`, path in `ZMEDIALOCALPATH` | 8 |
| `message_location` | `ZWAMEDIAITEM` (lat/long fields live directly on media, no separate location entity) | `latitude`/`longitude`→`ZLATITUDE`/`ZLONGITUDE`, `place_name`→`ZTITLE` | 8 |
| `message_vcard` | `ZWAVCARDMENTION` + `ZWAMEDIAITEM` | raw vCard text→`ZVCARDSTRING`, parsed name→`ZVCARDNAME`, parsed phone/jid→`ZWHATSAPPID` | 8 + 14 |
| `message_sticker_pack` (join) | `ZWAMEDIAITEM` | Same path as media — "stickerness" implied by file type | 8 |
| `message_quoted` | `ZWAMESSAGEDATAITEM` | quoted `text_data`→`ZCONTENT1`, quoted sender→`ZSENDERJID`, quoted `timestamp`→`ZDATE` (self-contained snapshot) | 10 |
| `group_participant_user` (+ `jid`) | `ZWAGROUPINFO` + `ZWAGROUPMEMBER` | group creator/owner jid→`ZCREATORJID`/`ZOWNERJID`, each participant→a `ZWAGROUPMEMBER` row, `rank`→best-effort `ZISADMIN` | 5 + 6 |

**Research items for the implementation phase** (verify empirically, don't guess from memory —
same discipline as the earlier crypt14 fix):
1. Exact numeric `ZMESSAGETYPE` codes, and the `ZWAMESSAGEDATAITEM.ZTYPE` code for "quoted reply"
   (only `ZTYPE=0` = link preview was directly observed in real data).
2. `group_participant_user.rank`'s exact meaning as an admin-status proxy.
3. The real iOS-side `relativePath` convention WhatsApp uses for media files inside the App Group
   container (this backup has no cached media file entries to sample directly).

## Error handling

- Per-message isolation: each message (and its media/location/vcard/quoted-reply/group insert)
  runs in its own try/catch inside the batched transaction — one bad row logs and skips, it
  doesn't abort the whole migration.
- Missing media file: `ios-backup-writer.js` returns a clear "not found" result rather than
  throwing; `media.js` still inserts the `ZWAMEDIAITEM` row (message isn't dropped) but leaves
  path fields empty and increments a `mediaMissing` counter surfaced in the final summary.
- `Manifest.db` write failures: throw and halt that file's registration — better one missing
  photo than a corrupted `Manifest.db` that breaks the whole restore. (This is also the step
  that was previously silently broken — a dead `UPDATE` statement that never ran.)
- `Z_MAX`/`Z_ENT` bookkeeping happens once, at the end, in its own transaction, and must succeed
  before the manifest patch step runs (not interleaved with it).

## Testing plan

- Unit-test each mapper module in isolation with synthetic Android row fixtures → assert exact
  iOS row values produced (pure functions, no DB needed).
- Integration test using the real (already decrypted) `msgstore.db` and a copy of the real
  `ChatStorage.sqlite`: run the full merge, assert row counts land in expected ranges, `Z_ENT`/
  `Z_MAX` are consistent, spot-check known messages/media/group chats by hand.
- Focused test for `ios-backup-writer.js`: register a fake file, then independently verify (via a
  fresh `Manifest.db` read + file-ID hash recomputation) that iOS's own lookup convention would
  find it — the part most likely to silently produce a backup that looks right in our own DB but
  fails a real restore.
- No automated way to verify an actual iPhone restore short of doing one by hand — stays a manual
  verification step before calling this feature done.
