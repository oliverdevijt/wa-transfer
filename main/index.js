const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const os = require('os');
const { setupIpcHandlers } = require('./ipc-handlers');
const { cleanupTemp } = require('./utils/temp-manager');
const { createLogger } = require('./utils/logger');

const logger = createLogger('main');

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 750,
    minWidth: 900,
    minHeight: 600,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
    titleBarStyle: 'default',
    title: 'WA Transfer',
    backgroundColor: '#0f172a',
  });

  if (!app.isPackaged) {
    mainWindow.loadURL('http://localhost:3737');
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
  }

  mainWindow.on('closed', () => { mainWindow = null; });
}

app.whenReady().then(() => {
  createWindow();
  setupIpcHandlers(ipcMain, () => mainWindow);
  app.on('activate', () => { if (!mainWindow) createWindow(); });
});

app.on('window-all-closed', async () => {
  await cleanupTemp();
  if (process.platform !== 'darwin') app.quit();
});
