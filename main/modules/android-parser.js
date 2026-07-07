const Database = require('better-sqlite3');
const { createLogger } = require('../utils/logger');

const logger = createLogger('android-parser');

// WhatsApp's modern (post-2016) Android schema normalizes chats/messages/media into
// separate tables (chat/jid/message/message_media) instead of the old chat_list/messages
// tables. These queries project that schema back into the old flat field names
// (key_remote_jid, key_from_me, data, media_mime_type, ...) so the rest of the app
// doesn't need to know which schema generation it's reading.
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

function queryChats(db) {
  return db.prepare(`
    SELECT cj.raw_string AS key_remote_jid, c.subject, c.created_timestamp AS creation,
           c.last_message_row_id AS last_message_table_id
    FROM chat c
    JOIN jid cj ON cj._id = c.jid_row_id
  `).all();
}

function queryGroupMembers(db) {
  return db.prepare(`
    SELECT gcj.raw_string AS group_jid, ucj.raw_string AS member_jid,
           gp.rank, gp.add_timestamp
    FROM group_participant_user gp
    JOIN jid gcj ON gcj._id = gp.group_jid_row_id
    JOIN jid ucj ON ucj._id = gp.user_jid_row_id
  `).all();
}

async function parseAndroidDb(dbPath) {
  logger.info(`Parsing Android DB: ${dbPath}`);
  const db = new Database(dbPath, { readonly: true });

  try {
    const messages = queryMessages(db);
    const chats = queryChats(db);

    const mediaMessages = messages.filter(m => m.media_mime_type);

    logger.info(`Parsed: ${chats.length} chats, ${messages.length} messages, ${mediaMessages.length} media`);
    db.close();

    return {
      chatCount: chats.length,
      messageCount: messages.length,
      mediaCount: mediaMessages.length,
      chats,
      messages,
    };
  } catch (err) {
    db.close();
    logger.error(`parseAndroidDb failed: ${err.message}`);
    throw err;
  }
}

module.exports = { parseAndroidDb, queryMessages, queryChats, queryGroupMembers };
