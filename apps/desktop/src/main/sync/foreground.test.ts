import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SyncCoordinator } from '@lionpocket/sync-local';
import { desktopForeground } from './foreground';
afterEach(() => vi.useRealTimers());
describe('Electron foreground lifecycle adapter', () => {
  it('requests startup and focus, coalesces nearby events and removes its subscriptions', async () => {
    vi.useFakeTimers();
    const app = new EventEmitter(),
      cycle = vi.fn(async () => {
        /* Empty successful cycle. */
      });
    const c = new SyncCoordinator({ eligible: async () => true, cycle });
    let focused = true;
    const stop = desktopForeground(
      app,
      () => focused,
      (active) => c.setForeground(active),
    );
    await vi.advanceTimersByTimeAsync(0);
    for (let i = 0; i < 10; i++) {
      app.emit('browser-window-focus');
      await vi.advanceTimersByTimeAsync(20);
    }
    await vi.advanceTimersByTimeAsync(2000);
    expect(cycle).toHaveBeenCalledTimes(1);
    focused = false;
    app.emit('browser-window-blur');
    c.request('local-write');
    await vi.advanceTimersByTimeAsync(10000);
    expect(cycle).toHaveBeenCalledTimes(1);
    focused = true;
    app.emit('browser-window-focus');
    await vi.advanceTimersByTimeAsync(0);
    expect(cycle).toHaveBeenCalledTimes(2);
    stop();
    expect(app.listenerCount('browser-window-focus')).toBe(0);
    expect(app.listenerCount('browser-window-blur')).toBe(0);
    app.emit('browser-window-focus');
    await vi.advanceTimersByTimeAsync(10000);
    expect(cycle).toHaveBeenCalledTimes(2);
    c.dispose();
  });
});
