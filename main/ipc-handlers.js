const { dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { AdbModule } = require('./modules/adb');
const { decryptCrypt15, extractFromAbBackup } = require('./modules/decryptor');
const { parseAndroidDb } = require('./modules/android-parser');
const { detectIosBackup } = require('./modules/ios-injector');
const { mergeSchemas } = require('./modules/schema-mapper');
const { patchManifest } = require('./modules/manifest-patcher');
const { getLogLines } = require('./utils/logger');
const { getTempDir } = require('./utils/temp-manager');

let adbModule = null;

function getAdb() {
  if (!adbModule) adbModule = new AdbModule();
  return adbModule;
}

function setupIpcHandlers(ipcMain, getWindow) {
  // Scan for connected Android devices
  ipcMain.handle('adb:scan-devices', async () => {
    try {
      return await getAdb().scanDevices();
    } catch (err) {
      return { error: err.message };
    }
  });

  // Install legacy APK — uninstall -k then fresh install (bypasses version downgrade block)
  ipcMain.handle('adb:install-apk', async (_, { serial, apkPath, appId }) => {
    try {
      const win = getWindow();
      await getAdb().installApk(serial, apkPath, appId, (progress) => {
        win?.webContents.send('adb:backup-progress', progress);
      });
      return { success: true };
    } catch (err) {
      return { error: `APK install failed: ${err.message}` };
    }
  });

  // No-root extraction: pull crypt15 via ADB, try run-as for key
  ipcMain.handle('adb:noroot-extract', async (_, { serial, appId, manualKeyPath }) => {
    try {
      const win = getWindow();
      const tmpDir = getTempDir();
      const push = (p) => win?.webContents.send('adb:backup-progress', p);

      const result = await getAdb().extractNoRoot(serial, appId, tmpDir, push);

      if (result.needsKey) {
        // Key not obtained automatically — check if user supplied one manually
        if (manualKeyPath && fs.existsSync(manualKeyPath)) {
          result.keyPath = manualKeyPath;
          result.needsKey = false;
        } else {
          return { needsKey: true, cryptPath: result.cryptPath };
        }
      }

      push({ percent: 75, message: 'Decrypting database...' });
      const dbPath = path.join(tmpDir, 'msgstore.db');
      await decryptCrypt15(result.keyPath, result.cryptPath, dbPath);

      push({ percent: 100, message: 'Done!' });
      return { dbPath };
    } catch (err) {
      return { error: err.message };
    }
  });

  // Check if device has root (su) access
  ipcMain.handle('adb:check-root', async (_, { serial }) => {
    try {
      const hasRoot = await getAdb().checkRoot(serial);
      return { hasRoot };
    } catch (err) {
      return { hasRoot: false, error: err.message };
    }
  });

  // Root extraction: pull key + crypt15 directly via su, then decrypt
  ipcMain.handle('adb:root-extract-decrypt', async (_, { serial, appId }) => {
    try {
      const win = getWindow();
      const tmpDir = getTempDir();
      const push = (p) => win?.webContents.send('adb:backup-progress', p);

      push({ percent: 5, message: 'Starting root extraction...' });
      const result = await getAdb().extractWithRoot(serial, appId, tmpDir, push);

      if (result.plaintext) {
        // Already a plain SQLite file — no decryption needed
        push({ percent: 100, message: 'Database pulled successfully (plaintext).' });
        return { dbPath: result.dbPath };
      }

      // Decrypt crypt file
      push({ percent: 80, message: 'Decrypting database...' });
      const dbPath = path.join(tmpDir, 'msgstore.db');
      await decryptCrypt15(result.keyPath, result.cryptPath, dbPath);

      push({ percent: 100, message: 'Decryption complete!' });
      return { dbPath };
    } catch (err) {
      return { error: err.message };
    }
  });

  // Full pipeline: backup → extract from .ab → decrypt crypt15 → return db path
  ipcMain.handle('adb:backup-extract-decrypt', async (_, { serial, appId }) => {
    try {
      const win = getWindow();
      const tmpDir = getTempDir();

      const push = (p) => win?.webContents.send('adb:backup-progress', p);

      // Step 1: ADB backup
      push({ percent: 25, message: 'Starting ADB backup — confirm on phone...' });
      const backupPath = await getAdb().startBackup(serial, appId, tmpDir, push);

      // Step 2: Extract key + crypt15 from .ab archive
      push({ percent: 90, message: 'Extracting key and database from backup archive...' });
      const { keyPath, cryptPath } = await extractFromAbBackup(backupPath, tmpDir);

      // Step 3: Decrypt crypt15 → msgstore.db
      push({ percent: 95, message: 'Decrypting database...' });
      const dbPath = path.join(tmpDir, 'msgstore.db');
      await decryptCrypt15(keyPath, cryptPath, dbPath);

      push({ percent: 100, message: 'Extraction complete!' });
      return { dbPath };
    } catch (err) {
      return { error: err.message };
    }
  });

  // Parse the decrypted Android SQLite db
  ipcMain.handle('db:parse-android', async (_, { dbPath }) => {
    try {
      return await parseAndroidDb(dbPath);
    } catch (err) {
      return { error: err.message };
    }
  });

  // Detect iTunes backup on this PC
  ipcMain.handle('ios:detect-backup', async () => {
    try {
      return await detectIosBackup();
    } catch (err) {
      return { error: err.message };
    }
  });

  // Merge Android schema into iOS backup
  ipcMain.handle('ios:merge-schema', async (_, { androidDbPath, iosBackupId, includeMedia }) => {
    try {
      const win = getWindow();
      return await mergeSchemas(androidDbPath, iosBackupId, includeMedia, (progress) => {
        win?.webContents.send('ios:merge-progress', progress);
      });
    } catch (err) {
      return { error: err.message };
    }
  });

  // Patch Manifest.db with new SHA-1 hashes
  ipcMain.handle('ios:patch-manifest', async (_, { backupId }) => {
    try {
      return await patchManifest(backupId);
    } catch (err) {
      return { error: err.message };
    }
  });

  ipcMain.handle('app:get-log', async () => {
    try {
      return { lines: getLogLines(500) };
    } catch (err) {
      return { error: err.message };
    }
  });

  ipcMain.handle('app:open-folder', async (_, { path: folderPath }) => {
    shell.openPath(folderPath);
    return { success: true };
  });

  ipcMain.handle('app:select-file', async (_, { filters }) => {
    const win = getWindow();
    const result = await dialog.showOpenDialog(win, {
      properties: ['openFile'],
      filters: filters || [],
    });
    return result.canceled ? null : result.filePaths[0];
  });
}

module.exports = { setupIpcHandlers };
