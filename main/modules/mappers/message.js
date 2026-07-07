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
