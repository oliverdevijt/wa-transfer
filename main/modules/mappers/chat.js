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
