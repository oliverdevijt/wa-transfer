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

// -- Minimal protobuf reader (just enough to pull nested length-delimited fields) --

function readVarint(buf, offset) {
  let result = 0, shift = 0, pos = offset;
  while (true) {
    const b = buf[pos++];
    result |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) break;
    shift += 7;
  }
  return { value: result, next: pos };
}

function readProtoFields(buf) {
  const fields = [];
  let offset = 0;
  while (offset < buf.length) {
    const tagRes = readVarint(buf, offset);
    const fieldNum = tagRes.value >>> 3;
    const wireType = tagRes.value & 0x7;
    offset = tagRes.next;
    if (wireType === 0) {
      const v = readVarint(buf, offset);
      fields.push({ fieldNum, wireType, value: v.value });
      offset = v.next;
    } else if (wireType === 2) {
      const lenRes = readVarint(buf, offset);
      offset = lenRes.next;
      fields.push({ fieldNum, wireType, value: buf.slice(offset, offset + lenRes.value) });
      offset += lenRes.value;
    } else if (wireType === 1) {
      fields.push({ fieldNum, wireType, value: buf.slice(offset, offset + 8) });
      offset += 8;
    } else if (wireType === 5) {
      fields.push({ fieldNum, wireType, value: buf.slice(offset, offset + 4) });
      offset += 4;
    } else {
      throw new Error(`Unsupported protobuf wire type ${wireType}`);
    }
  }
  return fields;
}

// Descends into nested length-delimited fields, e.g. path [2, 5] == BackupPrefix.c14_cipher.IV
function getNestedProtoBytes(buf, path) {
  let current = buf;
  for (const fieldNum of path) {
    const match = readProtoFields(current).find((f) => f.fieldNum === fieldNum && f.wireType === 2);
    if (!match) throw new Error(`Could not find protobuf field ${fieldNum} while resolving header path [${path.join(',')}]`);
    current = match.value;
  }
  return current;
}

// WhatsApp key files are a Java-serialized byte[] (ObjectOutputStream). Unwraps to the raw payload.
function unwrapJavaByteArray(buffer) {
  if (buffer.length < 27 || buffer.readUInt16BE(0) !== 0xaced) {
    return buffer; // not Java-serialized — treat as already raw
  }
  const arrLen = buffer.readUInt32BE(23);
  return buffer.slice(27, 27 + arrLen);
}

// crypt15 key files store a 32-byte "root key"; the actual AES key is derived via a single
// HMAC-SHA256 iteration keyed off it (mirrors WhatsApp's own encryptionloop()/HKDF-like scheme).
function deriveCrypt15Key(rootKey) {
  const privateKey = crypto.createHmac('sha256', Buffer.alloc(32)).update(rootKey).digest();
  const hasher = crypto.createHmac('sha256', privateKey);
  hasher.update(Buffer.alloc(0));
  hasher.update(Buffer.from('backup encryption', 'utf8'));
  hasher.update(Buffer.from([0x01]));
  return hasher.digest();
}

// crypt14/15 files start with: 1-byte protobuf size, optional 1-byte feature-table flag (0x01),
// then the protobuf header itself, then the AES-GCM ciphertext.
function parseBackupHeader(buffer) {
  const protobufSize = buffer[0];
  const offset = buffer[1] === 1 ? 2 : 1;
  return { header: buffer.slice(offset, offset + protobufSize), cipherStart: offset + protobufSize };
}

/**
 * Decrypt a crypt14 or crypt15 WhatsApp database using its key file.
 */
async function decryptCrypt15(keyFilePath, cryptPath, outputPath) {
  const isCrypt15 = /\.crypt15$/i.test(cryptPath);
  const isCrypt14 = /\.crypt14$/i.test(cryptPath);
  if (!isCrypt15 && !isCrypt14) {
    throw new Error(`Unsupported backup format: ${path.basename(cryptPath)} (only .crypt14 and .crypt15 are supported)`);
  }
  logger.info(`Decrypting ${isCrypt15 ? 'crypt15' : 'crypt14'}...`);

  const keyPayload = unwrapJavaByteArray(fs.readFileSync(keyFilePath));
  const data = fs.readFileSync(cryptPath);
  const { header, cipherStart } = parseBackupHeader(data);

  let aesKey, iv;
  if (isCrypt14) {
    if (keyPayload.length < 131) throw new Error(`Key file too short for crypt14 (${keyPayload.length} bytes, expected 131)`);
    aesKey = keyPayload.slice(99, 131); // BackupPrefix.c14_cipher: version(2)+keyver(1)+salt(32)+googleid(16)+hash(32)+iv_padding(16)+key(32)
    iv = getNestedProtoBytes(header, [2, 5]); // BackupPrefix.c14_cipher.IV
  } else {
    if (keyPayload.length !== 32) throw new Error(`Key file should be 32 bytes for crypt15 (got ${keyPayload.length})`);
    aesKey = deriveCrypt15Key(keyPayload);
    iv = getNestedProtoBytes(header, [3, 1]); // BackupPrefix.c15_iv.IV
  }
  if (iv.length !== 16) throw new Error(`Expected 16-byte IV, got ${iv.length}`);

  // Last 32 bytes: [-32:-16] is the GCM auth tag, [-16:] is a trailing MD5 checksum (not needed for decryption).
  const ciphertext = data.slice(cipherStart, data.length - 32);
  const authTag = data.slice(data.length - 32, data.length - 16);

  const decipher = crypto.createDecipheriv('aes-256-gcm', aesKey, iv);
  decipher.setAuthTag(authTag);

  let decrypted;
  try {
    decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch (e) {
    throw new Error(`Decryption failed: ${e.message}. Key may not match this database.`);
  }

  // The plaintext database is zlib-compressed.
  let plaintext = decrypted;
  if (decrypted[0] === 0x78) {
    try {
      plaintext = zlib.inflateSync(decrypted);
    } catch (e) {
      throw new Error(`Decompression failed: ${e.message}`);
    }
  }

  const magic = plaintext.slice(0, 16).toString('utf8');
  if (!magic.startsWith('SQLite format 3')) {
    throw new Error('Decrypted file is not a valid SQLite database. Wrong key?');
  }

  fs.writeFileSync(outputPath, plaintext);
  logger.info(`Decrypted database saved: ${outputPath} (${plaintext.length} bytes)`);
  return outputPath;
}

module.exports = { extractFromAbBackup, decryptCrypt15 };
