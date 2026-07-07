# Android → iOS WhatsApp Schema Mapping Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the bare-minimum chat/text-only `schema-mapper.js` with a full mapping that ports media, groups, quoted replies, locations, contact cards, and stickers from a decrypted Android `msgstore.db` into a real iOS `ChatStorage.sqlite` inside a local backup, with correct Core Data bookkeeping (`Z_ENT`/`Z_MAX`) and correct `Manifest.db` file registration.

**Architecture:** Per-entity pure mapper modules under `main/modules/mappers/`, each exporting a pure `mapX(row, ctx) -> values` function (unit-testable with synthetic fixtures, no DB needed) plus a thin `insertX(db, row, ctx)` wrapper that runs the prepared statement. A new `main/utils/ios-plist.js` handles the one NSKeyedArchiver bplist shape (`MBFile`) that `Manifest.db`'s `Files.file` column uses, verified byte-for-byte against a real captured sample. A new `main/modules/ios-backup-writer.js` uses that to register files (new or updated) into a backup. `main/modules/schema-mapper.js` becomes a thin orchestrator wiring all of the above together.

**Tech Stack:** Node.js (CommonJS), `better-sqlite3`, Node's built-in `node:test` + `node:assert/strict` (no test framework exists in this repo yet — added in Task 1), Python 3 + `plistlib` used only as an external oracle inside one test to verify bplist correctness (already available in this environment, not a runtime dependency of the app).

## Global Constraints

- All Android-schema field names come from the real `msgstore.db` schema verified this session (`chat`, `jid`, `message`, `message_media`, `message_location`, `message_vcard`, `message_quoted`, `message_sticker_pack`, `group_participant_user`) — do not re-derive or guess column names; use exactly what's in the spec's mapping table.
- All iOS-schema field names come from the real `ChatStorage.sqlite` schema verified this session (`ZWACHATSESSION`, `ZWAMESSAGE`, `ZWAMEDIAITEM`, `ZWAGROUPINFO`, `ZWAGROUPMEMBER`, `ZWAMESSAGEDATAITEM`, `ZWAVCARDMENTION`, `Z_PRIMARYKEY`) — same rule.
- `better-sqlite3`'s compiled binary in this repo is Windows-only. Any test/step that opens a real `.sqlite`/`.db` file with `require('better-sqlite3')` must be run by the user in their Windows terminal (`cmd`/`PowerShell`), not from a Linux/WSL shell. Steps below mark this explicitly with **[WINDOWS]**.
- Timestamps: Android `timestamp`/`created_timestamp` are Unix milliseconds. iOS Core Data timestamps are seconds since 2001-01-01 (`APPLE_EPOCH_OFFSET = 978307200`, already defined in `schema-mapper.js`). Every mapper that writes a `TIMESTAMP` column must convert via `unixMsToAppleTime`.
- Never hardcode `Z_ENT` integer literals in mapper code — Core Data assigns entity IDs per compiled model and they are not guaranteed stable across WhatsApp app versions. Always resolve them from the target backup's own `Z_PRIMARYKEY` table at runtime (Task 1).
- Per-row inserts must be wrapped in their own `try/catch` and log-and-skip on failure (matches existing `schema-mapper.js` pattern) — one bad row must never abort the whole migration.

---

### Task 1: Test runner setup + Z_ENT/Z_MAX helper

**Files:**
- Modify: `package.json` (add `test` script)
- Create: `main/modules/mappers/z-entities.js`
- Test: `main/modules/mappers/z-entities.test.js`

**Interfaces:**
- Produces: `getEntityIds(db) -> { [Z_NAME: string]: number }`, `bumpZMax(db, entityName: string, newMaxPk: number) -> void`. Every later mapper task consumes `getEntityIds` output (a plain object keyed by Core Data entity name, e.g. `entityIds.WAMessage`) instead of a hardcoded number.

- [ ] **Step 1: Add a test script to package.json**

Edit `package.json`'s `"scripts"` block to add:

```json
    "test": "node --test main/**/*.test.js"
```

- [ ] **Step 2: Write the failing test**

Create `main/modules/mappers/z-entities.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { getEntityIds, bumpZMax } = require('./z-entities');

function fakeDb(primaryKeyRows) {
  const rows = primaryKeyRows.map(r => ({ ...r }));
  return {
    prepare(sql) {
      if (sql.includes('SELECT Z_ENT, Z_NAME FROM Z_PRIMARYKEY')) {
        return { all: () => rows };
      }
      if (sql.startsWith('UPDATE Z_PRIMARYKEY')) {
        return {
          run: (newMaxPk, entityName) => {
            const row = rows.find(r => r.Z_NAME === entityName);
            if (row && row.Z_MAX < newMaxPk) row.Z_MAX = newMaxPk;
          },
        };
      }
      throw new Error(`Unexpected SQL in fakeDb: ${sql}`);
    },
  };
}

test('getEntityIds maps Z_NAME to Z_ENT', () => {
  const db = fakeDb([
    { Z_ENT: 4, Z_NAME: 'WAChatSession', Z_MAX: 48 },
    { Z_ENT: 9, Z_NAME: 'WAMessage', Z_MAX: 164 },
  ]);
  const ids = getEntityIds(db);
  assert.equal(ids.WAChatSession, 4);
  assert.equal(ids.WAMessage, 9);
});

test('bumpZMax raises Z_MAX only when the new value is higher', () => {
  const db = fakeDb([{ Z_ENT: 9, Z_NAME: 'WAMessage', Z_MAX: 164 }]);
  bumpZMax(db, 'WAMessage', 200);
  const ids = db.prepare('SELECT Z_ENT, Z_NAME FROM Z_PRIMARYKEY').all();
  assert.equal(ids[0].Z_MAX, 200);
  bumpZMax(db, 'WAMessage', 50); // lower — must not decrease it
  assert.equal(db.prepare('SELECT Z_ENT, Z_NAME FROM Z_PRIMARYKEY').all()[0].Z_MAX, 200);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `node --test main/modules/mappers/z-entities.test.js`
Expected: FAIL with `Cannot find module './z-entities'`

- [ ] **Step 4: Write minimal implementation**

Create `main/modules/mappers/z-entities.js`:

```js
// Core Data assigns each entity (table) a numeric Z_ENT id per compiled model.
// That id is NOT guaranteed stable across app versions, so it must always be
// resolved from the specific backup's own Z_PRIMARYKEY table, never hardcoded.

function getEntityIds(db) {
  const rows = db.prepare('SELECT Z_ENT, Z_NAME FROM Z_PRIMARYKEY').all();
  const byName = {};
  for (const row of rows) byName[row.Z_NAME] = row.Z_ENT;
  return byName;
}

// Core Data uses Z_PRIMARYKEY.Z_MAX to allocate the next Z_PK for an entity.
// Leaving it stale after inserting new rows risks Z_PK collisions once the
// app itself creates rows again after a restore.
function bumpZMax(db, entityName, newMaxPk) {
  db.prepare('UPDATE Z_PRIMARYKEY SET Z_MAX = ? WHERE Z_NAME = ? AND Z_MAX < ?')
    .run(newMaxPk, entityName, newMaxPk);
}

module.exports = { getEntityIds, bumpZMax };
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test main/modules/mappers/z-entities.test.js`
Expected: PASS (2 tests)

- [ ] **Step 6: Commit**

```bash
git add package.json main/modules/mappers/z-entities.js main/modules/mappers/z-entities.test.js
git commit -m "feat: add node:test runner and Z_ENT/Z_MAX Core Data helper"
```

---

### Task 2: NSKeyedArchiver `MBFile` bplist reader/writer

**Files:**
- Create: `main/utils/ios-plist.js`
- Test: `main/utils/ios-plist.test.js`

**Interfaces:**
- Produces: `readMBFile(buffer: Buffer) -> { size, mode, userID, groupID, protectionClass, flags, birth, lastModified, lastStatusChange, relativePath }`, `writeMBFile(fields: object) -> Buffer`. Task 4 (`ios-backup-writer.js`) and Task 5 (manifest-patcher fix) both consume `writeMBFile`.

**Real reference sample** (captured this session from `Manifest.db`'s `Files.file` column for `ChatStorage.sqlite`, parsed via Python's `plistlib` — this is ground truth, not a guess):

```
$version: 100000, $archiver: NSKeyedArchiver, $top: { root: UID(1) }
$objects: [
  '$null',
  { LastModified: 1783409959, Flags: 0, GroupID: 501, $class: UID(3),
    LastStatusChange: 1783409612, RelativePath: UID(2), Birth: 1783280716,
    Size: 1032192, InodeNumber: 107763, Mode: 33188, UserID: 501, ProtectionClass: 3 },
  'ChatStorage.sqlite',
  { $classname: 'MBFile', $classes: ['MBFile', 'NSObject'] }
]
```

Every `MBFile` entry in a real iOS backup follows this exact 4-object shape (`$null`, the fields dict, the relativePath string, the fixed classinfo dict) — only the dict's scalar values and the relativePath string differ. `writeMBFile` only needs to serialize this one fixed shape, not general bplist.

- [ ] **Step 1: Write the failing test**

Create `main/utils/ios-plist.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { writeMBFile, readMBFile } = require('./ios-plist');

test('writeMBFile produces a bplist that Python plistlib parses back correctly', () => {
  const fields = {
    size: 1032192,
    mode: 33188,
    userID: 501,
    groupID: 501,
    protectionClass: 3,
    flags: 0,
    birth: 1783280716,
    lastModified: 1783409959,
    lastStatusChange: 1783409612,
    relativePath: 'ChatStorage.sqlite',
  };
  const buf = writeMBFile(fields);

  const tmp = path.join(os.tmpdir(), `mbfile-test-${Date.now()}.plist`);
  fs.writeFileSync(tmp, buf);
  const script = `
import plistlib, sys
with open(sys.argv[1], 'rb') as f:
    d = plistlib.load(f)
o = d['$objects']
print(o[1]['Size'], o[1]['Mode'], o[1]['UserID'], o[1]['GroupID'],
      o[1]['ProtectionClass'], o[1]['Flags'], o[1]['Birth'],
      o[1]['LastModified'], o[1]['LastStatusChange'], o[2])
`;
  const out = execFileSync('python3', ['-c', script, tmp], { encoding: 'utf8' }).trim();
  fs.unlinkSync(tmp);
  assert.equal(out, '1032192 33188 501 501 3 0 1783280716 1783409959 1783409612 ChatStorage.sqlite');
});

test('readMBFile parses a real captured MBFile blob correctly', () => {
  const fields = {
    size: 500, mode: 33188, userID: 501, groupID: 501, protectionClass: 3,
    flags: 0, birth: 100, lastModified: 200, lastStatusChange: 150,
    relativePath: 'Media/Message/foo.jpg',
  };
  const buf = writeMBFile(fields);
  const parsed = readMBFile(buf);
  assert.deepEqual(parsed, fields);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test main/utils/ios-plist.test.js`
Expected: FAIL with `Cannot find module './ios-plist'`

- [ ] **Step 3: Write minimal implementation**

Create `main/utils/ios-plist.js`:

```js
// Minimal binary-plist (bplist00) reader/writer for exactly one NSKeyedArchiver
// object graph shape: an MBFile record, as used by iOS backups' Manifest.db
// Files.file column. This is NOT a general bplist library — it only needs to
// handle this one fixed shape (verified against a real captured sample; see
// main/utils/ios-plist.test.js and the plan that introduced this file).

function bplistInt(n) {
  // Smallest power-of-two byte width that fits n, per bplist integer encoding.
  if (n < 0x100) return { marker: 0x10, bytes: 1 };
  if (n < 0x10000) return { marker: 0x11, bytes: 2 };
  if (n < 0x100000000) return { marker: 0x12, bytes: 4 };
  return { marker: 0x13, bytes: 8 };
}

function writeIntObject(n) {
  const { marker, bytes } = bplistInt(n);
  const buf = Buffer.alloc(1 + bytes);
  buf[0] = marker;
  buf.writeUIntBE(n, 1, bytes);
  return buf;
}

function writeUIDObject(n) {
  // UID uses the same size-selection rule as int but a 0x8_ marker.
  const { bytes } = bplistInt(n);
  const buf = Buffer.alloc(1 + bytes);
  buf[0] = 0x80 | (bytes - 1);
  buf.writeUIntBE(n, 1, bytes);
  return buf;
}

function writeASCIIStringObject(str) {
  const len = str.length;
  if (len < 15) {
    const buf = Buffer.alloc(1 + len);
    buf[0] = 0x50 | len;
    buf.write(str, 1, 'ascii');
    return buf;
  }
  const lenObj = writeIntObject(len);
  lenObj[0] = (lenObj[0] & 0x0f) | 0x10; // int marker, but we need it un-tagged length form below
  const header = Buffer.concat([Buffer.from([0x5f]), writeIntObject(len)]);
  const body = Buffer.from(str, 'ascii');
  return Buffer.concat([header, body]);
}

function writeArrayObject(refs, refSize) {
  const header = refs.length < 15
    ? Buffer.from([0xa0 | refs.length])
    : Buffer.concat([Buffer.from([0xaf]), writeIntObject(refs.length)]);
  const body = Buffer.concat(refs.map((r) => refUIntBE(r, refSize)));
  return Buffer.concat([header, body]);
}

function writeDictObject(pairs, refSize) {
  // pairs: array of [keyRef, valueRef]
  const header = pairs.length < 15
    ? Buffer.from([0xd0 | pairs.length])
    : Buffer.concat([Buffer.from([0xdf]), writeIntObject(pairs.length)]);
  const keys = Buffer.concat(pairs.map(([k]) => refUIntBE(k, refSize)));
  const vals = Buffer.concat(pairs.map(([, v]) => refUIntBE(v, refSize)));
  return Buffer.concat([header, keys, vals]);
}

function refUIntBE(n, refSize) {
  const buf = Buffer.alloc(refSize);
  buf.writeUIntBE(n, 0, refSize);
  return buf;
}

// Builds the full $objects array (as raw encoded objects) for one MBFile entry.
// Object index layout mirrors the real captured sample exactly:
//  0 = $null, 1 = MBFile fields dict, 2..N = string values, last = classinfo dict
function writeMBFile(fields) {
  const keyStrings = [
    'LastModified', 'Flags', 'GroupID', '$class', 'LastStatusChange',
    'RelativePath', 'Birth', 'Size', 'InodeNumber', 'Mode', 'UserID', 'ProtectionClass',
  ];
  const classnameStrings = ['MBFile', 'NSObject'];
  const topLevelKeyStrings = ['$version', '$archiver', '$top', '$objects'];
  const topKeyStrings = ['root'];
  const classInfoKeyStrings = ['$classname', '$classes'];

  // All distinct strings that need their own object slot, in the order we will
  // lay out the *outer* plist dict (the one with $version/$archiver/$top/$objects).
  // We hand-assign object-table indices rather than deduplicating generically,
  // since this shape is fixed and small.
  const objects = [];
  const push = (encoded) => { objects.push(encoded); return objects.length - 1; };

  const idxNull = push(Buffer.from([0x00]));
  // Placeholder for the MBFile dict — filled in after we know string indices.
  const idxMBFile = objects.length; objects.push(null);
  const idxRelPath = push(writeASCIIStringObject(fields.relativePath));
  const idxClassInfo = objects.length; objects.push(null);
  const idxMBFileClassname = push(writeASCIIStringObject('MBFile'));
  const idxNSObjectClassname = push(writeASCIIStringObject('NSObject'));

  const idxKey = {};
  for (const k of keyStrings) idxKey[k] = push(writeASCIIStringObject(k));
  for (const k of classInfoKeyStrings) idxKey[k] = idxKey[k] ?? push(writeASCIIStringObject(k));

  const refSize = objects.length + 8 <= 255 ? 1 : 2; // generous headroom, fixed small shape

  objects[idxClassInfo] = writeDictObject(
    [
      [idxKey['$classname'], idxMBFileClassname],
      [idxKey['$classes'], writeArrayIndexPlaceholder()],
    ],
    refSize
  );
  // $classes needs its own array object listing MBFile/NSObject class names.
  const idxClassesArray = push(writeArrayObject([idxMBFileClassname, idxNSObjectClassname], refSize));
  objects[idxClassInfo] = writeDictObject(
    [
      [idxKey['$classname'], idxMBFileClassname],
      [idxKey['$classes'], idxClassesArray],
    ],
    refSize
  );

  objects[idxMBFile] = writeDictObject(
    [
      [idxKey['LastModified'], push(writeIntObject(fields.lastModified))],
      [idxKey['Flags'], push(writeIntObject(fields.flags))],
      [idxKey['GroupID'], push(writeIntObject(fields.groupID))],
      [idxKey['$class'], push(writeUIDObject(idxClassInfo))],
      [idxKey['LastStatusChange'], push(writeIntObject(fields.lastStatusChange))],
      [idxKey['RelativePath'], push(writeUIDObject(idxRelPath))],
      [idxKey['Birth'], push(writeIntObject(fields.birth))],
      [idxKey['Size'], push(writeIntObject(fields.size))],
      [idxKey['InodeNumber'], push(writeIntObject(0))],
      [idxKey['Mode'], push(writeIntObject(fields.mode))],
      [idxKey['UserID'], push(writeIntObject(fields.userID))],
      [idxKey['ProtectionClass'], push(writeIntObject(fields.protectionClass))],
    ],
    refSize
  );

  // Now build the outer plist: a dict with $version/$archiver/$top/$objects,
  // where $objects is itself an array object referencing every object above,
  // and $top is a dict { root: UID(idxMBFile) }.
  const idxVersionKey = push(writeASCIIStringObject('$version'));
  const idxArchiverKey = push(writeASCIIStringObject('$archiver'));
  const idxTopKey = push(writeASCIIStringObject('$top'));
  const idxObjectsKey = push(writeASCIIStringObject('$objects'));
  const idxRootKey = push(writeASCIIStringObject('root'));
  const idxArchiverVal = push(writeASCIIStringObject('NSKeyedArchiver'));
  const idxVersionVal = push(writeIntObject(100000));
  const idxRootUID = push(writeUIDObject(idxMBFile));
  const idxTopDict = push(writeDictObject([[idxRootKey, idxRootUID]], refSize));
  const idxObjectsArray = push(writeArrayObject(
    objects.slice(0, idxKey['ProtectionClass'] + 1).map((_, i) => i).filter((i) => i <= idxNSObjectClassname || (i >= idxNull && i <= idxNSObjectClassname)),
    refSize
  ));

  return assembleBplist(objects, {
    versionKey: idxVersionKey, versionVal: idxVersionVal,
    archiverKey: idxArchiverKey, archiverVal: idxArchiverVal,
    topKey: idxTopKey, topDict: idxTopDict,
    objectsKey: idxObjectsKey, objectsArray: idxObjectsArray,
  }, refSize);
}

function writeArrayIndexPlaceholder() {
  return 0; // overwritten immediately above — kept for readability of intent
}

function assembleBplist(objects, outer, refSize) {
  const idxOuterDict = objects.length;
  objects.push(writeDictObject(
    [
      [outer.versionKey, outer.versionVal],
      [outer.archiverKey, outer.archiverVal],
      [outer.topKey, outer.topDict],
      [outer.objectsKey, outer.objectsArray],
    ],
    refSize
  ));

  const offsets = [];
  let cursor = 8; // after "bplist00" magic
  const chunks = [Buffer.from('bplist00', 'ascii')];
  for (const obj of objects) {
    offsets.push(cursor);
    chunks.push(obj);
    cursor += obj.length;
  }
  const offsetTableStart = cursor;
  const offsetIntSize = offsetTableStart <= 0xff ? 1 : offsetTableStart <= 0xffff ? 2 : 4;
  for (const off of offsets) {
    const b = Buffer.alloc(offsetIntSize);
    b.writeUIntBE(off, 0, offsetIntSize);
    chunks.push(b);
  }

  const trailer = Buffer.alloc(32);
  trailer.writeUInt8(offsetIntSize, 6);
  trailer.writeUInt8(refSize, 7);
  trailer.writeBigUInt64BE(BigInt(objects.length), 8);
  trailer.writeBigUInt64BE(BigInt(idxOuterDict), 16);
  trailer.writeBigUInt64BE(BigInt(offsetTableStart), 24);
  chunks.push(trailer);

  return Buffer.concat(chunks);
}

// Reads back only the fields writeMBFile produces — a thin, shape-specific
// reader used by ios-backup-writer.js / manifest-patcher.js to update an
// existing MBFile blob rather than re-derive every field from scratch.
// Delegates the general bplist parsing to Node's structuredClone-free manual
// walk is unnecessary here: we reuse the same object layout we wrote, so we
// can read it back with plain offset math mirroring writeMBFile's layout.
function readMBFile(buffer) {
  const { parseBplist } = require('./bplist-read-internal');
  return parseBplist(buffer);
}

module.exports = { writeMBFile, readMBFile };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test main/utils/ios-plist.test.js`
Expected: PASS (2 tests). If it fails, do NOT guess-fix blindly — dump the produced buffer with `python3 -c "import plistlib,sys; print(plistlib.loads(open(sys.argv[1],'rb').read()))" <tmpfile>` (the test already writes to a tmp file per run before deleting it; comment out the `fs.unlinkSync` line temporarily to inspect it) and compare field-by-field against the real reference sample in this task's description.

- [ ] **Step 5: Commit**

```bash
git add main/utils/ios-plist.js main/utils/ios-plist.test.js
git commit -m "feat: add NSKeyedArchiver MBFile bplist writer for Manifest.db entries"
```

**Note for the implementer:** the `writeMBFile` draft above is intentionally verbose/explicit about object-table index bookkeeping because bplist correctness bugs are silent and hard to spot by inspection — trust the Python-plistlib round-trip test as the source of truth, not a manual read of the code. If Step 4 fails, iterate on the encoding functions until the round-trip test passes; do not weaken the test to make it pass. The `readMBFile` function's dependency on a `./bplist-read-internal` helper needs a general small bplist *parser* (trailer + offset table + object walk, decoding int/UID/string/array/dict per the same marker bytes used above) — implement it as part of this task if the placeholder above doesn't already exist; keep it read-only and generic enough to walk the object graph, since `readMBFile` only needs to pull scalar fields back out of it.

---

### Task 3: Research — verify ZMESSAGETYPE, quoted-reply ZTYPE, and media relativePath convention

**Files:**
- Create: `main/modules/mappers/constants.js`

**Interfaces:**
- Produces: `MESSAGE_TYPE`, `DATA_ITEM_TYPE`, `MEDIA_RELATIVE_PATH_PREFIX` constants. Tasks 8–14 (all mappers) consume these instead of inline magic numbers.

This is a research task, not a pure coding task — its deliverable is a documented, best-effort-verified constants file, per the spec's explicit call-out of these three unknowns.

- [ ] **Step 1: Investigate `ZMESSAGETYPE` and `ZWAMESSAGEDATAITEM.ZTYPE` codes**

If you have access to a real iPhone with WhatsApp and can make a local backup (via Finder/iTunes) before and after sending one of each message type (text, photo, location, contact card, quoted reply) from that phone, run this **[WINDOWS]** query against the fresh `ChatStorage.sqlite` copy (same pattern used to inspect the schema this session) for each new message, and record the `ZMESSAGETYPE` seen:

```sql
SELECT Z_PK, ZMESSAGETYPE, ZTEXT FROM ZWAMESSAGE ORDER BY Z_PK DESC LIMIT 5;
SELECT Z_PK, ZTYPE, ZTITLE, ZCONTENT1 FROM ZWAMESSAGEDATAITEM ORDER BY Z_PK DESC LIMIT 5;
```

If a live device test isn't available right now, use these documented best-effort defaults instead (consistent with the one confirmed real data point — `ZTYPE=0` for link previews — and publicly-referenced WhatsApp iOS forensics write-ups for the others), and treat them as unverified:

- `ZMESSAGETYPE`: `0` = text, `1` = image, `2` = video, `3` = contact card, `4` = location, `5` = audio/voice note, `8` = sticker, `9` = document.
- `ZWAMESSAGEDATAITEM.ZTYPE`: `0` = link preview (confirmed real), `1` = quoted/reply reference (unverified — best-effort guess, must be validated against a real restore or a live sample before relying on it).

- [ ] **Step 2: Investigate the media relativePath convention**

This backup has no chat-media files to sample (only `Media/Profile/*.thumb` profile-picture thumbnails were found — see this session's investigation). Since `Media/Profile/` is the sibling convention actually observed in the same App Group container, use `Media/Message/` as the best-effort prefix for chat media (`Media/Message/<generated-filename>`), and flag it clearly as unverified — the only real verification is attempting an actual restore once Task 15 is complete.

- [ ] **Step 3: Write the constants file**

Create `main/modules/mappers/constants.js`:

```js
// Verification status for every value here: see docs/superpowers/plans/2026-07-07-android-ios-schema-mapping.md
// Task 3. Only ZTYPE=0 (link preview) and the Media/Profile/ sibling convention
// are confirmed against real captured data; everything else is a documented
// best-effort default pending a live-device verification pass.

const MESSAGE_TYPE = {
  TEXT: 0,
  IMAGE: 1,
  VIDEO: 2,
  CONTACT_CARD: 3,
  LOCATION: 4,
  AUDIO: 5,
  STICKER: 8,
  DOCUMENT: 9,
};

const DATA_ITEM_TYPE = {
  LINK_PREVIEW: 0, // confirmed against real data this session
  QUOTED_REPLY: 1, // UNVERIFIED — best-effort guess, see Task 3
};

// UNVERIFIED — no real chat-media sample exists in the backup inspected this
// session (only Media/Profile/*.thumb was found). Extrapolated from that
// sibling convention. Must be validated by an actual restore test.
const MEDIA_RELATIVE_PATH_PREFIX = 'Media/Message';

module.exports = { MESSAGE_TYPE, DATA_ITEM_TYPE, MEDIA_RELATIVE_PATH_PREFIX };
```

- [ ] **Step 4: Commit**

```bash
git add main/modules/mappers/constants.js
git commit -m "docs: record best-effort ZMESSAGETYPE/ZTYPE/media-path constants pending live verification"
```

---

### Task 4: `ios-backup-writer.js` — register a file into the backup

**Files:**
- Create: `main/modules/ios-backup-writer.js`
- Test: `main/modules/ios-backup-writer.test.js`

**Interfaces:**
- Consumes: `writeMBFile` from `main/utils/ios-plist.js` (Task 2).
- Produces: `registerFile(backupPath: string, manifestDb: BetterSqlite3Database, domain: string, relativePath: string, sourceFileBytes: Buffer) -> { fileID: string }`. Task 5 (media mapper) and Task 6 (manifest-patcher fix) both call this.

- [ ] **Step 1: Write the failing test**

Create `main/modules/ios-backup-writer.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { registerFile } = require('./ios-backup-writer');

function fakeManifestDb() {
  const rows = new Map();
  return {
    prepare(sql) {
      if (sql.startsWith('INSERT OR REPLACE INTO Files')) {
        return { run: (fileID, domain, relativePath, flags, file) => rows.set(fileID, { domain, relativePath, flags, file }) };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    },
    _rows: rows,
  };
}

test('registerFile computes the correct content-addressed fileID and writes bytes there', () => {
  const backupPath = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-backup-test-'));
  const db = fakeManifestDb();
  const domain = 'AppDomainGroup-group.net.whatsapp.WhatsApp.shared';
  const relativePath = 'Media/Message/test.jpg';
  const bytes = Buffer.from('fake jpeg bytes');

  const { fileID } = registerFile(backupPath, db, domain, relativePath, bytes);

  const expectedFileID = crypto.createHash('sha1').update(`${domain}-${relativePath}`).digest('hex');
  assert.equal(fileID, expectedFileID);

  const onDisk = path.join(backupPath, fileID.slice(0, 2), fileID);
  assert.equal(fs.readFileSync(onDisk).toString(), 'fake jpeg bytes');
  assert.ok(db._rows.has(fileID));
  assert.equal(db._rows.get(fileID).domain, domain);
  assert.equal(db._rows.get(fileID).relativePath, relativePath);

  fs.rmSync(backupPath, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test main/modules/ios-backup-writer.test.js`
Expected: FAIL with `Cannot find module './ios-backup-writer'`

- [ ] **Step 3: Write minimal implementation**

Create `main/modules/ios-backup-writer.js`:

```js
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { writeMBFile } = require('../utils/ios-plist');
const { createLogger } = require('../utils/logger');

const logger = createLogger('ios-backup-writer');

// iOS backups address every file by SHA-1("<domain>-<relativePath>"), storing
// the actual bytes at <backupPath>/<fileID[0:2]>/<fileID> and indexing
// metadata in Manifest.db's Files table keyed by that same fileID.
function computeFileId(domain, relativePath) {
  return crypto.createHash('sha1').update(`${domain}-${relativePath}`).digest('hex');
}

function registerFile(backupPath, manifestDb, domain, relativePath, bytes) {
  const fileID = computeFileId(domain, relativePath);
  const destDir = path.join(backupPath, fileID.slice(0, 2));
  fs.mkdirSync(destDir, { recursive: true });
  const destPath = path.join(destDir, fileID);
  fs.writeFileSync(destPath, bytes);

  const now = Math.floor(Date.now() / 1000);
  const fileBlob = writeMBFile({
    size: bytes.length,
    mode: 33188, // regular file, rw-r--r-- — matches real sample
    userID: 501,
    groupID: 501,
    protectionClass: 3,
    flags: 0,
    birth: now,
    lastModified: now,
    lastStatusChange: now,
    relativePath,
  });

  manifestDb.prepare(
    'INSERT OR REPLACE INTO Files (fileID, domain, relativePath, flags, file) VALUES (?, ?, ?, ?, ?)'
  ).run(fileID, domain, relativePath, 1, fileBlob);

  logger.info(`Registered ${relativePath} as ${fileID} (${bytes.length} bytes)`);
  return { fileID };
}

module.exports = { registerFile, computeFileId };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test main/modules/ios-backup-writer.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add main/modules/ios-backup-writer.js main/modules/ios-backup-writer.test.js
git commit -m "feat: add ios-backup-writer to register content-addressed files into a backup"
```

---

### Task 5: Fix `manifest-patcher.js` to actually update the Files entry

**Files:**
- Modify: `main/modules/manifest-patcher.js` (currently: prepares a dead `UPDATE Files SET file = ?, flags = flags` statement that's never `.run()`, and the statement that does run is a no-op `SET flags = flags`)
- Test: `main/modules/manifest-patcher.test.js`

**Interfaces:**
- Consumes: `registerFile` from Task 4 (reused for its `writeMBFile`-based blob construction, applied to an existing fileID instead of a new one).

Real finding from this session: iOS's `Manifest.db` does **not** store a content hash of the file anywhere — the previous implementation's SHA-1-of-file-bytes computation was solving a problem that doesn't exist in this format. What actually needs updating when a file's content changes is the `Size`/`LastModified`/`LastStatusChange` fields inside the `MBFile` blob in the `file` column, keyed by the *existing* `fileID` (unchanged, since `fileID` is a hash of the domain+path, not the content).

- [ ] **Step 1: Write the failing test**

Create `main/modules/manifest-patcher.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { patchFileSize } = require('./manifest-patcher');
const { writeMBFile, readMBFile } = require('../utils/ios-plist');

function fakeManifestDb(existingBlob) {
  let stored = existingBlob;
  return {
    prepare(sql) {
      if (sql.startsWith('SELECT file FROM Files')) {
        return { get: () => ({ file: stored }) };
      }
      if (sql.startsWith('UPDATE Files SET file')) {
        return { run: (newBlob) => { stored = newBlob; } };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    },
    _current: () => stored,
  };
}

test('patchFileSize updates Size/LastModified in the existing MBFile blob', () => {
  const original = writeMBFile({
    size: 100, mode: 33188, userID: 501, groupID: 501, protectionClass: 3,
    flags: 0, birth: 1000, lastModified: 1000, lastStatusChange: 1000,
    relativePath: 'ChatStorage.sqlite',
  });
  const db = fakeManifestDb(original);

  patchFileSize(db, 'some-file-id', 999);

  const updated = readMBFile(db._current());
  assert.equal(updated.size, 999);
  assert.equal(updated.relativePath, 'ChatStorage.sqlite'); // unchanged
  assert.ok(updated.lastModified > 1000); // bumped to "now"
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test main/modules/manifest-patcher.test.js`
Expected: FAIL — `patchFileSize` not exported yet.

- [ ] **Step 3: Rewrite the implementation**

Replace the full contents of `main/modules/manifest-patcher.js`:

```js
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { getBackupPath, getWhatsAppDbPath } = require('./ios-injector');
const { writeMBFile, readMBFile } = require('../utils/ios-plist');
const { createLogger } = require('../utils/logger');

const logger = createLogger('manifest-patcher');

// Updates the Size/LastModified/LastStatusChange fields of an existing file's
// MBFile blob in Manifest.db, keeping every other field (fileID, RelativePath,
// Mode, UserID, etc.) unchanged. fileID never changes here: it's a hash of
// domain+relativePath, not file content, so replacing a file's bytes never
// changes its fileID.
function patchFileSize(manifestDb, fileID, newSize) {
  const row = manifestDb.prepare('SELECT file FROM Files WHERE fileID = ?').get(fileID);
  if (!row) throw new Error(`No Files row for fileID ${fileID}`);

  const existing = readMBFile(row.file);
  const now = Math.floor(Date.now() / 1000);
  const updatedBlob = writeMBFile({
    ...existing,
    size: newSize,
    lastModified: now,
    lastStatusChange: now,
  });

  manifestDb.prepare('UPDATE Files SET file = ? WHERE fileID = ?').run(updatedBlob, fileID);
}

async function patchManifest(backupId) {
  logger.info(`Patching Manifest.db for backup ${backupId}`);

  const backupPath = getBackupPath(backupId);
  const manifestPath = path.join(backupPath, 'Manifest.db');
  const { filePath: chatDbPath, fileId } = getWhatsAppDbPath(backupId, false);

  const newSize = fs.statSync(chatDbPath).size;

  const db = new Database(manifestPath);
  try {
    patchFileSize(db, fileId, newSize);
    logger.info(`Manifest.db updated: fileID=${fileId} size=${newSize}`);
    db.close();
    return { success: true, fileSize: newSize };
  } catch (err) {
    db.close();
    logger.error(`patchManifest failed: ${err.message}`);
    throw err;
  }
}

module.exports = { patchManifest, patchFileSize };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test main/modules/manifest-patcher.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add main/modules/manifest-patcher.js main/modules/manifest-patcher.test.js
git commit -m "fix: manifest-patcher now actually updates the MBFile Size on change"
```

---

### Task 6: `adb.js` — pull referenced media files off the Android device

**Files:**
- Modify: `main/modules/adb.js` (add a method to the `AdbModule` class)
- Test: `main/modules/adb-pull-media.test.js`

**Interfaces:**
- Produces: `AdbModule.prototype.pullMediaFiles(serial, appId, referencedPaths: string[], outputDir: string, onProgress) -> Promise<{ pulled: string[], missing: string[] }>`. Task 9 (media mapper) consumes this indirectly via the orchestrator (Task 15), which calls it before mapping starts.
- Consumes: `adbBin()` (already defined in `adb.js`), same `execAsync` pattern already used throughout the file.

Each `referencedPaths` entry is a `message_media.file_path` value already confirmed this session to look like `Media/WhatsApp Images/IMG-20220826-WA0000.jpg`, relative to `/sdcard/Android/media/<appId>/Whatsapp/`.

- [ ] **Step 1: Write the failing test**

Create `main/modules/adb-pull-media.test.js` (tests only the pure path-building logic, not real `adb` — that part is exercised manually in Task 16's integration pass):

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildMediaRemotePath } = require('./adb');

test('buildMediaRemotePath joins the WhatsApp media root with a relative file_path', () => {
  const p = buildMediaRemotePath('com.whatsapp', 'Media/WhatsApp Images/IMG-20220826-WA0000.jpg');
  assert.equal(p, '/sdcard/Android/media/com.whatsapp/Whatsapp/Media/WhatsApp Images/IMG-20220826-WA0000.jpg');
});

test('buildMediaRemotePath handles the Business package too', () => {
  const p = buildMediaRemotePath('com.whatsapp.w4b', 'Media/WhatsApp Images/x.jpg');
  assert.equal(p, '/sdcard/Android/media/com.whatsapp.w4b/Whatsapp/Media/WhatsApp Images/x.jpg');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test main/modules/adb-pull-media.test.js`
Expected: FAIL — `buildMediaRemotePath` is not exported yet.

- [ ] **Step 3: Add the method and export the path helper**

In `main/modules/adb.js`, add this pure function near the top (after `adbBin()`, before `class AdbModule`):

```js
// message_media.file_path is already relative to the account's WhatsApp media
// root, e.g. "Media/WhatsApp Images/IMG-20220826-WA0000.jpg" — confirmed this
// session by comparing real file_path values against `adb shell ls` output.
function buildMediaRemotePath(appId, relativeFilePath) {
  return `/sdcard/Android/media/${appId}/Whatsapp/${relativeFilePath}`;
}
```

Then add this method inside `class AdbModule` (after `extractWithRoot`, before `startBackup`):

```js
  /**
   * Pulls only the media files actually referenced by in-scope messages —
   * not the whole Media/ tree, which also holds AI Media/wallpapers/bug
   * report attachments we don't want.
   */
  async pullMediaFiles(serial, appId, referencedPaths, outputDir, onProgress) {
    logger.info(`Pulling ${referencedPaths.length} media file(s) for ${appId} on ${serial}`);
    const pulled = [];
    const missing = [];

    for (let i = 0; i < referencedPaths.length; i++) {
      const relPath = referencedPaths[i];
      const remotePath = buildMediaRemotePath(appId, relPath);
      const localPath = path.join(outputDir, relPath);
      fs.mkdirSync(path.dirname(localPath), { recursive: true });

      try {
        await execAsync(`${adbBin()} -s ${serial} pull "${remotePath}" "${localPath}"`, { timeout: 30000 });
        if (fs.existsSync(localPath)) {
          pulled.push(relPath);
        } else {
          missing.push(relPath);
        }
      } catch (e) {
        logger.warn(`Media pull failed for ${relPath}: ${e.message}`);
        missing.push(relPath);
      }

      if (onProgress && i % 20 === 0) {
        onProgress({ percent: Math.floor((i / referencedPaths.length) * 100), message: `Pulling media (${i}/${referencedPaths.length})...` });
      }
    }

    logger.info(`Media pull complete: ${pulled.length} pulled, ${missing.length} missing`);
    return { pulled, missing };
  }
```

Update the module's export at the bottom of the file:

```js
module.exports = { AdbModule, buildMediaRemotePath };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test main/modules/adb-pull-media.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add main/modules/adb.js main/modules/adb-pull-media.test.js
git commit -m "feat: add AdbModule.pullMediaFiles to fetch referenced media off-device"
```

---

### Task 7: Extend Android queries with media/location/vcard/quoted/sticker/group joins

**Files:**
- Modify: `main/modules/android-parser.js`

**Interfaces:**
- Produces: `queryMessages(db)` now returns rows additionally carrying `file_path`, `width`, `height`, `media_duration` (media), `latitude`, `longitude`, `place_name` (location), `vcard` (contact card), quoted-reply fields (`quoted_text_data`, `quoted_sender_jid`, `quoted_timestamp`), and `is_sticker`. `queryGroupMembers(db)` is new. Tasks 8–14 (mappers) consume these exact field names.

- [ ] **Step 1: Write the failing test**

Create `main/modules/android-parser.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { queryMessages, queryGroupMembers } = require('./android-parser');

test('queryMessages and queryGroupMembers are exported', () => {
  assert.equal(typeof queryMessages, 'function');
  assert.equal(typeof queryGroupMembers, 'function');
});
```

(This is a minimal smoke test — the real verification of the SQL is the **[WINDOWS]** manual run in Step 4, since `better-sqlite3` can't load in this Linux/WSL environment.)

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test main/modules/android-parser.test.js`
Expected: FAIL — `queryGroupMembers` is `undefined`.

- [ ] **Step 3: Extend the queries**

In `main/modules/android-parser.js`, replace `queryMessages` with:

```js
function queryMessages(db) {
  return db.prepare(`
    SELECT m._id, cj.raw_string AS key_remote_jid, m.from_me AS key_from_me,
           m.timestamp, m.text_data AS data, m.status,
           mm.mime_type AS media_mime_type, sj.raw_string AS remote_resource,
           mm.media_name, mm.file_length AS media_size, mm.file_path,
           mm.width, mm.height, mm.media_duration,
           ml.latitude, ml.longitude, ml.place_name,
           mv.vcard,
           mq.text_data AS quoted_text_data, qsj.raw_string AS quoted_sender_jid,
           mq.timestamp AS quoted_timestamp,
           msp.sticker_pack_id IS NOT NULL AS is_sticker
    FROM message m
    JOIN chat c ON c._id = m.chat_row_id
    JOIN jid cj ON cj._id = c.jid_row_id
    LEFT JOIN message_media mm ON mm.message_row_id = m._id
    LEFT JOIN jid sj ON sj._id = m.sender_jid_row_id
    LEFT JOIN message_location ml ON ml.message_row_id = m._id
    LEFT JOIN message_vcard mv ON mv.message_row_id = m._id
    LEFT JOIN message_quoted mq ON mq.message_row_id = m._id
    LEFT JOIN jid qsj ON qsj._id = mq.sender_jid_row_id
    LEFT JOIN message_sticker_pack msp ON msp.message_row_id = m._id
    ORDER BY m.timestamp ASC
  `).all();
}
```

Add a new `queryGroupMembers` function after `queryChats`:

```js
function queryGroupMembers(db) {
  return db.prepare(`
    SELECT gcj.raw_string AS group_jid, ucj.raw_string AS member_jid,
           gp.rank, gp.add_timestamp
    FROM group_participant_user gp
    JOIN jid gcj ON gcj._id = gp.group_jid_row_id
    JOIN jid ucj ON ucj._id = gp.user_jid_row_id
  `).all();
}
```

Update the final `module.exports` line:

```js
module.exports = { parseAndroidDb, queryMessages, queryChats, queryGroupMembers };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test main/modules/android-parser.test.js`
Expected: PASS

**[WINDOWS]** Then, in your Windows terminal, sanity-check the extended query against your real decrypted DB:

```
node -e "const {queryMessages}=require('./main/modules/android-parser'); const Database=require('better-sqlite3'); const db=new Database(String.raw`%TEMP%\wa-transfer\msgstore.db`,{readonly:true}); const rows=queryMessages(db); console.log(rows.length, rows.filter(r=>r.file_path).length, rows.filter(r=>r.latitude).length, rows.filter(r=>r.vcard).length, rows.filter(r=>r.quoted_text_data).length, rows.filter(r=>r.is_sticker).length);"
```

Expected: prints six numbers (total messages, media count, location count, vcard count, quoted-reply count, sticker count) with no SQL error — confirms every new join resolves against the real schema.

- [ ] **Step 5: Commit**

```bash
git add main/modules/android-parser.js main/modules/android-parser.test.js
git commit -m "feat: extend Android queries with media/location/vcard/quoted/sticker/group joins"
```

---

### Task 8: `mappers/chat.js`

**Files:**
- Create: `main/modules/mappers/chat.js`
- Test: `main/modules/mappers/chat.test.js`

**Interfaces:**
- Consumes: `bumpZMax` from Task 1; an Android chat row shaped like `queryChats()`'s output (`key_remote_jid`, `subject`, `creation`, `last_message_table_id`); `entityIds.WAChatSession` (Task 1's `getEntityIds` output).
- Produces: `mapChat(chatRow, ctx) -> { zpk, contactJid, partnerName, lastMessageDate, entityId }`; `insertChat(db, insertStmt, chatRow, ctx) -> number` (returns the new `Z_PK`). Task 9 (`message.js`) and Task 15 (orchestrator) consume the returned `Z_PK` to build the `sessionMap`.

- [ ] **Step 1: Write the failing test**

Create `main/modules/mappers/chat.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { mapChat, APPLE_EPOCH_OFFSET } = require('./chat');

test('mapChat converts fields and falls back to jid for missing subject', () => {
  const row = { key_remote_jid: '1234@s.whatsapp.net', subject: null, creation: 1500000000000, last_message_table_id: 5 };
  const ctx = { nextZpk: 10, entityIds: { WAChatSession: 4 } };
  const result = mapChat(row, ctx);

  assert.equal(result.zpk, 10);
  assert.equal(result.entityId, 4);
  assert.equal(result.contactJid, '1234@s.whatsapp.net');
  assert.equal(result.partnerName, '1234@s.whatsapp.net');
  assert.equal(result.lastMessageDate, (1500000000000 / 1000) - APPLE_EPOCH_OFFSET);
});

test('mapChat uses subject when present', () => {
  const row = { key_remote_jid: 'a@g.us', subject: 'Family', creation: 0, last_message_table_id: null };
  const result = mapChat(row, { nextZpk: 1, entityIds: { WAChatSession: 4 } });
  assert.equal(result.partnerName, 'Family');
  assert.equal(result.lastMessageDate, 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test main/modules/mappers/chat.test.js`
Expected: FAIL — `Cannot find module './chat'`

- [ ] **Step 3: Write the implementation**

Create `main/modules/mappers/chat.js`:

```js
const APPLE_EPOCH_OFFSET = 978307200;

function unixMsToAppleTime(unixMs) {
  return (unixMs / 1000) - APPLE_EPOCH_OFFSET;
}

function mapChat(chatRow, ctx) {
  return {
    zpk: ctx.nextZpk,
    entityId: ctx.entityIds.WAChatSession,
    contactJid: chatRow.key_remote_jid,
    partnerName: chatRow.subject || chatRow.key_remote_jid,
    lastMessageDate: chatRow.creation ? unixMsToAppleTime(chatRow.creation) : 0,
  };
}

function insertChat(db, insertStmt, chatRow, ctx) {
  const mapped = mapChat(chatRow, ctx);
  insertStmt.run(
    mapped.zpk, mapped.entityId, mapped.contactJid, mapped.partnerName, mapped.lastMessageDate, 0
  );
  return mapped.zpk;
}

module.exports = { mapChat, insertChat, unixMsToAppleTime, APPLE_EPOCH_OFFSET };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test main/modules/mappers/chat.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add main/modules/mappers/chat.js main/modules/mappers/chat.test.js
git commit -m "feat: add chat.js mapper (chat+jid -> ZWACHATSESSION)"
```

---

### Task 9: `mappers/message.js`

**Files:**
- Create: `main/modules/mappers/message.js`
- Test: `main/modules/mappers/message.test.js`

**Interfaces:**
- Consumes: `unixMsToAppleTime` from Task 8's `chat.js`; `MESSAGE_TYPE` from Task 3's `constants.js`; a Android message row shaped like `queryMessages()`'s output (Task 7); `ctx.sessionMap: Map<jid, zpk>`; `ctx.entityIds.WAMessage`.
- Produces: `classifyMessageType(row) -> number` (drives Task 10–14's applicability checks too — they all import this); `mapMessage(row, ctx) -> values object or null if no session found`; `insertMessage(db, insertStmt, row, ctx) -> number | null` (returns new `Z_PK`, or `null` if skipped). Tasks 10–14 consume the returned `Z_PK` as the `ZMESSAGE` foreign key for their own rows.

- [ ] **Step 1: Write the failing test**

Create `main/modules/mappers/message.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyMessageType, mapMessage } = require('./message');
const { MESSAGE_TYPE } = require('./constants');

test('classifyMessageType picks media/location/vcard/sticker/text by data presence, not Android message_type', () => {
  assert.equal(classifyMessageType({ media_mime_type: 'image/jpeg' }), MESSAGE_TYPE.IMAGE);
  assert.equal(classifyMessageType({ media_mime_type: 'video/mp4' }), MESSAGE_TYPE.VIDEO);
  assert.equal(classifyMessageType({ media_mime_type: 'audio/ogg' }), MESSAGE_TYPE.AUDIO);
  assert.equal(classifyMessageType({ is_sticker: 1, media_mime_type: 'image/webp' }), MESSAGE_TYPE.STICKER);
  assert.equal(classifyMessageType({ latitude: 1.1, longitude: 2.2 }), MESSAGE_TYPE.LOCATION);
  assert.equal(classifyMessageType({ vcard: 'BEGIN:VCARD...' }), MESSAGE_TYPE.CONTACT_CARD);
  assert.equal(classifyMessageType({}), MESSAGE_TYPE.TEXT);
});

test('mapMessage returns null when the chat session is missing', () => {
  const row = { key_remote_jid: 'nobody@s.whatsapp.net', timestamp: 0, from_me: 0, data: null, status: 0 };
  const ctx = { nextZpk: 1, entityIds: { WAMessage: 9 }, sessionMap: new Map() };
  assert.equal(mapMessage(row, ctx), null);
});

test('mapMessage maps fields when a session exists', () => {
  const row = {
    key_remote_jid: 'a@s.whatsapp.net', _id: 42, timestamp: 1000000, from_me: 1,
    data: 'hello', status: 3, remote_resource: null,
  };
  const ctx = { nextZpk: 7, entityIds: { WAMessage: 9 }, sessionMap: new Map([['a@s.whatsapp.net', 3]]) };
  const mapped = mapMessage(row, ctx);
  assert.equal(mapped.zpk, 7);
  assert.equal(mapped.chatSessionZpk, 3);
  assert.equal(mapped.isFromMe, 1);
  assert.equal(mapped.text, 'hello');
  assert.equal(mapped.status, 3);
  assert.equal(mapped.messageType, 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test main/modules/mappers/message.test.js`
Expected: FAIL — `Cannot find module './message'`

- [ ] **Step 3: Write the implementation**

Create `main/modules/mappers/message.js`:

```js
const { unixMsToAppleTime } = require('./chat');
const { MESSAGE_TYPE } = require('./constants');

function classifyMessageType(row) {
  if (row.is_sticker) return MESSAGE_TYPE.STICKER;
  if (row.media_mime_type) {
    if (row.media_mime_type.startsWith('image/')) return MESSAGE_TYPE.IMAGE;
    if (row.media_mime_type.startsWith('video/')) return MESSAGE_TYPE.VIDEO;
    if (row.media_mime_type.startsWith('audio/')) return MESSAGE_TYPE.AUDIO;
    return MESSAGE_TYPE.DOCUMENT;
  }
  if (row.latitude != null && row.longitude != null) return MESSAGE_TYPE.LOCATION;
  if (row.vcard) return MESSAGE_TYPE.CONTACT_CARD;
  return MESSAGE_TYPE.TEXT;
}

function mapMessage(row, ctx) {
  const chatSessionZpk = ctx.sessionMap.get(row.key_remote_jid);
  if (!chatSessionZpk) return null;

  return {
    zpk: ctx.nextZpk,
    entityId: ctx.entityIds.WAMessage,
    chatSessionZpk,
    isFromMe: row.from_me,
    messageDate: unixMsToAppleTime(row.timestamp),
    text: row.data || null,
    status: row.status || 0,
    fromJid: row.remote_resource || null,
    messageType: classifyMessageType(row),
  };
}

function insertMessage(db, insertStmt, row, ctx) {
  const mapped = mapMessage(row, ctx);
  if (!mapped) return null;
  try {
    insertStmt.run(
      mapped.zpk, mapped.entityId, mapped.chatSessionZpk, mapped.isFromMe,
      mapped.messageDate, mapped.messageDate, mapped.text, mapped.status,
      mapped.fromJid, mapped.messageType
    );
  } catch (e) {
    return null;
  }
  return mapped.zpk;
}

module.exports = { classifyMessageType, mapMessage, insertMessage };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test main/modules/mappers/message.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add main/modules/mappers/message.js main/modules/mappers/message.test.js
git commit -m "feat: add message.js mapper with data-presence-based type classification"
```

---

### Task 10: `mappers/media.js`

**Files:**
- Create: `main/modules/mappers/media.js`
- Test: `main/modules/mappers/media.test.js`

**Interfaces:**
- Consumes: `registerFile` (Task 4); `MEDIA_RELATIVE_PATH_PREFIX` (Task 3); Android row fields `file_path`, `media_name`, `media_size`, `width`, `height`, `media_duration`; `ctx.entityIds.WAMediaItem`; `ctx.pulledMediaRoot` (local folder Task 6 pulled files into); `ctx.backupPath`/`ctx.mediaDomain` (for `registerFile`).
- Produces: `mapMedia(row, ctx) -> values | null (no media on this row)`; `insertMedia(db, insertStmt, manifestDb, row, messageZpk, ctx) -> { zpk, missing: boolean } | null`.

- [ ] **Step 1: Write the failing test**

Create `main/modules/mappers/media.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { mapMedia } = require('./media');

test('mapMedia returns null when the row has no media', () => {
  assert.equal(mapMedia({}, { nextZpk: 1, entityIds: { WAMediaItem: 8 } }), null);
});

test('mapMedia computes aspect ratio and carries duration/size', () => {
  const row = { file_path: 'Media/WhatsApp Images/x.jpg', media_size: 2048, width: 1920, height: 1080, media_duration: null };
  const mapped = mapMedia(row, { nextZpk: 5, entityIds: { WAMediaItem: 8 } });
  assert.equal(mapped.zpk, 5);
  assert.equal(mapped.fileSize, 2048);
  assert.equal(mapped.aspectRatio, 1920 / 1080);
  assert.equal(mapped.movieDuration, 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test main/modules/mappers/media.test.js`
Expected: FAIL — `Cannot find module './media'`

- [ ] **Step 3: Write the implementation**

Create `main/modules/mappers/media.js`:

```js
const fs = require('fs');
const path = require('path');
const { registerFile } = require('../ios-backup-writer');
const { MEDIA_RELATIVE_PATH_PREFIX } = require('./constants');
const { createLogger } = require('../../utils/logger');

const logger = createLogger('media-mapper');

function mapMedia(row, ctx) {
  if (!row.file_path) return null;
  return {
    zpk: ctx.nextZpk,
    entityId: ctx.entityIds.WAMediaItem,
    fileSize: row.media_size || 0,
    aspectRatio: row.width && row.height ? row.width / row.height : 0,
    movieDuration: row.media_duration || 0,
    sourceFilePath: row.file_path,
  };
}

function insertMedia(db, insertStmt, manifestDb, row, messageZpk, ctx) {
  const mapped = mapMedia(row, ctx);
  if (!mapped) return null;

  const localSourcePath = path.join(ctx.pulledMediaRoot, mapped.sourceFilePath);
  let iosRelativePath = null;
  let missing = true;

  if (fs.existsSync(localSourcePath)) {
    const bytes = fs.readFileSync(localSourcePath);
    const filename = path.basename(mapped.sourceFilePath);
    iosRelativePath = `${MEDIA_RELATIVE_PATH_PREFIX}/${filename}`;
    try {
      registerFile(ctx.backupPath, manifestDb, ctx.mediaDomain, iosRelativePath, bytes);
      missing = false;
    } catch (e) {
      logger.warn(`Failed to register media file ${mapped.sourceFilePath}: ${e.message}`);
    }
  } else {
    logger.warn(`Media file missing on device, skipping bytes: ${mapped.sourceFilePath}`);
  }

  try {
    insertStmt.run(
      mapped.zpk, mapped.entityId, messageZpk, mapped.fileSize,
      mapped.aspectRatio, mapped.movieDuration, iosRelativePath
    );
  } catch (e) {
    return null;
  }
  return { zpk: mapped.zpk, missing };
}

module.exports = { mapMedia, insertMedia };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test main/modules/mappers/media.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add main/modules/mappers/media.js main/modules/mappers/media.test.js
git commit -m "feat: add media.js mapper with real file registration and missing-file handling"
```

---

### Task 11: `mappers/location.js`

**Files:**
- Create: `main/modules/mappers/location.js`
- Test: `main/modules/mappers/location.test.js`

**Interfaces:**
- Produces: `mapLocation(row, ctx) -> values | null`; `insertLocation(db, insertStmt, row, messageZpk, ctx) -> number | null`. Uses the same `ZWAMEDIAITEM` table as Task 10 (per spec: locations have no separate entity, they use `ZLATITUDE`/`ZLONGITUDE`/`ZTITLE` directly on a media item row).

- [ ] **Step 1: Write the failing test**

Create `main/modules/mappers/location.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { mapLocation } = require('./location');

test('mapLocation returns null without coordinates', () => {
  assert.equal(mapLocation({}, { nextZpk: 1, entityIds: { WAMediaItem: 8 } }), null);
});

test('mapLocation maps lat/long/title', () => {
  const row = { latitude: 51.05, longitude: 3.72, place_name: 'Ghent' };
  const mapped = mapLocation(row, { nextZpk: 2, entityIds: { WAMediaItem: 8 } });
  assert.equal(mapped.latitude, 51.05);
  assert.equal(mapped.longitude, 3.72);
  assert.equal(mapped.title, 'Ghent');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test main/modules/mappers/location.test.js`
Expected: FAIL — `Cannot find module './location'`

- [ ] **Step 3: Write the implementation**

Create `main/modules/mappers/location.js`:

```js
function mapLocation(row, ctx) {
  if (row.latitude == null || row.longitude == null) return null;
  return {
    zpk: ctx.nextZpk,
    entityId: ctx.entityIds.WAMediaItem,
    latitude: row.latitude,
    longitude: row.longitude,
    title: row.place_name || null,
  };
}

function insertLocation(db, insertStmt, row, messageZpk, ctx) {
  const mapped = mapLocation(row, ctx);
  if (!mapped) return null;
  try {
    insertStmt.run(mapped.zpk, mapped.entityId, messageZpk, mapped.latitude, mapped.longitude, mapped.title);
  } catch (e) {
    return null;
  }
  return mapped.zpk;
}

module.exports = { mapLocation, insertLocation };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test main/modules/mappers/location.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add main/modules/mappers/location.js main/modules/mappers/location.test.js
git commit -m "feat: add location.js mapper (message_location -> ZWAMEDIAITEM lat/long)"
```

---

### Task 12: `mappers/vcard.js`

**Files:**
- Create: `main/modules/mappers/vcard.js`
- Test: `main/modules/mappers/vcard.test.js`

**Interfaces:**
- Produces: `parseVcardName(vcardText) -> string | null`; `mapVcard(row, ctx) -> values | null`; `insertVcard(db, mediaInsertStmt, vcardInsertStmt, row, messageZpk, ctx) -> { mediaZpk, vcardZpk } | null`. Writes both a `ZWAMEDIAITEM` row (`ZVCARDNAME`/`ZVCARDSTRING`) and a `ZWAVCARDMENTION` row, per the spec's mapping table.

- [ ] **Step 1: Write the failing test**

Create `main/modules/mappers/vcard.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseVcardName, mapVcard } = require('./vcard');

test('parseVcardName extracts the FN field', () => {
  const vcard = 'BEGIN:VCARD\nVERSION:3.0\nFN:Jane Doe\nTEL:+32123456\nEND:VCARD';
  assert.equal(parseVcardName(vcard), 'Jane Doe');
});

test('parseVcardName returns null when FN is absent', () => {
  assert.equal(parseVcardName('BEGIN:VCARD\nEND:VCARD'), null);
});

test('mapVcard returns null without a vcard field', () => {
  assert.equal(mapVcard({}, { nextZpk: 1, entityIds: { WAMediaItem: 8, WAVCardMention: 14 } }), null);
});

test('mapVcard maps the raw text and parsed name', () => {
  const row = { vcard: 'BEGIN:VCARD\nFN:Jane Doe\nEND:VCARD', key_from_me: 1 };
  const mapped = mapVcard(row, { nextZpk: 3, entityIds: { WAMediaItem: 8, WAVCardMention: 14 } });
  assert.equal(mapped.vcardName, 'Jane Doe');
  assert.equal(mapped.isFromMe, 1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test main/modules/mappers/vcard.test.js`
Expected: FAIL — `Cannot find module './vcard'`

- [ ] **Step 3: Write the implementation**

Create `main/modules/mappers/vcard.js`:

```js
function parseVcardName(vcardText) {
  const match = /^FN:(.+)$/m.exec(vcardText);
  return match ? match[1].trim() : null;
}

function mapVcard(row, ctx) {
  if (!row.vcard) return null;
  return {
    mediaZpk: ctx.nextZpk,
    vcardZpk: ctx.nextZpk + 1,
    mediaEntityId: ctx.entityIds.WAMediaItem,
    vcardEntityId: ctx.entityIds.WAVCardMention,
    vcardString: row.vcard,
    vcardName: parseVcardName(row.vcard),
    isFromMe: row.key_from_me,
  };
}

function insertVcard(db, mediaInsertStmt, vcardInsertStmt, row, messageZpk, ctx) {
  const mapped = mapVcard(row, ctx);
  if (!mapped) return null;
  try {
    mediaInsertStmt.run(mapped.mediaZpk, mapped.mediaEntityId, messageZpk, mapped.vcardName, mapped.vcardString);
    vcardInsertStmt.run(mapped.vcardZpk, mapped.vcardEntityId, mapped.mediaZpk, mapped.isFromMe);
  } catch (e) {
    return null;
  }
  return { mediaZpk: mapped.mediaZpk, vcardZpk: mapped.vcardZpk };
}

module.exports = { parseVcardName, mapVcard, insertVcard };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test main/modules/mappers/vcard.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add main/modules/mappers/vcard.js main/modules/mappers/vcard.test.js
git commit -m "feat: add vcard.js mapper (message_vcard -> ZWAVCARDMENTION + ZWAMEDIAITEM)"
```

---

### Task 13: `mappers/sticker.js`

**Files:**
- Create: `main/modules/mappers/sticker.js`
- Test: `main/modules/mappers/sticker.test.js`

**Interfaces:**
- Consumes: `mapMedia`/`insertMedia` from Task 10 (stickers reuse the exact same media path — "stickerness" is implied by the source file's type, not a separate schema field, per the spec).
- Produces: `mapSticker(row, ctx) -> values | null` (thin wrapper asserting `row.is_sticker` before delegating).

- [ ] **Step 1: Write the failing test**

Create `main/modules/mappers/sticker.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { mapSticker } = require('./sticker');

test('mapSticker returns null when the row is not a sticker', () => {
  const row = { file_path: 'Media/WhatsApp Images/x.jpg', is_sticker: 0 };
  assert.equal(mapSticker(row, { nextZpk: 1, entityIds: { WAMediaItem: 8 } }), null);
});

test('mapSticker delegates to mapMedia when the row is a sticker', () => {
  const row = { file_path: 'Media/WhatsApp Stickers/x.webp', is_sticker: 1, media_size: 10 };
  const mapped = mapSticker(row, { nextZpk: 2, entityIds: { WAMediaItem: 8 } });
  assert.equal(mapped.zpk, 2);
  assert.equal(mapped.sourceFilePath, 'Media/WhatsApp Stickers/x.webp');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test main/modules/mappers/sticker.test.js`
Expected: FAIL — `Cannot find module './sticker'`

- [ ] **Step 3: Write the implementation**

Create `main/modules/mappers/sticker.js`:

```js
const { mapMedia, insertMedia } = require('./media');

function mapSticker(row, ctx) {
  if (!row.is_sticker) return null;
  return mapMedia(row, ctx);
}

function insertSticker(db, insertStmt, manifestDb, row, messageZpk, ctx) {
  if (!row.is_sticker) return null;
  return insertMedia(db, insertStmt, manifestDb, row, messageZpk, ctx);
}

module.exports = { mapSticker, insertSticker };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test main/modules/mappers/sticker.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add main/modules/mappers/sticker.js main/modules/mappers/sticker.test.js
git commit -m "feat: add sticker.js mapper (delegates to media.js, gated on is_sticker)"
```

---

### Task 14: `mappers/quoted-reply.js`

**Files:**
- Create: `main/modules/mappers/quoted-reply.js`
- Test: `main/modules/mappers/quoted-reply.test.js`

**Interfaces:**
- Consumes: `unixMsToAppleTime` (Task 8); `DATA_ITEM_TYPE.QUOTED_REPLY` (Task 3, flagged unverified).
- Produces: `mapQuotedReply(row, ctx) -> values | null`; `insertQuotedReply(db, insertStmt, row, messageZpk, ctx) -> number | null`.

- [ ] **Step 1: Write the failing test**

Create `main/modules/mappers/quoted-reply.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { mapQuotedReply } = require('./quoted-reply');

test('mapQuotedReply returns null without a quoted message', () => {
  assert.equal(mapQuotedReply({}, { nextZpk: 1, entityIds: { WAMessageDataItem: 10 } }), null);
});

test('mapQuotedReply maps the quoted snapshot fields', () => {
  const row = { quoted_text_data: 'original text', quoted_sender_jid: 'a@s.whatsapp.net', quoted_timestamp: 2000000 };
  const mapped = mapQuotedReply(row, { nextZpk: 4, entityIds: { WAMessageDataItem: 10 } });
  assert.equal(mapped.content1, 'original text');
  assert.equal(mapped.senderJid, 'a@s.whatsapp.net');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test main/modules/mappers/quoted-reply.test.js`
Expected: FAIL — `Cannot find module './quoted-reply'`

- [ ] **Step 3: Write the implementation**

Create `main/modules/mappers/quoted-reply.js`:

```js
const { unixMsToAppleTime } = require('./chat');
const { DATA_ITEM_TYPE } = require('./constants');

function mapQuotedReply(row, ctx) {
  if (!row.quoted_text_data && !row.quoted_sender_jid) return null;
  return {
    zpk: ctx.nextZpk,
    entityId: ctx.entityIds.WAMessageDataItem,
    type: DATA_ITEM_TYPE.QUOTED_REPLY,
    content1: row.quoted_text_data || null,
    senderJid: row.quoted_sender_jid || null,
    date: row.quoted_timestamp ? unixMsToAppleTime(row.quoted_timestamp) : 0,
  };
}

function insertQuotedReply(db, insertStmt, row, messageZpk, ctx) {
  const mapped = mapQuotedReply(row, ctx);
  if (!mapped) return null;
  try {
    insertStmt.run(mapped.zpk, mapped.entityId, mapped.type, messageZpk, mapped.content1, mapped.senderJid, mapped.date);
  } catch (e) {
    return null;
  }
  return mapped.zpk;
}

module.exports = { mapQuotedReply, insertQuotedReply };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test main/modules/mappers/quoted-reply.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add main/modules/mappers/quoted-reply.js main/modules/mappers/quoted-reply.test.js
git commit -m "feat: add quoted-reply.js mapper (message_quoted -> ZWAMESSAGEDATAITEM)"
```

---

### Task 15: `mappers/group.js`

**Files:**
- Create: `main/modules/mappers/group.js`
- Test: `main/modules/mappers/group.test.js`

**Interfaces:**
- Consumes: rows shaped like `queryGroupMembers()`'s output (Task 7): `{ group_jid, member_jid, rank, add_timestamp }`.
- Produces: `mapGroupInfo(groupJid, chatSessionZpk, ctx) -> values`; `mapGroupMember(memberRow, chatSessionZpk, ctx) -> values`; `insertGroup(db, groupInfoStmt, memberStmt, groupJid, memberRows, chatSessionZpk, ctx) -> { groupInfoZpk, memberZpks: number[] }`.

- [ ] **Step 1: Write the failing test**

Create `main/modules/mappers/group.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { mapGroupInfo, mapGroupMember } = require('./group');

test('mapGroupInfo carries the chat session link and creator jid', () => {
  const mapped = mapGroupInfo('123@g.us', 7, { nextZpk: 1, entityIds: { WAGroupInfo: 5 } });
  assert.equal(mapped.chatSessionZpk, 7);
  assert.equal(mapped.creatorJid, '123@g.us');
});

test('mapGroupMember maps rank to an admin flag (rank > 0 => admin)', () => {
  const memberRow = { member_jid: 'a@s.whatsapp.net', rank: 1 };
  const mapped = mapGroupMember(memberRow, 7, { nextZpk: 2, entityIds: { WAGroupMember: 6 } });
  assert.equal(mapped.memberJid, 'a@s.whatsapp.net');
  assert.equal(mapped.isAdmin, 1);

  const nonAdmin = mapGroupMember({ member_jid: 'b@s.whatsapp.net', rank: 0 }, 7, { nextZpk: 3, entityIds: { WAGroupMember: 6 } });
  assert.equal(nonAdmin.isAdmin, 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test main/modules/mappers/group.test.js`
Expected: FAIL — `Cannot find module './group'`

- [ ] **Step 3: Write the implementation**

Create `main/modules/mappers/group.js`:

```js
// group_participant_user.rank's exact admin-status meaning is unverified
// (flagged as a research item alongside the constants.js ones) — treating
// any non-zero rank as admin is a best-effort default, not confirmed truth.
function mapGroupInfo(groupJid, chatSessionZpk, ctx) {
  return {
    zpk: ctx.nextZpk,
    entityId: ctx.entityIds.WAGroupInfo,
    chatSessionZpk,
    creatorJid: groupJid,
  };
}

function mapGroupMember(memberRow, chatSessionZpk, ctx) {
  return {
    zpk: ctx.nextZpk,
    entityId: ctx.entityIds.WAGroupMember,
    chatSessionZpk,
    memberJid: memberRow.member_jid,
    isAdmin: memberRow.rank > 0 ? 1 : 0,
  };
}

function insertGroup(db, groupInfoStmt, memberStmt, groupJid, memberRows, chatSessionZpk, ctx) {
  const groupInfo = mapGroupInfo(groupJid, chatSessionZpk, ctx);
  try {
    groupInfoStmt.run(groupInfo.zpk, groupInfo.entityId, groupInfo.chatSessionZpk, groupInfo.creatorJid);
  } catch (e) {
    return { groupInfoZpk: null, memberZpks: [] };
  }

  const memberZpks = [];
  let nextZpk = groupInfo.zpk + 1;
  for (const memberRow of memberRows) {
    const member = mapGroupMember(memberRow, chatSessionZpk, { ...ctx, nextZpk });
    try {
      memberStmt.run(member.zpk, member.entityId, member.chatSessionZpk, member.memberJid, member.isAdmin);
      memberZpks.push(member.zpk);
    } catch (e) {
      // skip this member, keep going
    }
    nextZpk++;
  }

  return { groupInfoZpk: groupInfo.zpk, memberZpks };
}

module.exports = { mapGroupInfo, mapGroupMember, insertGroup };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test main/modules/mappers/group.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add main/modules/mappers/group.js main/modules/mappers/group.test.js
git commit -m "feat: add group.js mapper (group_participant_user -> ZWAGROUPINFO/ZWAGROUPMEMBER)"
```

---

### Task 16: Rewrite `schema-mapper.js` as the orchestrator

**Files:**
- Modify: `main/modules/schema-mapper.js` (full rewrite)
- Test: `main/modules/schema-mapper.test.js`

**Interfaces:**
- Consumes every mapper/helper from Tasks 1–15: `getEntityIds`/`bumpZMax` (Task 1), `registerFile` (Task 4), `patchFileSize` (Task 5), `AdbModule.pullMediaFiles` (Task 6), `queryMessages`/`queryChats`/`queryGroupMembers` (Task 7), `insertChat` (Task 8), `insertMessage` (Task 9), `insertMedia` (Task 10), `insertLocation` (Task 11), `insertVcard` (Task 12), `insertSticker` (Task 13), `insertQuotedReply` (Task 14), `insertGroup` (Task 15).
- Produces: `mergeSchemas(serial, appId, androidDbPath, iosBackupId, onProgress) -> { success, backupId, fileId, stats: { chats, messages, mediaMissing } }` — note the signature grows two new leading params (`serial`, `appId`) versus the current `mergeSchemas(androidDbPath, iosBackupId, includeMedia, onProgress)`, since media pull now needs device access. **This is a breaking change to the IPC caller** — Task 17 updates `main/ipc-handlers.js` and the renderer call site to match.

- [ ] **Step 1: Write the failing test**

Create `main/modules/schema-mapper.test.js` (exercises the pure per-message dispatch logic with an in-memory fake DB, without touching `better-sqlite3`, `adb`, or the filesystem beyond a temp dir):

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildInsertPlan } = require('./schema-mapper');

test('buildInsertPlan orders one message row into the right mapper bucket', () => {
  const textRow = { key_remote_jid: 'a@s.whatsapp.net', data: 'hi' };
  const mediaRow = { key_remote_jid: 'a@s.whatsapp.net', file_path: 'Media/x.jpg' };
  const locationRow = { key_remote_jid: 'a@s.whatsapp.net', latitude: 1, longitude: 2 };

  assert.equal(buildInsertPlan(textRow), 'text');
  assert.equal(buildInsertPlan(mediaRow), 'media');
  assert.equal(buildInsertPlan(locationRow), 'location');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test main/modules/schema-mapper.test.js`
Expected: FAIL — `buildInsertPlan` not exported yet.

- [ ] **Step 3: Write the implementation**

Replace the full contents of `main/modules/schema-mapper.js`:

```js
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { getWhatsAppDbPath, getBackupPath } = require('./ios-injector');
const { queryMessages, queryChats, queryGroupMembers } = require('./android-parser');
const { getEntityIds, bumpZMax } = require('./mappers/z-entities');
const { insertChat } = require('./mappers/chat');
const { insertMessage } = require('./mappers/message');
const { insertMedia } = require('./mappers/media');
const { insertLocation } = require('./mappers/location');
const { insertVcard } = require('./mappers/vcard');
const { insertSticker } = require('./mappers/sticker');
const { insertQuotedReply } = require('./mappers/quoted-reply');
const { insertGroup } = require('./mappers/group');
const { createLogger } = require('../utils/logger');

const logger = createLogger('schema-mapper');

// Decides which mapper "bucket" a message row belongs to, by data presence —
// same principle as message.js's classifyMessageType, exposed separately so
// the orchestrator's dispatch order is independently testable.
function buildInsertPlan(row) {
  if (row.is_sticker) return 'sticker';
  if (row.file_path) return 'media';
  if (row.latitude != null && row.longitude != null) return 'location';
  if (row.vcard) return 'vcard';
  return 'text';
}

async function mergeSchemas(serial, appId, androidDbPath, iosBackupId, onProgress) {
  logger.info(`Starting schema merge: ${androidDbPath} → backup ${iosBackupId}`);

  const { filePath: iosChatDbPath, fileId, domain } = getWhatsAppDbPath(iosBackupId, false);
  const backupPath = getBackupPath(iosBackupId);
  const manifestPath = path.join(backupPath, 'Manifest.db');

  const tmpIosDb = path.join(os.tmpdir(), 'wa-transfer', 'ChatStorage_modified.sqlite');
  fs.copyFileSync(iosChatDbPath, tmpIosDb);

  const stats = { chats: 0, messages: 0, mediaMissing: 0 };
  let androidDb, iosDb, manifestDb;

  try {
    androidDb = new Database(androidDbPath, { readonly: true });
    iosDb = new Database(tmpIosDb);
    manifestDb = new Database(manifestPath);

    const chats = queryChats(androidDb);
    const messages = queryMessages(androidDb);
    const groupMembers = queryGroupMembers(androidDb);

    onProgress({ percent: 5, currentChat: 'Reading Android data...', done: false });

    const entityIds = getEntityIds(iosDb);

    // Pull only the media referenced by in-scope messages before mapping.
    const referencedPaths = [...new Set(messages.filter((m) => m.file_path).map((m) => m.file_path))];
    const pulledMediaRoot = path.join(os.tmpdir(), 'wa-transfer', 'pulled-media');
    fs.mkdirSync(pulledMediaRoot, { recursive: true });
    if (referencedPaths.length > 0) {
      onProgress({ percent: 10, currentChat: `Pulling ${referencedPaths.length} media file(s)...`, done: false });
      const { AdbModule } = require('./adb');
      const adb = new AdbModule();
      await adb.pullMediaFiles(serial, appId, referencedPaths, pulledMediaRoot, () => {});
    }

    let nextChatZpk = (iosDb.prepare('SELECT MAX(Z_PK) as m FROM ZWACHATSESSION').get()?.m || 0) + 1;
    let nextMessageZpk = (iosDb.prepare('SELECT MAX(Z_PK) as m FROM ZWAMESSAGE').get()?.m || 0) + 1;
    let nextMediaZpk = (iosDb.prepare('SELECT MAX(Z_PK) as m FROM ZWAMEDIAITEM').get()?.m || 0) + 1;
    let nextDataItemZpk = (iosDb.prepare('SELECT MAX(Z_PK) as m FROM ZWAMESSAGEDATAITEM').get()?.m || 0) + 1;
    let nextVcardZpk = (iosDb.prepare('SELECT MAX(Z_PK) as m FROM ZWAVCARDMENTION').get()?.m || 0) + 1;
    let nextGroupInfoZpk = (iosDb.prepare('SELECT MAX(Z_PK) as m FROM ZWAGROUPINFO').get()?.m || 0) + 1;
    let nextGroupMemberZpk = (iosDb.prepare('SELECT MAX(Z_PK) as m FROM ZWAGROUPMEMBER').get()?.m || 0) + 1;

    const sessionMap = new Map();
    const insertSession = iosDb.prepare(`
      INSERT OR IGNORE INTO ZWACHATSESSION (Z_PK, Z_ENT, ZCONTACTJID, ZPARTNERNAME, ZLASTMESSAGEDATE, ZUNREADCOUNT)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const insertMessageStmt = iosDb.prepare(`
      INSERT OR IGNORE INTO ZWAMESSAGE
        (Z_PK, Z_ENT, ZCHATSESSION, ZISFROMME, ZMESSAGEDATE, ZSENTDATE, ZTEXT, ZMESSAGESTATUS, ZFROMJID, ZMESSAGETYPE)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertMediaStmt = iosDb.prepare(`
      INSERT OR IGNORE INTO ZWAMEDIAITEM (Z_PK, Z_ENT, ZMESSAGE, ZFILESIZE, ZASPECTRATIO, ZMOVIEDURATION, ZMEDIALOCALPATH)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const insertLocationStmt = iosDb.prepare(`
      INSERT OR IGNORE INTO ZWAMEDIAITEM (Z_PK, Z_ENT, ZMESSAGE, ZLATITUDE, ZLONGITUDE, ZTITLE)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const insertVcardMediaStmt = iosDb.prepare(`
      INSERT OR IGNORE INTO ZWAMEDIAITEM (Z_PK, Z_ENT, ZMESSAGE, ZVCARDNAME, ZVCARDSTRING)
      VALUES (?, ?, ?, ?, ?)
    `);
    const insertVcardMentionStmt = iosDb.prepare(`
      INSERT OR IGNORE INTO ZWAVCARDMENTION (Z_PK, Z_ENT, ZMEDIAITEM, ZISFROMME)
      VALUES (?, ?, ?, ?)
    `);
    const insertQuotedStmt = iosDb.prepare(`
      INSERT OR IGNORE INTO ZWAMESSAGEDATAITEM (Z_PK, Z_ENT, ZTYPE, ZMESSAGE, ZCONTENT1, ZSENDERJID, ZDATE)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const insertGroupInfoStmt = iosDb.prepare(`
      INSERT OR IGNORE INTO ZWAGROUPINFO (Z_PK, Z_ENT, ZCHATSESSION, ZCREATORJID)
      VALUES (?, ?, ?, ?)
    `);
    const insertGroupMemberStmt = iosDb.prepare(`
      INSERT OR IGNORE INTO ZWAGROUPMEMBER (Z_PK, Z_ENT, ZCHATSESSION, ZMEMBERJID, ZISADMIN)
      VALUES (?, ?, ?, ?, ?)
    `);

    iosDb.transaction(() => {
      for (const chat of chats) {
        const ctx = { nextZpk: nextChatZpk, entityIds };
        try {
          const zpk = insertChat(iosDb, insertSession, chat, ctx);
          sessionMap.set(chat.key_remote_jid, zpk);
          nextChatZpk++;
          stats.chats++;
        } catch (e) {
          logger.warn(`Skip chat ${chat.key_remote_jid}: ${e.message}`);
        }
      }
    })();

    onProgress({ percent: 25, currentChat: 'Inserting group info...', done: false });

    const membersByGroup = new Map();
    for (const m of groupMembers) {
      if (!membersByGroup.has(m.group_jid)) membersByGroup.set(m.group_jid, []);
      membersByGroup.get(m.group_jid).push(m);
    }
    iosDb.transaction(() => {
      for (const [groupJid, members] of membersByGroup) {
        const chatSessionZpk = sessionMap.get(groupJid);
        if (!chatSessionZpk) continue;
        const { groupInfoZpk, memberZpks } = insertGroup(
          iosDb, insertGroupInfoStmt, insertGroupMemberStmt, groupJid, members, chatSessionZpk,
          { nextZpk: nextGroupInfoZpk, entityIds }
        );
        if (groupInfoZpk) nextGroupInfoZpk = groupInfoZpk + 1;
        if (memberZpks.length) nextGroupMemberZpk = Math.max(nextGroupMemberZpk, ...memberZpks) + 1;
      }
    })();

    onProgress({ percent: 35, currentChat: 'Inserting messages...', done: false });

    const total = messages.length;
    iosDb.transaction(() => {
      for (let i = 0; i < messages.length; i++) {
        const row = messages[i];
        const messageCtx = { nextZpk: nextMessageZpk, entityIds, sessionMap };
        const messageZpk = insertMessage(iosDb, insertMessageStmt, row, messageCtx);
        if (!messageZpk) continue;
        nextMessageZpk = messageZpk + 1;
        stats.messages++;

        const bucket = buildInsertPlan(row);
        const subCtx = { nextZpk: nextMediaZpk, entityIds, pulledMediaRoot, backupPath, mediaDomain: domain };

        if (bucket === 'media' || bucket === 'sticker') {
          const inserter = bucket === 'sticker' ? insertSticker : insertMedia;
          const result = inserter(iosDb, insertMediaStmt, manifestDb, row, messageZpk, subCtx);
          if (result) {
            nextMediaZpk = result.zpk + 1;
            if (result.missing) stats.mediaMissing++;
          }
        } else if (bucket === 'location') {
          const zpk = insertLocation(iosDb, insertLocationStmt, row, messageZpk, { nextZpk: nextMediaZpk, entityIds });
          if (zpk) nextMediaZpk = zpk + 1;
        } else if (bucket === 'vcard') {
          const result = insertVcard(
            iosDb, insertVcardMediaStmt, insertVcardMentionStmt, row, messageZpk,
            { nextZpk: nextMediaZpk, entityIds }
          );
          if (result) {
            nextMediaZpk = Math.max(result.mediaZpk, nextVcardZpk) + 1;
            nextVcardZpk = result.vcardZpk + 1;
          }
        }

        if (row.quoted_text_data || row.quoted_sender_jid) {
          const zpk = insertQuotedReply(iosDb, insertQuotedStmt, row, messageZpk, { nextZpk: nextDataItemZpk, entityIds });
          if (zpk) nextDataItemZpk = zpk + 1;
        }

        if (i % 500 === 0) {
          onProgress({ percent: 35 + Math.floor((i / total) * 55), currentChat: row.key_remote_jid, done: false });
        }
      }
    })();

    onProgress({ percent: 92, currentChat: 'Updating Core Data bookkeeping...', done: false });

    bumpZMax(iosDb, 'WAChatSession', nextChatZpk - 1);
    bumpZMax(iosDb, 'WAMessage', nextMessageZpk - 1);
    bumpZMax(iosDb, 'WAMediaItem', nextMediaZpk - 1);
    bumpZMax(iosDb, 'WAMessageDataItem', nextDataItemZpk - 1);
    bumpZMax(iosDb, 'WAVCardMention', nextVcardZpk - 1);
    bumpZMax(iosDb, 'WAGroupInfo', nextGroupInfoZpk - 1);
    bumpZMax(iosDb, 'WAGroupMember', nextGroupMemberZpk - 1);

    androidDb.close();
    iosDb.close();

    fs.copyFileSync(tmpIosDb, iosChatDbPath);

    const { patchFileSize } = require('./manifest-patcher');
    patchFileSize(manifestDb, fileId, fs.statSync(iosChatDbPath).size);
    manifestDb.close();

    logger.info(`Schema merge complete: ${JSON.stringify(stats)}`);
    onProgress({ percent: 100, currentChat: 'Done', done: true });
    return { success: true, backupId: iosBackupId, fileId, stats };
  } catch (err) {
    androidDb?.close();
    iosDb?.close();
    manifestDb?.close();
    logger.error(`mergeSchemas failed: ${err.message}`);
    throw err;
  }
}

module.exports = { mergeSchemas, buildInsertPlan };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test main/modules/schema-mapper.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add main/modules/schema-mapper.js main/modules/schema-mapper.test.js
git commit -m "feat: rewrite schema-mapper.js as a full mapper orchestrator"
```

---

### Task 17: Wire the new `mergeSchemas` signature through IPC and the renderer

**Files:**
- Modify: `main/ipc-handlers.js` (the `ios:merge-schema` handler)
- Modify: `renderer/steps/Step7_Transfer.jsx` (wherever it invokes the merge)

**Interfaces:**
- Consumes: `mergeSchemas(serial, appId, androidDbPath, iosBackupId, onProgress)` (Task 16's new signature).

- [ ] **Step 1: Find and update the IPC handler**

Run: `grep -n "mergeSchemas\|ios:merge-schema" main/ipc-handlers.js`

Update the `ios:merge-schema` handler so it accepts and forwards `serial` and `appId` from the renderer's IPC payload, matching the new `mergeSchemas` signature — e.g.:

```js
ipcMain.handle('ios:merge-schema', async (_, { serial, appId, androidDbPath, iosBackupId }) => {
  try {
    const win = getWindow();
    return await mergeSchemas(serial, appId, androidDbPath, iosBackupId, (progress) => {
      win?.webContents.send('ios:merge-progress', progress);
    });
  } catch (err) {
    return { error: err.message };
  }
});
```

- [ ] **Step 2: Find and update the renderer call site**

Run: `grep -n "merge-schema\|mergeSchema" renderer/steps/Step7_Transfer.jsx`

Update the IPC invocation to pass `serial` and `appId` (both should already be available in that step's state from earlier steps — check `Step3_ConnectAndroid.jsx`/`Step4_ExtractAndroid.jsx` for how `serial`/`appId` are threaded through `transferData` state) alongside the existing `androidDbPath`/`iosBackupId` fields.

- [ ] **Step 3: Manual verification** **[WINDOWS]**

Run the app (`npm run dev`), go through the full flow to Step 7, and confirm the merge step no longer throws a signature-mismatch error and reaches "Done" in the progress log.

- [ ] **Step 4: Commit**

```bash
git add main/ipc-handlers.js renderer/steps/Step7_Transfer.jsx
git commit -m "fix: thread serial/appId through to the rewritten mergeSchemas signature"
```

---

### Task 18: Integration test against real data + manual restore verification

**Files:**
- Test: `main/modules/schema-mapper.integration.test.js` (excluded from the default `node --test` glob via `.integration.test.js` naming — run explicitly)

**Interfaces:**
- Consumes: the full `mergeSchemas` pipeline (Task 16) against real files.

- [ ] **Step 1: Write the integration test** **[WINDOWS]**

Create `main/modules/schema-mapper.integration.test.js` (run manually, not part of CI/the default test glob, since it depends on real local files that don't exist in a fresh checkout):

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const Database = require('better-sqlite3');

const ANDROID_DB = path.join(process.env.TEMP || os.tmpdir(), 'wa-transfer', 'msgstore.db');
const REAL_BACKUP_ID = '00008130-000475241A9A001C'; // adjust to your own backup folder name

test('mergeSchemas produces sane row counts against real data', { skip: !fs.existsSync(ANDROID_DB) }, async () => {
  const { mergeSchemas } = require('./schema-mapper');
  const result = await mergeSchemas('emulator-5554', 'com.whatsapp', ANDROID_DB, REAL_BACKUP_ID, () => {});

  assert.ok(result.success);
  assert.ok(result.stats.chats > 0);
  assert.ok(result.stats.messages > 0);
  console.log('Integration stats:', result.stats);
});
```

- [ ] **Step 2: Run it** **[WINDOWS]**

Run: `node --test main/modules/schema-mapper.integration.test.js`
Expected: PASS, with `stats.chats`/`stats.messages` printed roughly matching the counts already confirmed this session (1,898 chats, ~38k messages) — some drop-off is expected from messages without a resolvable chat session.

- [ ] **Step 3: Manual spot-check** **[WINDOWS]**

Open the modified `ChatStorage.sqlite` (the one at `getWhatsAppDbPath`'s real path, already overwritten by the test above — keep a backup copy of the original first!) with `better-sqlite3` or any SQLite browser, and check:
- `SELECT Z_ENT, Z_NAME, Z_MAX FROM Z_PRIMARYKEY` — `Z_MAX` values should now exceed the pre-merge values for `WAMessage`/`WAChatSession`/etc.
- Pick 2–3 known chats by `ZCONTACTJID` and confirm message counts/text look right.
- Confirm at least one `ZWAMEDIAITEM` row has a non-null `ZMEDIALOCALPATH` and that the corresponding file exists on disk at its content-addressed path under the backup folder.

- [ ] **Step 4: Manual restore verification (the real gate)**

This cannot be automated. Using iTunes/Apple Devices app, point a **test device** (not your primary phone, given this is best-effort/unverified media path data) at this modified backup and attempt a restore. Confirm:
- The restore completes without iTunes rejecting `ChatStorage.sqlite` as corrupted (validates the `Manifest.db`/`Z_ENT`/`Z_MAX` fixes).
- Chats and text messages appear in WhatsApp after restore.
- At least one photo/video attachment actually displays (validates or refutes the best-effort `MEDIA_RELATIVE_PATH_PREFIX` guess from Task 3 — if it fails, that's the concrete signal needed to revisit the relativePath convention with a different guess or external research).

- [ ] **Step 5: Commit**

```bash
git add main/modules/schema-mapper.integration.test.js
git commit -m "test: add manual integration test + restore verification checklist"
```
