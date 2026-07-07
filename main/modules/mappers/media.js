const fs = require('fs');
const path = require('path');
const { registerFile } = require('../ios-backup-writer');
const { MEDIA_RELATIVE_PATH_PREFIX } = require('./constants');
const { createLogger } = require('../../utils/logger');

const logger = createLogger('media-mapper');

function mapMedia(row, ctx) {
  if (!row.file_path) return null;
  return {
    zpk: ctx.nextZpk,
    entityId: ctx.entityIds.WAMediaItem,
    fileSize: row.media_size || 0,
    aspectRatio: row.width && row.height ? row.width / row.height : 0,
    movieDuration: row.media_duration || 0,
    sourceFilePath: row.file_path,
  };
}

function insertMedia(db, insertStmt, manifestDb, row, messageZpk, ctx) {
  const mapped = mapMedia(row, ctx);
  if (!mapped) return null;

  const localSourcePath = path.join(ctx.pulledMediaRoot, mapped.sourceFilePath);
  let iosRelativePath = null;
  let missing = true;

  if (fs.existsSync(localSourcePath)) {
    const bytes = fs.readFileSync(localSourcePath);
    const filename = path.basename(mapped.sourceFilePath);
    iosRelativePath = `${MEDIA_RELATIVE_PATH_PREFIX}/${filename}`;
    try {
      registerFile(ctx.backupPath, manifestDb, ctx.mediaDomain, iosRelativePath, bytes);
      missing = false;
    } catch (e) {
      logger.warn(`Failed to register media file ${mapped.sourceFilePath}: ${e.message}`);
    }
  } else {
    logger.warn(`Media file missing on device, skipping bytes: ${mapped.sourceFilePath}`);
  }

  try {
    insertStmt.run(
      mapped.zpk, mapped.entityId, messageZpk, mapped.fileSize,
      mapped.aspectRatio, mapped.movieDuration, iosRelativePath
    );
  } catch (e) {
    return null;
  }
  return { zpk: mapped.zpk, missing };
}

module.exports = { mapMedia, insertMedia };
