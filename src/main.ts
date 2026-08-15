import { existsSync } from 'node:fs';
import path from 'node:path';
import { app, autoUpdater, BrowserWindow, dialog } from 'electron';
import started from 'electron-squirrel-startup';
import { LionPocketDatabase } from './main/database';
import { registerIpcHandlers } from './main/ipc';

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
if (started) {
  app.quit();
}

// The GPU sandbox blocks the NVIDIA GBM driver on some Linux distributions.
// Keep acceleration enabled and relax only the GPU process sandbox there.
if (process.platform === 'linux') {
  app.commandLine.appendSwitch('disable-gpu-sandbox');
}

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

/** Empacotado o ícone vive em resources/; em desenvolvimento, em assets/. */
const iconPath = () =>
  app.isPackaged
    ? path.join(process.resourcesPath, 'icon.png')
    : path.join(__dirname, '../../assets/icon.png');

/**
 * A versão portátil também é `app.isPackaged`, mas não possui a infraestrutura
 * do Squirrel.Windows. Só habilitamos atualização automática quando Update.exe
 * existe ao lado da pasta versionada criada pelo instalador.
 */
const isSquirrelInstall = () => {
  if (process.platform !== 'win32' || !app.isPackaged) return false;
  const updateExe = path.resolve(path.dirname(process.execPath), '..', 'Update.exe');
  return existsSync(updateExe);
};

const configureAutoUpdates = () => {
  if (!isSquirrelInstall() || process.argv.includes('--squirrel-firstrun')) return;

  const feedUrl = `https://update.electronjs.org/Pianisuto/LionPocket/${process.platform}-${process.arch}/${app.getVersion()}`;
  autoUpdater.setFeedURL({ url: feedUrl });

  autoUpdater.on('error', (error) => {
    // Atualização não deve impedir o app de abrir ou funcionar offline.
    console.warn('Falha ao verificar atualização do LionPocket:', error);
  });

  autoUpdater.on('update-downloaded', () => {
    void dialog
      .showMessageBox({
        type: 'info',
        title: 'Atualização pronta',
        message: 'Uma nova versão do LionPocket foi baixada.',
        detail: 'Reinicie o aplicativo para concluir a atualização.',
        buttons: ['Reiniciar e atualizar', 'Depois'],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
      })
      .then(({ response }) => {
        if (response === 0) autoUpdater.quitAndInstall();
      });
  });

  const checkForUpdates = () => autoUpdater.checkForUpdates();

  // O Squirrel mantém um lock logo após a primeira instalação. A pequena espera
  // também evita competir com a inicialização do banco e da janela principal.
  const initialCheck = setTimeout(checkForUpdates, 15_000);
  initialCheck.unref();

  const periodicCheck = setInterval(checkForUpdates, 60 * 60 * 1000);
  periodicCheck.unref();
};

const createWindow = () => {
  const createdWindow = new BrowserWindow({
    title: 'LionPocket',
    width: 1440,
    height: 920,
    minWidth: 1080,
    minHeight: 720,
    // A barra de título é desenhada pelo próprio app (src/ui/TitleBar.tsx).
    frame: false,
    backgroundColor: '#150E14',
    icon: iconPath(),
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
  // A janela nasce escondida para não piscar sem conteúdo. O 'ready-to-show'
  // é o gatilho ideal, mas no app empacotado ele não chega a disparar em
  // alguns compositores do Linux — sem a segunda rede, a janela nunca abria.
  // 'showMainWindow' é idempotente, então o que vier primeiro resolve.
  createdWindow.once('ready-to-show', showMainWindow);
  createdWindow.webContents.once('did-finish-load', showMainWindow);

  // Mantém os botões da barra de título em sincronia quando a janela é
  // maximizada por fora do app (atalho de teclado, arrastar para o topo…).
  const sendWindowState = () => {
    if (createdWindow.isDestroyed()) return;
    createdWindow.webContents.send('window:state', { maximized: createdWindow.isMaximized() });
  };
  createdWindow.on('maximize', sendWindowState);
  createdWindow.on('unmaximize', sendWindowState);

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
  if (process.platform === 'win32') {
    app.setAppUserModelId('com.squirrel.lionpocket.lionpocket');
  }

  const databasePath = path.join(app.getPath('userData'), 'lionpocket.sqlite');
  database = new LionPocketDatabase(databasePath);
  registerIpcHandlers(database);
  createWindow();
  configureAutoUpdates();
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
  // On OS X it's common to re-create a window when the dock icon is clicked and there are no other windows open.
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files or import them here.
