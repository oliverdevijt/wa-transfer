const Database = require('better-sqlite3');
const { createLogger } = require('../utils/logger');

const logger = createLogger('android-parser');

async function parseAndroidDb(dbPath) {
  logger.info(`Parsing Android DB: ${dbPath}`);
  const db = new Database(dbPath, { readonly: true });

  try {
    const messages = db.prepare(`
      SELECT m._id, m.key_remote_jid, m.key_from_me, m.timestamp,
             m.data, m.status, m.media_mime_type, m.remote_resource,
             m.media_name, m.media_size, m.latitude, m.longitude,
             m.thumb_image, m.raw_data
      FROM messages m
      ORDER BY m.timestamp ASC
    `).all();

    const chats = db.prepare(`
      SELECT key_remote_jid, subject, creation, last_message_table_id
      FROM chat_list
    `).all();

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

module.exports = { parseAndroidDb };
