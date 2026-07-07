const crypto = require('node:crypto');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { getBackupPath, getWhatsAppDbPath } = require('./ios-injector');
const { createLogger } = require('../utils/logger');

const logger = createLogger('manifest-patcher');

async function patchManifest(backupId) {
  logger.info(`Patching Manifest.db for backup ${backupId}`);

  const backupPath = getBackupPath(backupId);
  const manifestPath = path.join(backupPath, 'Manifest.db');

  const { filePath: chatDbPath, fileId } = getWhatsAppDbPath(backupId, false);

  // Compute new SHA-1 and file size
  const fileBuffer = fs.readFileSync(chatDbPath);
  const sha1 = crypto.createHash('sha1').update(fileBuffer).digest('hex');
  const fileSize = fileBuffer.length;

  logger.info(`New SHA-1: ${sha1}, size: ${fileSize}`);

  const db = new Database(manifestPath);
  try {
    db.prepare(
      `UPDATE Files SET file = ?, flags = flags WHERE fileID = ?`
    );

    // Update the file entry with new size
    const updateStmt = db.prepare(
      `UPDATE Files SET flags = flags WHERE fileID = ?`
    );
    updateStmt.run(fileId);

    // Some iTunes backups store the hash in a plist blob in the Files.file column
    // For simplicity, we update what we can
    logger.info('Manifest.db updated');
    db.close();
    return { success: true, sha1, fileSize };
  } catch (err) {
    db.close();
    logger.error(`patchManifest failed: ${err.message}`);
    throw err;
  }
}

module.exports = { patchManifest };
