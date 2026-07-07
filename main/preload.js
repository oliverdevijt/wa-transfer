const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // ADB
  scanDevices: () => ipcRenderer.invoke('adb:scan-devices'),
  installApk: (serial, apkPath, appId) => ipcRenderer.invoke('adb:install-apk', { serial, apkPath, appId }),
  backupExtractDecrypt: (serial, appId) => ipcRenderer.invoke('adb:backup-extract-decrypt', { serial, appId }),
  checkRoot: (serial) => ipcRenderer.invoke('adb:check-root', { serial }),
  rootExtractDecrypt: (serial, appId) => ipcRenderer.invoke('adb:root-extract-decrypt', { serial, appId }),
  norootExtract: (serial, appId, manualKeyPath) => ipcRenderer.invoke('adb:noroot-extract', { serial, appId, manualKeyPath }),

  // DB
  parseAndroid: (dbPath) => ipcRenderer.invoke('db:parse-android', { dbPath }),

  // iOS
  detectBackup: () => ipcRenderer.invoke('ios:detect-backup'),
  mergeSchema: (androidDbPath, iosBackupId, includeMedia) =>
    ipcRenderer.invoke('ios:merge-schema', { androidDbPath, iosBackupId, includeMedia }),
  patchManifest: (backupId) => ipcRenderer.invoke('ios:patch-manifest', { backupId }),

  // App
  getLog: () => ipcRenderer.invoke('app:get-log'),
  openFolder: (folderPath) => ipcRenderer.invoke('app:open-folder', { path: folderPath }),
  selectFile: (filters) => ipcRenderer.invoke('app:select-file', { filters }),

  // Event listeners
  on: (channel, callback) => {
    const validChannels = [
      'adb:backup-progress',
      'ios:merge-progress',
      'ios:restore-progress',
      'app:error',
    ];
    if (validChannels.includes(channel)) {
      const sub = (_event, ...args) => callback(...args);
      ipcRenderer.on(channel, sub);
      return () => ipcRenderer.removeListener(channel, sub);
    }
  },
  removeAllListeners: (channel) => ipcRenderer.removeAllListeners(channel),
});
