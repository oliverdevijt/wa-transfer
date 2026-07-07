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
