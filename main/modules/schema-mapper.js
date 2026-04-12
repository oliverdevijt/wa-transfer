const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { getWhatsAppDbPath, getBackupPath } = require('./ios-injector');
const { createLogger } = require('../utils/logger');

const logger = createLogger('schema-mapper');

// Apple Core Data epoch offset
const APPLE_EPOCH_OFFSET = 978307200;

function unixMsToAppleTime(unixMs) {
  return (unixMs / 1000) - APPLE_EPOCH_OFFSET;
}

function mimeToCategory(mime) {
  if (!mime) return 0;
  if (mime.startsWith('image/')) return 1;
  if (mime.startsWith('audio/')) return 2;
  if (mime.startsWith('video/')) return 3;
  return 0;
}

async function mergeSchemas(androidDbPath, iosBackupId, includeMedia, onProgress) {
  logger.info(`Starting schema merge: ${androidDbPath} → backup ${iosBackupId}`);

  const { filePath: iosChatDbPath, fileId, domain } = getWhatsAppDbPath(iosBackupId, false);

  // Work on a copy
  const tmpIosDb = path.join(os.tmpdir(), 'wa-transfer', 'ChatStorage_modified.sqlite');
  fs.copyFileSync(iosChatDbPath, tmpIosDb);

  const androidDb = new Database(androidDbPath, { readonly: true });
  const iosDb = new Database(tmpIosDb);

  try {
    const chats = androidDb.prepare('SELECT * FROM chat_list').all();
    const messages = androidDb.prepare('SELECT * FROM messages ORDER BY timestamp ASC').all();

    onProgress({ percent: 10, currentChat: 'Reading Android data...', done: false });

    // Get max existing Z_PK to avoid conflicts
    let maxPk = 0;
    try {
      const row = iosDb.prepare('SELECT MAX(Z_PK) as m FROM ZWAMESSAGE').get();
      maxPk = row?.m || 0;
    } catch (_) {}

    let maxSessionPk = 0;
    try {
      const row = iosDb.prepare('SELECT MAX(Z_PK) as m FROM ZWACHATSESSION').get();
      maxSessionPk = row?.m || 0;
    } catch (_) {}

    // Insert chat sessions
    const sessionMap = new Map();
    const insertSession = iosDb.prepare(`
      INSERT OR IGNORE INTO ZWACHATSESSION
        (Z_PK, ZCONTACTJID, ZPARTNERNAME, ZLASTMESSAGEDATE, ZMESSAGECOUNTER, ZUNREADCOUNT)
      VALUES (?, ?, ?, ?, ?, 0)
    `);

    iosDb.transaction(() => {
      for (const chat of chats) {
        maxSessionPk++;
        sessionMap.set(chat.key_remote_jid, maxSessionPk);
        try {
          insertSession.run(
            maxSessionPk,
            chat.key_remote_jid,
            chat.subject || chat.key_remote_jid,
            chat.creation ? unixMsToAppleTime(chat.creation) : 0,
            0
          );
        } catch (e) {
          logger.warn(`Skip chat ${chat.key_remote_jid}: ${e.message}`);
        }
      }
    })();

    onProgress({ percent: 30, currentChat: 'Inserting chat sessions...', done: false });

    // Insert messages in batches
    const insertMsg = iosDb.prepare(`
      INSERT OR IGNORE INTO ZWAMESSAGE
        (Z_PK, ZCHATSESSION, ZISFROMME, ZMESSAGEDATE, ZTEXT, ZMESSAGESTATUS, ZMEDIACATEGORY, ZGROUPMEMBER)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const batchSize = 500;
    const total = messages.length;

    iosDb.transaction(() => {
      for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];
        maxPk++;
        const sessionPk = sessionMap.get(msg.key_remote_jid);
        if (!sessionPk) continue;

        try {
          insertMsg.run(
            maxPk,
            sessionPk,
            msg.key_from_me,
            unixMsToAppleTime(msg.timestamp),
            msg.data || null,
            msg.status || 0,
            mimeToCategory(msg.media_mime_type),
            msg.remote_resource || null
          );
        } catch (e) {
          logger.warn(`Skip message ${msg._id}: ${e.message}`);
        }

        if (i % batchSize === 0) {
          const pct = 30 + Math.floor((i / total) * 60);
          const chat = msg.key_remote_jid;
        }
      }
    })();

    onProgress({ percent: 95, currentChat: 'Finalising...', done: false });

    androidDb.close();
    iosDb.close();

    // Copy modified db back to backup location
    fs.copyFileSync(tmpIosDb, iosChatDbPath);
    logger.info('Schema merge complete');

    onProgress({ percent: 100, currentChat: 'Done', done: true });
    return { success: true, backupId: iosBackupId, fileId };
  } catch (err) {
    androidDb.close();
    iosDb.close();
    logger.error(`mergeSchemas failed: ${err.message}`);
    throw err;
  }
}

module.exports = { mergeSchemas };
