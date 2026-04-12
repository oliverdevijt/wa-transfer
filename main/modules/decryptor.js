const crypto = require('node:crypto');
const fs = require('fs');
const zlib = require('zlib');
const path = require('path');
const AdmZip = require('adm-zip');
const { createLogger } = require('../utils/logger');

const logger = createLogger('decryptor');

/**
 * Extract key file and crypt15 db from .ab backup file
 */
async function extractFromAbBackup(abPath, outputDir) {
  logger.info(`Extracting from .ab file: ${abPath}`);

  const abBuffer = fs.readFileSync(abPath);

  // ADB backup format: 24-byte header + zlib compressed tar
  // Header: "ANDROID BACKUP\n" + version + compression flag + encryption type + "\n"
  const header = abBuffer.slice(0, 24).toString('utf8');
  if (!header.startsWith('ANDROID BACKUP')) {
    throw new Error('Not a valid ADB backup file');
  }

  // Find the start of zlib data (after header lines)
  let zlibStart = 0;
  let newlineCount = 0;
  for (let i = 0; i < 100; i++) {
    if (abBuffer[i] === 0x0a) {
      newlineCount++;
      if (newlineCount === 4) {
        zlibStart = i + 1;
        break;
      }
    }
  }

  logger.info(`Zlib data starts at offset ${zlibStart}`);

  // Decompress
  const compressed = abBuffer.slice(zlibStart);
  let tarBuffer;
  try {
    tarBuffer = zlib.inflateSync(compressed);
  } catch (e) {
    throw new Error(`Failed to decompress backup: ${e.message}. Make sure backup was created without a password.`);
  }

  // Parse tar to find key and db files
  const keyPath = path.join(outputDir, 'key');
  const cryptPath = path.join(outputDir, 'msgstore.db.crypt15');

  parseTarBuffer(tarBuffer, outputDir, keyPath, cryptPath);

  if (!fs.existsSync(keyPath)) throw new Error('Key file not found in backup');
  if (!fs.existsSync(cryptPath)) throw new Error('msgstore.db.crypt15 not found in backup');

  logger.info('Extracted key and crypt15 successfully');
  return { keyPath, cryptPath };
}

function parseTarBuffer(buffer, outputDir, keyPath, cryptPath) {
  let offset = 0;
  while (offset + 512 <= buffer.length) {
    const name = buffer.slice(offset, offset + 100).toString('utf8').replace(/\0/g, '');
    if (!name) break;

    const sizeOctal = buffer.slice(offset + 124, offset + 136).toString('utf8').replace(/\0/g, '').trim();
    const size = parseInt(sizeOctal, 8) || 0;
    const dataStart = offset + 512;

    if (name.includes('/f/key') || name.endsWith('/key')) {
      fs.writeFileSync(keyPath, buffer.slice(dataStart, dataStart + size));
      logger.info(`Extracted key file (${size} bytes)`);
    } else if (name.includes('msgstore.db.crypt15')) {
      fs.writeFileSync(cryptPath, buffer.slice(dataStart, dataStart + size));
      logger.info(`Extracted crypt15 (${size} bytes)`);
    }

    // Advance to next tar entry (512-byte aligned)
    const blocks = Math.ceil(size / 512);
    offset += 512 + blocks * 512;
  }
}

/**
 * Decrypt crypt15 file using the key file
 */
async function decryptCrypt15(keyFilePath, crypt15Path, outputPath) {
  logger.info('Decrypting crypt15...');

  const keyBuffer = fs.readFileSync(keyFilePath);
  const crypt15Buffer = fs.readFileSync(crypt15Path);

  // Key file: bytes 30-62 contain the 32-byte AES key (0-indexed: 30 to 30+32=62)
  if (keyBuffer.length < 62) {
    throw new Error(`Key file too short: ${keyBuffer.length} bytes (expected >= 62)`);
  }
  const aesKey = keyBuffer.slice(30, 62);

  // crypt15: bytes 8-24 contain the 12-byte IV (GCM nonce)
  if (crypt15Buffer.length < 67) {
    throw new Error(`crypt15 file too short: ${crypt15Buffer.length} bytes`);
  }
  const iv = crypt15Buffer.slice(8, 24); // 16 bytes but GCM uses 12

  // The actual ciphertext starts after a 67-byte header
  // The last 16 bytes are the GCM auth tag
  const ciphertext = crypt15Buffer.slice(67, crypt15Buffer.length - 16);
  const authTag = crypt15Buffer.slice(crypt15Buffer.length - 16);

  // Use first 12 bytes of IV for GCM
  const decipher = crypto.createDecipheriv('aes-256-gcm', aesKey, iv.slice(0, 12));
  decipher.setAuthTag(authTag);

  let decrypted;
  try {
    decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch (e) {
    throw new Error(`Decryption failed: ${e.message}. Key may not match this database.`);
  }

  // Validate SQLite magic bytes
  const magic = decrypted.slice(0, 16).toString('utf8');
  if (!magic.startsWith('SQLite format 3')) {
    throw new Error('Decrypted file is not a valid SQLite database. Wrong key?');
  }

  fs.writeFileSync(outputPath, decrypted);
  logger.info(`Decrypted database saved: ${outputPath} (${decrypted.length} bytes)`);
  return outputPath;
}

module.exports = { extractFromAbBackup, decryptCrypt15 };
