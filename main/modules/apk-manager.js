const fs = require('fs');
const path = require('path');
const crypto = require('node:crypto');
const axios = require('axios');
const { createLogger } = require('../utils/logger');

const logger = createLogger('apk-manager');

// Known good SHA-256 hash for WhatsApp 2.19.291 APK
const KNOWN_APK_HASH = null; // Set when known hash is available

const APK_CACHE_DIR = path.join(process.resourcesPath || path.join(__dirname, '../../'), 'assets', 'apk-cache');
const APK_FILENAME = 'WhatsApp-2.19.291.apk';

function getApkPath() {
  return path.join(APK_CACHE_DIR, APK_FILENAME);
}

function isApkCached() {
  return fs.existsSync(getApkPath());
}

function verifyApkHash(apkPath) {
  if (!KNOWN_APK_HASH) return true; // Skip if hash not configured
  const buffer = fs.readFileSync(apkPath);
  const hash = crypto.createHash('sha256').update(buffer).digest('hex');
  return hash === KNOWN_APK_HASH;
}

async function ensureApkAvailable(userSuppliedPath) {
  if (userSuppliedPath) {
    if (!fs.existsSync(userSuppliedPath)) {
      throw new Error(`APK not found at: ${userSuppliedPath}`);
    }
    logger.info(`Using user-supplied APK: ${userSuppliedPath}`);
    return userSuppliedPath;
  }

  if (isApkCached()) {
    logger.info('Using cached APK');
    return getApkPath();
  }

  throw new Error(
    'Legacy WhatsApp APK not found in cache. Please supply the APK file manually. ' +
    'You need WhatsApp version 2.19.291 or earlier.'
  );
}

module.exports = { ensureApkAvailable, isApkCached, getApkPath };
