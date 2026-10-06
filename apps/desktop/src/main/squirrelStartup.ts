import { spawn } from 'node:child_process';
import path from 'node:path';

/** electron-squirrel-startup logs argv[1] under DEBUG, which may contain an LPV2 capability. */
export function handleSquirrelStartup(app: { quit(): void }, platform: string, argv: string[], executable: string) {
  if (platform !== 'win32') return false;
  const action = argv[1];
  if (action === '--squirrel-obsolete') { app.quit(); return true; }
  if (!['--squirrel-install', '--squirrel-updated', '--squirrel-uninstall'].includes(action)) return false;
  const update = path.resolve(path.dirname(executable), '..', 'Update.exe');
  const shortcut = `${action === '--squirrel-uninstall' ? '--removeShortcut=' : '--createShortcut='}${path.basename(executable)}`;
  const child = spawn(update, [shortcut], { detached: true, stdio: 'ignore' });
  child.on('close', () => app.quit());
  child.on('error', () => app.quit());
  return true;
}
