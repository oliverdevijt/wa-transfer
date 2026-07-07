const fs = require('fs');
const path = require('path');
const os = require('os');
const { createLogger } = require('../utils/logger');

const logger = createLogger('ios-injector');

const BACKUP_BASE = path.join(
  os.homedir(),
  'AppData', 'Roaming', 'Apple Computer', 'MobileSync', 'Backup'
);

async function detectIosBackup() {
  logger.info('Scanning for iTunes backups...');

  if (!fs.existsSync(BACKUP_BASE)) {
    return { error: 'iTunes backup folder not found. Is iTunes (Win32 version) installed?' };
  }

  const dirs = fs.readdirSync(BACKUP_BASE).filter(d => {
    const full = path.join(BACKUP_BASE, d);
    return fs.statSync(full).isDirectory();
  });

  if (dirs.length === 0) {
    return { error: 'No iTunes backups found. Please back up your iPhone first.' };
  }

  const backups = [];
  for (const dir of dirs) {
    const infoPath = path.join(BACKUP_BASE, dir, 'Info.plist');
    if (!fs.existsSync(infoPath)) continue;

    try {
      const plist = require('plist');
      const info = plist.parse(fs.readFileSync(infoPath, 'utf8'));
      const hasWA = checkHasWhatsApp(dir);
      backups.push({
        backupId: dir,
        deviceName: info['Device Name'] || 'Unknown Device',
        timestamp: info['Last Backup Date'] || null,
        hasWhatsApp: hasWA,
      });
    } catch (e) {
      logger.warn(`Could not parse backup ${dir}: ${e.message}`);
    }
  }

  const best = backups.find(b => b.hasWhatsApp) || backups[0];
  if (!best) return { error: 'No valid backups found' };

  logger.info(`Found backup: ${best.backupId} (${best.deviceName})`);
  return best;
}

function checkHasWhatsApp(backupId) {
  const manifestPath = path.join(BACKUP_BASE, backupId, 'Manifest.db');
  if (!fs.existsSync(manifestPath)) return false;

  try {
    const Database = require('better-sqlite3');
    const db = new Database(manifestPath, { readonly: true });
    const row = db.prepare(
      `SELECT fileID FROM Files WHERE domain LIKE '%whatsapp%' LIMIT 1`
    ).get();
    db.close();
    return !!row;
  } catch (_) {
    return false;
  }
}

function getBackupPath(backupId) {
  return path.join(BACKUP_BASE, backupId);
}

function getWhatsAppDbPath(backupId, isBusinessApp) {
  const domain = isBusinessApp
    ? 'AppDomain-net.WhatsApp.WhatsApp4B'
    : 'AppDomain-net.whatsapp.WhatsApp';

  const manifestPath = path.join(BACKUP_BASE, backupId, 'Manifest.db');
  const db = new Database(manifestPath, { readonly: true });

  const row = db.prepare(
    `SELECT fileID, relativePath FROM Files
     WHERE domain = ? AND relativePath LIKE '%ChatStorage.sqlite'
     LIMIT 1`
  ).get(domain);
  db.close();

  if (!row) throw new Error(`ChatStorage.sqlite not found for domain ${domain}`);

  const prefix = row.fileID.slice(0, 2);
  return {
    fileId: row.fileID,
    filePath: path.join(BACKUP_BASE, backupId, prefix, row.fileID),
    relativePath: row.relativePath,
    domain,
  };
}

module.exports = { detectIosBackup, getBackupPath, getWhatsAppDbPath };
