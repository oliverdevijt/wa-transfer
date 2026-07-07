const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { writeMBFile } = require('../utils/ios-plist');
const { createLogger } = require('../utils/logger');

const logger = createLogger('ios-backup-writer');

// iOS backups address every file by SHA-1("<domain>-<relativePath>"), storing
// the actual bytes at <backupPath>/<fileID[0:2]>/<fileID> and indexing
// metadata in Manifest.db's Files table keyed by that same fileID.
function computeFileId(domain, relativePath) {
  return crypto.createHash('sha1').update(`${domain}-${relativePath}`).digest('hex');
}

function registerFile(backupPath, manifestDb, domain, relativePath, bytes) {
  const fileID = computeFileId(domain, relativePath);
  const destDir = path.join(backupPath, fileID.slice(0, 2));
  fs.mkdirSync(destDir, { recursive: true });
  const destPath = path.join(destDir, fileID);
  fs.writeFileSync(destPath, bytes);

  const now = Math.floor(Date.now() / 1000);
  const fileBlob = writeMBFile({
    size: bytes.length,
    mode: 33188, // regular file, rw-r--r-- — matches real sample
    userID: 501,
    groupID: 501,
    protectionClass: 3,
    flags: 0,
    birth: now,
    lastModified: now,
    lastStatusChange: now,
    relativePath,
  });

  manifestDb.prepare(
    'INSERT OR REPLACE INTO Files (fileID, domain, relativePath, flags, file) VALUES (?, ?, ?, ?, ?)'
  ).run(fileID, domain, relativePath, 1, fileBlob);

  logger.info(`Registered ${relativePath} as ${fileID} (${bytes.length} bytes)`);
  return { fileID };
}

module.exports = { registerFile, computeFileId };
