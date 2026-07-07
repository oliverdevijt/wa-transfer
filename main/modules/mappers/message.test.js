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
