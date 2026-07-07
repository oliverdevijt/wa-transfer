const { Client: AdbClient } = require('adb-ts');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);
const { createLogger } = require('../utils/logger');

const logger = createLogger('adb');

let cachedAdbPath = null;

// Resolves a usable adb binary even when it's not on PATH (common when Electron
// is launched from Explorer/a shortcut rather than a shell with platform-tools on PATH).
function resolveAdbPath() {
  if (cachedAdbPath) return cachedAdbPath;

  const exeName = process.platform === 'win32' ? 'adb.exe' : 'adb';
  const candidates = [];

  for (const root of [process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT]) {
    if (root) candidates.push(path.join(root, 'platform-tools', exeName));
  }

  if (process.platform === 'win32') {
    candidates.push(path.join(os.homedir(), 'AppData', 'Local', 'Android', 'Sdk', 'platform-tools', exeName));
  } else if (process.platform === 'darwin') {
    candidates.push(path.join(os.homedir(), 'Library', 'Android', 'sdk', 'platform-tools', exeName));
  } else {
    candidates.push(path.join(os.homedir(), 'Android', 'Sdk', 'platform-tools', exeName));
  }

  const found = candidates.find((c) => fs.existsSync(c));
  cachedAdbPath = found || 'adb';
  logger.info(found ? `Resolved adb path: ${found}` : 'adb not found via known SDK paths, falling back to PATH lookup');
  return cachedAdbPath;
}

function adbBin() {
  const p = resolveAdbPath();
  return p.includes(' ') ? `"${p}"` : p;
}

class AdbModule {
  constructor() {
    this.client = new AdbClient({ port: 5037, bin: resolveAdbPath() });
  }

  async scanDevices() {
    try {
      const devices = await this.client.listDevices();
      const result = [];
      for (const dev of devices) {
        try {
          const props = await this._getDeviceProps(dev.id);
          result.push({
            id: dev.id,
            model: props.model || dev.id,
            android: props.android || 'Unknown',
            hasWA: props.hasWA,
            hasWAB: props.hasWAB,
          });
        } catch (e) {
          result.push({ id: dev.id, model: dev.id, android: 'Unknown', hasWA: false, hasWAB: false });
        }
      }
      logger.info(`Found ${result.length} device(s)`);
      return { devices: result };
    } catch (err) {
      logger.error(`scanDevices failed: ${err.message}`);
      return { devices: [], error: err.message };
    }
  }

  async _getDeviceProps(deviceId) {
    const model = await this.client.getProp(deviceId, 'ro.product.model').catch(() => deviceId);
    const android = await this.client.getProp(deviceId, 'ro.build.version.release').catch(() => 'Unknown');
    const packages = await this.client.shell(deviceId, 'pm list packages').catch(() => '');
    const hasWA = packages.includes('com.whatsapp');
    const hasWAB = packages.includes('com.whatsapp.w4b');
    return { model, android, hasWA, hasWAB };
  }

  /**
   * Sideload legacy APK. Tries three methods in order:
   * 1. uninstall -k + fresh install (works on Android ≤ 11)
   * 2. push + pm install --allow-downgrade (sometimes works on Android 12-13)
   * 3. Fail with a clear explanation for Android 14 rollback protection
   */
  async installApk(serial, apkPath, appId, onProgress) {
    logger.info(`Installing legacy APK on ${serial} for ${appId}: ${apkPath}`);

    // Step 1: Uninstall current version but KEEP app data
    onProgress({ percent: 5, message: `Uninstalling current ${appId} (keeping data)...` });
    try {
      const r = await execAsync(`${adbBin()} -s ${serial} uninstall -k ${appId}`, { timeout: 30000 });
      logger.info(`Uninstall result: ${r.stdout}`);
    } catch (e) {
      logger.info(`Uninstall skipped: ${e.message}`);
    }

    // Method A: adb install (works on Android ≤ 11 after uninstall -k)
    onProgress({ percent: 12, message: 'Installing legacy APK...' });
    try {
      const r = await execAsync(`${adbBin()} -s ${serial} install "${apkPath}"`, { timeout: 120000 });
      if (!r.stdout.includes('FAILED') && !r.stderr.includes('FAILED')) {
        onProgress({ percent: 20, message: 'Legacy APK installed successfully.' });
        logger.info('APK installed via method A');
        return;
      }
    } catch (e) {
      logger.warn(`Method A failed: ${e.message}`);
    }

    // Method B: push to device then pm install --allow-downgrade (Android 12-13)
    onProgress({ percent: 15, message: 'Trying alternative install method...' });
    const remotePath = `/data/local/tmp/wa_legacy.apk`;
    try {
      await execAsync(`${adbBin()} -s ${serial} push "${apkPath}" ${remotePath}`, { timeout: 60000 });
      const r = await execAsync(
        `${adbBin()} -s ${serial} shell pm install --allow-downgrade -r -t "${remotePath}"`,
        { timeout: 120000 }
      );
      await execAsync(`${adbBin()} -s ${serial} shell rm "${remotePath}"`).catch(() => {});

      if (r.stdout.includes('Success') || r.stderr.includes('Success')) {
        onProgress({ percent: 20, message: 'Legacy APK installed (method B).' });
        logger.info('APK installed via method B');
        return;
      }
      throw new Error(r.stdout || r.stderr);
    } catch (e) {
      logger.warn(`Method B failed: ${e.message}`);
      await execAsync(`${adbBin()} -s ${serial} shell rm "${remotePath}"`).catch(() => {});
    }

    // Both methods failed — Android 12+ rollback protection
    throw new Error(
      'Android rollback protection is blocking the legacy APK install.\n\n' +
      'This occurs on Android 12+ when WhatsApp was previously installed at a higher version.\n\n' +
      'To work around this:\n' +
      '• Factory reset the device and install the legacy APK BEFORE installing modern WhatsApp, OR\n' +
      '• Use a second Android device that has never had WhatsApp installed, OR\n' +
      '• Enable root access to pull the key file directly from /data/data/com.whatsapp/files/key'
    );
  }

  /**
   * No-root extraction — mirrors the iCareFone/MobileTrans approach:
   * 1. Pull crypt15 from external storage via ADB (always accessible)
   * 2. Get key via `run-as` (works on Android ≤ 11 & some ROMs)
   * 3. If run-as blocked, try `adb backup` of our own helper to carry the key
   * 4. If all else fails, return crypt path + signal UI to ask for key manually
   */
  async extractNoRoot(serial, appId, outputDir, onProgress) {
    logger.info(`No-root extraction for ${appId} on ${serial}`);

    const isWAB = appId.includes('w4b');
    const mediaBase = isWAB
      ? `/sdcard/Android/media/com.whatsapp.w4b/WhatsApp Business/Databases`
      : `/sdcard/Android/media/com.whatsapp/Whatsapp/Databases`;

    // ── Step 1: Pull crypt15 from external storage ───────────────────────
    onProgress({ percent: 10, message: 'Scanning WhatsApp database folder...' });

    let remoteCrypt = null;
    let localCrypt = null;

    for (const ext of ['crypt15', 'crypt14', 'crypt12']) {
      const candidate = `${mediaBase}/msgstore.db.${ext}`;
      try {
        const r = await execAsync(`${adbBin()} -s ${serial} shell "ls '${candidate}' 2>/dev/null && echo OK"`, { timeout: 8000 });
        logger.info(`Checked ${candidate}: stdout="${r.stdout.trim()}" stderr="${r.stderr.trim()}"`);
        if (r.stdout.includes('OK')) { remoteCrypt = candidate; break; }
      } catch (e) {
        logger.warn(`Check failed for ${candidate}: ${e.message}`);
      }
    }

    if (!remoteCrypt) {
      throw new Error(
        'WhatsApp database not found on external storage.\n' +
        'Open WhatsApp → Settings → Chats → Chat Backup → Back Up Now, then try again.'
      );
    }

    onProgress({ percent: 20, message: `Pulling ${path.basename(remoteCrypt)}...` });
    localCrypt = path.join(outputDir, 'msgstore.db.' + remoteCrypt.split('.').pop());
    await execAsync(`${adbBin()} -s ${serial} pull "${remoteCrypt}" "${localCrypt}"`, { timeout: 120000 });

    if (!fs.existsSync(localCrypt)) throw new Error('Failed to pull database file.');
    logger.info(`Crypt pulled: ${localCrypt} (${fs.statSync(localCrypt).size} bytes)`);

    // ── Step 2: Get key via run-as (Android ≤ 11 / some ROMs) ────────────
    onProgress({ percent: 35, message: 'Attempting key extraction via run-as...' });
    const localKey = path.join(outputDir, 'key');

    try {
      const tmpKey = `/sdcard/wa_key_tmp_${Date.now()}`;
      const r = await execAsync(
        `${adbBin()} -s ${serial} shell "run-as ${appId} cp /data/data/${appId}/files/key /sdcard/ 2>&1 && echo COPIED"`,
        { timeout: 10000 }
      );
      if (r.stdout.includes('COPIED') || r.stderr.includes('COPIED')) {
        await execAsync(`${adbBin()} -s ${serial} pull /sdcard/key "${localKey}"`, { timeout: 10000 });
        await execAsync(`${adbBin()} -s ${serial} shell "rm /sdcard/key"`).catch(() => {});
      } else {
        // Try alternate path
        const r2 = await execAsync(
          `${adbBin()} -s ${serial} shell "run-as ${appId} sh -c 'cat /data/data/${appId}/files/key' > /sdcard/wa_key_tmp && echo DONE"`,
          { timeout: 10000 }
        );
        if (r2.stdout.includes('DONE')) {
          await execAsync(`${adbBin()} -s ${serial} pull /sdcard/wa_key_tmp "${localKey}"`, { timeout: 10000 });
          await execAsync(`${adbBin()} -s ${serial} shell "rm /sdcard/wa_key_tmp"`).catch(() => {});
        }
      }
    } catch (e) {
      logger.warn(`run-as method failed: ${e.message}`);
    }

    if (fs.existsSync(localKey) && fs.statSync(localKey).size >= 30) {
      logger.info('Key obtained via run-as');
      onProgress({ percent: 50, message: 'Key extracted successfully.' });
      return { keyPath: localKey, cryptPath: localCrypt, needsKey: false };
    }

    // ── Step 3: Try content provider dump ────────────────────────────────
    onProgress({ percent: 40, message: 'Trying content provider method...' });
    try {
      const tmpKey = `/sdcard/wa_cpkey_${Date.now()}`;
      await execAsync(
        `${adbBin()} -s ${serial} shell "cp /data/data/${appId}/files/key ${tmpKey} 2>/dev/null && chmod 644 ${tmpKey}"`,
        { timeout: 8000 }
      );
      await execAsync(`${adbBin()} -s ${serial} pull "${tmpKey}" "${localKey}"`, { timeout: 10000 });
      await execAsync(`${adbBin()} -s ${serial} shell "rm ${tmpKey}"`).catch(() => {});

      if (fs.existsSync(localKey) && fs.statSync(localKey).size >= 30) {
        logger.info('Key obtained via shell cp (permissive shell)');
        onProgress({ percent: 50, message: 'Key extracted via shell.' });
        return { keyPath: localKey, cryptPath: localCrypt, needsKey: false };
      }
    } catch (e) {
      logger.warn(`Shell cp method failed: ${e.message}`);
    }

    // ── Step 4: Return crypt only — UI will ask user for key manually ─────
    logger.info('All key methods failed — returning crypt only, needs manual key');
    onProgress({ percent: 50, message: 'Database pulled. Key file needed manually.' });
    return { cryptPath: localCrypt, needsKey: true };
  }

  /**
   * Check if device has root (su) access
   */
  async checkRoot(serial) {
    try {
      const r = await execAsync(`${adbBin()} -s ${serial} shell "su -c 'echo root_ok'"`, { timeout: 10000 });
      const ok = r.stdout.trim().includes('root_ok') || r.stderr.trim().includes('root_ok');
      logger.info(`Root check on ${serial}: ${ok ? 'ROOTED' : 'NOT ROOTED'}`);
      return ok;
    } catch (e) {
      logger.info(`Root check failed: ${e.message}`);
      return false;
    }
  }

  /**
   * Root extraction: pull key + crypt15 directly using su.
   * Works on any rooted device regardless of Android version.
   */
  async extractWithRoot(serial, appId, outputDir, onProgress) {
    logger.info(`Root extraction for ${appId} on ${serial}`);

    const packageName = appId; // e.g. com.whatsapp
    const keyRemote = `/data/data/${packageName}/files/key`;
    const keyLocal = path.join(outputDir, 'key');

    // Determine crypt15 path based on app type
    const mediaDir = appId.includes('w4b')
      ? `/sdcard/Android/media/com.whatsapp.w4b/WhatsApp Business/Databases`
      : `/sdcard/Android/media/com.whatsapp/Whatsapp/Databases`;

    // Step 1: Copy key to readable location using su
    onProgress({ percent: 10, message: 'Requesting root access to pull encryption key...' });
    const tmpKey = `/data/local/tmp/wa_key_${Date.now()}`;
    try {
      const r = await execAsync(
        `${adbBin()} -s ${serial} shell "su -c 'cp ${keyRemote} ${tmpKey} && chmod 644 ${tmpKey}'"`,
        { timeout: 15000 }
      );
      if (r.stderr && r.stderr.includes('Permission denied')) {
        throw new Error('Root access denied — tap "Grant" when Magisk/SuperSU prompts on your phone.');
      }
    } catch (e) {
      throw new Error(`Failed to access key file with root: ${e.message}`);
    }

    onProgress({ percent: 25, message: 'Pulling encryption key...' });
    await execAsync(`${adbBin()} -s ${serial} pull "${tmpKey}" "${keyLocal}"`, { timeout: 15000 });
    await execAsync(`${adbBin()} -s ${serial} shell "rm ${tmpKey}"`).catch(() => {});

    if (!fs.existsSync(keyLocal) || fs.statSync(keyLocal).size < 30) {
      throw new Error('Key file pull failed or file is too small.');
    }
    logger.info(`Key pulled: ${keyLocal} (${fs.statSync(keyLocal).size} bytes)`);

    // Step 2: Find the most recent crypt15 file
    onProgress({ percent: 40, message: 'Finding latest encrypted database...' });
    let cryptFile = null;

    // Check external media storage first (most common)
    const cryptRemote = `${mediaDir}/msgstore.db.crypt15`;
    const cryptLocal = path.join(outputDir, 'msgstore.db.crypt15');

    try {
      const lsResult = await execAsync(`${adbBin()} -s ${serial} shell "ls '${mediaDir}'"`, { timeout: 10000 });
      if (lsResult.stdout.includes('msgstore.db.crypt15')) {
        cryptFile = cryptRemote;
      } else if (lsResult.stdout.includes('msgstore.db.crypt14')) {
        cryptFile = `${mediaDir}/msgstore.db.crypt14`;
      } else if (lsResult.stdout.includes('msgstore.db.crypt12')) {
        cryptFile = `${mediaDir}/msgstore.db.crypt12`;
      }
    } catch (e) {
      logger.warn(`External storage ls failed: ${e.message}`);
    }

    // Fallback: internal storage via su
    if (!cryptFile) {
      onProgress({ percent: 45, message: 'Checking internal storage for database...' });
      const internalDb = `/data/data/${packageName}/databases/msgstore.db`;
      const tmpDb = `/data/local/tmp/wa_msgstore_${Date.now()}`;
      try {
        await execAsync(
          `${adbBin()} -s ${serial} shell "su -c 'cp ${internalDb} ${tmpDb} && chmod 644 ${tmpDb}'"`,
          { timeout: 15000 }
        );
        const dbLocal = path.join(outputDir, 'msgstore.db');
        await execAsync(`${adbBin()} -s ${serial} pull "${tmpDb}" "${dbLocal}"`, { timeout: 60000 });
        await execAsync(`${adbBin()} -s ${serial} shell "rm ${tmpDb}"`).catch(() => {});

        // Validate it's a SQLite file
        const magic = fs.readFileSync(dbLocal).slice(0, 15).toString('utf8');
        if (magic.startsWith('SQLite format 3')) {
          logger.info('Pulled plaintext msgstore.db directly via root — no decryption needed');
          return { dbPath: dbLocal, usedRoot: true, plaintext: true };
        }
      } catch (e) {
        logger.warn(`Internal db pull failed: ${e.message}`);
      }
    }

    if (!cryptFile) {
      throw new Error('Could not find msgstore.db.crypt15 on device. Make sure WhatsApp has been opened at least once.');
    }

    // Step 3: Pull the crypt file
    onProgress({ percent: 55, message: `Pulling encrypted database (${path.basename(cryptFile)})...` });
    await execAsync(`${adbBin()} -s ${serial} pull "${cryptFile}" "${cryptLocal}"`, { timeout: 120000 });

    if (!fs.existsSync(cryptLocal)) {
      throw new Error('Failed to pull encrypted database file.');
    }
    logger.info(`Crypt file pulled: ${cryptLocal} (${fs.statSync(cryptLocal).size} bytes)`);

    onProgress({ percent: 70, message: 'Files pulled. Ready for decryption.' });
    return { keyPath: keyLocal, cryptPath: cryptLocal, usedRoot: true, plaintext: false };
  }

  /**
   * Run adb backup for the given app. User must confirm on device.
   */
  async startBackup(serial, appId, outputDir, onProgress) {
    logger.info(`Starting ADB backup for ${appId} on ${serial}`);
    const backupFile = path.join(outputDir, `${appId.replace(/\./g, '_')}.ab`);

    // Remove stale backup if present
    if (fs.existsSync(backupFile)) fs.unlinkSync(backupFile);

    onProgress({ percent: 25, message: 'Starting ADB backup — confirm on phone screen when prompted...' });

    // adb backup -nowapk: don't include the APK itself, just data
    await execAsync(
      `${adbBin()} -s ${serial} backup -nowapk -noshared ${appId} -f "${backupFile}"`,
      { timeout: 300000 }
    );

    onProgress({ percent: 80, message: 'Backup received, verifying...' });

    if (!fs.existsSync(backupFile)) {
      throw new Error('Backup file was not created. Did you confirm on your phone?');
    }

    const stat = fs.statSync(backupFile);
    logger.info(`Backup file size: ${stat.size} bytes`);

    if (stat.size < 100) {
      throw new Error(
        'Backup is empty (0 bytes). The legacy APK must be installed first — ' +
        'modern WhatsApp disables backups. Provide the APK file and try again.'
      );
    }
    if (stat.size < 5000) {
      throw new Error(
        `Backup too small (${stat.size} bytes) — backup may have been cancelled or ` +
        'WhatsApp data was not included. Try again and tap "Back up my data" on the phone.'
      );
    }

    onProgress({ percent: 90, message: `Backup saved (${(stat.size / 1024 / 1024).toFixed(1)} MB)` });
    logger.info(`Backup saved: ${backupFile}`);
    return backupFile;
  }
}

module.exports = { AdbModule };
