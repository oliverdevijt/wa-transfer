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
