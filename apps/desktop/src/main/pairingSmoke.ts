import { app, BrowserWindow } from 'electron';
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { tmpdir } from 'node:os';

/** Native installed-app CI probe. Only a fresh, explicitly selected temporary profile is allowed. */
export function pairingSmokeDirectory() {
  const directory = process.env.LIONPOCKET_PAIRING_SMOKE_DIRECTORY;
  if (!directory) return null;
  if (process.env.CI !== 'true' || !isAbsolute(directory) || realpathSync(directory) !== directory || !/^lion-pairing-smoke-[a-zA-Z0-9_-]+$/.test(relative(realpathSync(tmpdir()), directory)))
    throw new Error('Disposable pairing smoke directory required');
  return directory;
}
export function observePairingSmoke(window: BrowserWindow, directory: string, received: () => number) {
  let running = false;
  const timer = setInterval(async () => {
    if (running || window.isDestroyed()) return;
    running = true;
    try {
      if (existsSync(join(directory, 'cancel'))) {
        await window.webContents.executeJavaScript("[...document.querySelectorAll('button')].find(b => b.textContent === 'Cancelar')?.click()");
      }
      const ui = await window.webContents.executeJavaScript(`(() => {
        const dialog = document.querySelector('[role="dialog"]');
        const text = dialog?.textContent || '';
        return { confirmation: text.includes('Conectar a este cofre'),
          server: text.includes('sync.pairing-fixture.invalid'),
          expired: text.includes('Convite expirado'), invalid: text.includes('Convite inválido'),
          connectButtons: [...(dialog?.querySelectorAll('button') || [])].filter(b => b.textContent === 'Conectar').length,
          manualInputs: dialog?.querySelectorAll('input,textarea,video').length || 0,
          rawInviteVisible: /LPV2\\./.test(document.body.textContent || ''), dialogOpen: !!dialog };
      })()`);
      const publicProfile = join(app.getPath('userData'), 'sync/public-profile.json');
      if (ui.confirmation && ui.server && !existsSync(join(directory, 'confirmation.png'))) {
        await new Promise(resolve => setTimeout(resolve, 250)); // Let the compositor paint the new dialog.
        const image = await window.webContents.capturePage();
        writeFileSync(join(directory, 'confirmation.png'), image.toPNG());
      }
      const profile = existsSync(publicProfile) ? JSON.parse(readFileSync(publicProfile, 'utf8')) : null;
      writeFileSync(join(directory, 'state.json'), JSON.stringify({ ...ui, pid: process.pid, received: received(), windows: BrowserWindow.getAllWindows().length, requestCreated: !!profile?.request, bound: profile?.phase === 'bound' }));
    } catch { /* The renderer may still be loading; never dump invitations or errors. */ }
    finally { running = false; }
  }, 150);
  app.once('before-quit', () => clearInterval(timer));
}
