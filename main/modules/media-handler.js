const fs = require('fs');
const path = require('path');
const { createLogger } = require('../utils/logger');

const logger = createLogger('media-handler');

async function copyMediaFiles(androidMediaRoot, iosBackupMediaDir, messages) {
  const results = { copied: 0, missing: 0, total: 0 };

  for (const msg of messages) {
    if (!msg.media_mime_type || !msg.media_name) continue;
    results.total++;

    const srcPath = path.join(androidMediaRoot, msg.media_name);
    if (fs.existsSync(srcPath)) {
      const destPath = path.join(iosBackupMediaDir, path.basename(msg.media_name));
      try {
        fs.copyFileSync(srcPath, destPath);
        results.copied++;
      } catch (e) {
        logger.warn(`Failed to copy ${srcPath}: ${e.message}`);
        results.missing++;
      }
    } else {
      results.missing++;
    }
  }

  logger.info(`Media: ${results.copied} copied, ${results.missing} missing out of ${results.total}`);
  return results;
}

module.exports = { copyMediaFiles };
