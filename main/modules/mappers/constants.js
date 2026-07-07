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
