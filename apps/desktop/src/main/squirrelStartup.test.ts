import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { handleSquirrelStartup } from './squirrelStartup';
const runtime = vi.hoisted(() => ({ spawn: vi.fn(() => ({ on: vi.fn() })) }));
vi.mock('node:child_process', () => ({ spawn: runtime.spawn }));
describe('Squirrel installed entry point without argv logging', () => {
  it('an ordinary LPV2 launch never invokes installer tooling or logs the capability even under DEBUG', () => {
    const log = vi.spyOn(console, 'log'), warn = vi.spyOn(console, 'warn'), error = vi.spyOn(console, 'error');
    expect(handleSquirrelStartup({ quit: vi.fn() }, 'win32', ['app', 'lionpocket://pair/LPV2.secret'], 'C:/app/lionpocket.exe')).toBe(false);
    expect(runtime.spawn).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled(); expect(warn).not.toHaveBeenCalled(); expect(error).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });
  it.each(['--squirrel-install', '--squirrel-updated', '--squirrel-uninstall'])('%s keeps the installer shortcut lifecycle', action => {
    const executable = path.resolve('installed/app-1/lionpocket.exe');
    expect(handleSquirrelStartup({ quit: vi.fn() }, 'win32', ['app', action], executable)).toBe(true);
    expect(runtime.spawn).toHaveBeenLastCalledWith(path.resolve(path.dirname(executable), '..', 'Update.exe'), [`${action === '--squirrel-uninstall' ? '--removeShortcut=' : '--createShortcut='}lionpocket.exe`], { detached: true, stdio: 'ignore' });
  });
});
