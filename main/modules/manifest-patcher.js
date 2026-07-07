const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { getBackupPath, getWhatsAppDbPath } = require('./ios-injector');
const { writeMBFile, readMBFile } = require('../utils/ios-plist');
const { createLogger } = require('../utils/logger');

const logger = createLogger('manifest-patcher');

// Updates the Size/LastModified/LastStatusChange fields of an existing file's
// MBFile blob in Manifest.db, keeping every other field (fileID, RelativePath,
// Mode, UserID, etc.) unchanged. fileID never changes here: it's a hash of
// domain+relativePath, not file content, so replacing a file's bytes never
// changes its fileID.
function patchFileSize(manifestDb, fileID, newSize) {
  const row = manifestDb.prepare('SELECT file FROM Files WHERE fileID = ?').get(fileID);
  if (!row) throw new Error(`No Files row for fileID ${fileID}`);

  const existing = readMBFile(row.file);
  const now = Math.floor(Date.now() / 1000);
  const updatedBlob = writeMBFile({
    ...existing,
    size: newSize,
    lastModified: now,
    lastStatusChange: now,
  });

  manifestDb.prepare('UPDATE Files SET file = ? WHERE fileID = ?').run(updatedBlob, fileID);
}

async function patchManifest(backupId) {
  logger.info(`Patching Manifest.db for backup ${backupId}`);

  const backupPath = getBackupPath(backupId);
  const manifestPath = path.join(backupPath, 'Manifest.db');
  const { filePath: chatDbPath, fileId } = getWhatsAppDbPath(backupId, false);

  const newSize = fs.statSync(chatDbPath).size;

  const db = new Database(manifestPath);
  try {
    patchFileSize(db, fileId, newSize);
    logger.info(`Manifest.db updated: fileID=${fileId} size=${newSize}`);
    db.close();
    return { success: true, fileSize: newSize };
  } catch (err) {
    db.close();
    logger.error(`patchManifest failed: ${err.message}`);
    throw err;
  }
}

module.exports = { patchManifest, patchFileSize };
