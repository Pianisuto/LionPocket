import { app, BrowserWindow } from 'electron';
import path from 'node:path';
import started from 'electron-squirrel-startup';
import { LionPocketDatabase } from './main/database';
import { registerIpcHandlers } from './main/ipc';

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
if (started) {
  app.quit();
}

// Some Linux video drivers fail while Electron is starting. Software rendering
// keeps the interface reliable and is more than enough for this application.
app.disableHardwareAcceleration();

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
}

let database: LionPocketDatabase;
let mainWindow: BrowserWindow | null = null;

const showMainWindow = () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
};

app.on('second-instance', showMainWindow);

const createWindow = () => {
  const createdWindow = new BrowserWindow({
    title: 'LionPocket',
    width: 1440,
    height: 920,
    minWidth: 1080,
    minHeight: 720,
    backgroundColor: '#F4F5EF',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow = createdWindow;
  createdWindow.setMenuBarVisibility(false);
  createdWindow.once('ready-to-show', showMainWindow);
  createdWindow.once('closed', () => {
    if (mainWindow === createdWindow) mainWindow = null;
  });
  createdWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  createdWindow.webContents.once('did-finish-load', () => {
    createdWindow.webContents.setZoomFactor(1);
  });
  createdWindow.webContents.on('before-input-event', (event, input) => {
    const modifierPressed = input.control || input.meta;
    if (!modifierPressed || input.alt || input.type !== 'keyDown') return;

    const zoomIn = input.key === '=' || input.key === '+' || input.code === 'NumpadAdd';
    const zoomOut = input.key === '-' || input.key === '_' || input.code === 'NumpadSubtract';
    const resetZoom = input.key === '0' || input.code === 'Numpad0';
    if (!zoomIn && !zoomOut && !resetZoom) return;

    event.preventDefault();
    const currentZoom = createdWindow.webContents.getZoomFactor();
    if (resetZoom) {
      createdWindow.webContents.setZoomFactor(1);
      return;
    }

    const direction = zoomIn ? 0.1 : -0.1;
    const nextZoom = Math.min(2, Math.max(0.6, Math.round((currentZoom + direction) * 10) / 10));
    createdWindow.webContents.setZoomFactor(nextZoom);
  });

  // and load the index.html of the app.
  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    createdWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    createdWindow.loadFile(
      path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`),
    );
  }
};

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(() => {
  const databasePath = path.join(app.getPath('userData'), 'lionpocket.sqlite');
  database = new LionPocketDatabase(databasePath);
  registerIpcHandlers(database);
  createWindow();
});

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  // On OS X it's common to re-create a window in the app when the
  // dock icon is clicked and there are no other windows open.
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and import them here.
