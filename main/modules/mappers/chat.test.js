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
