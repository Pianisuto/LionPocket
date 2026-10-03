import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bankSyncCoordinator, SyncCoordinator } from './coordinator';
const controllers: SyncCoordinator[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(10000);
});
afterEach(() => {
  controllers.splice(0).forEach((c) => c.dispose());
  vi.useRealTimers();
});
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
function setup(
  cycle = vi.fn(async () => {
    /* Successful empty transport fixture. */
  }),
  eligible = vi.fn(async () => true),
) {
  const c = new SyncCoordinator({ cycle, eligible });
  controllers.push(c);
  return { c, cycle, eligible };
}
async function active(c: SyncCoordinator) {
  c.setForeground(true);
  await vi.advanceTimersByTimeAsync(0);
}
describe('one foreground coordinator per bank', () => {
  it('shares the coordinator for the same bank', () => {
    const bank = {},
      options = {
        eligible: async () => true,
        cycle: async () => {
          /* Successful empty transport fixture. */
        },
      };
    const c = bankSyncCoordinator(bank, options);
    controllers.push(c);
    expect(bankSyncCoordinator(bank, options)).toBe(c);
    expect(bankSyncCoordinator({}, options)).not.toBe(c);
  });
  it('debounces many rapid writes into one pass with a configurable delay', async () => {
    const { c, cycle } = setup();
    await active(c);
    cycle.mockClear();
    for (let i = 0; i < 4; i++) {
      c.request('local-write');
      await vi.advanceTimersByTimeAsync(250);
    }
    await vi.advanceTimersByTimeAsync(1749);
    expect(cycle).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(cycle).toHaveBeenCalledTimes(1);
  });
  it('queues a write during a running pass without concurrent cycles', async () => {
    const gate = deferred();
    let concurrent = 0,
      maximum = 0;
    const cycle = vi.fn(async () => {
      concurrent++;
      maximum = Math.max(maximum, concurrent);
      await gate.promise;
      concurrent--;
    });
    const { c } = setup(cycle);
    await active(c);
    c.request('local-write');
    c.request('local-write');
    await vi.advanceTimersByTimeAsync(3000);
    expect(cycle).toHaveBeenCalledTimes(1);
    gate.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(cycle).toHaveBeenCalledTimes(2);
    expect(maximum).toBe(1);
  });
  it('foreground requires eligibility and focus storms are absorbed even after completion', async () => {
    const { c, cycle, eligible } = setup();
    eligible.mockResolvedValue(false);
    await active(c);
    expect(cycle).not.toHaveBeenCalled();
    eligible.mockResolvedValue(true);
    c.setForeground(true);
    await vi.advanceTimersByTimeAsync(0);
    for (let i = 0; i < 20; i++) {
      c.setForeground(true);
      await vi.advanceTimersByTimeAsync(20);
    }
    await vi.advanceTimersByTimeAsync(2000);
    expect(cycle).toHaveBeenCalledTimes(1);
  });
  it('manual anticipates debounce and coalesces queued manual requests into one new pass', async () => {
    const { c, cycle } = setup();
    await active(c);
    cycle.mockClear();
    c.request('local-write');
    const manual = c.request('manual');
    await vi.advanceTimersByTimeAsync(0);
    await manual;
    expect(cycle).toHaveBeenCalledExactlyOnceWith(
      true,
      expect.any(AbortSignal),
    );
    await vi.advanceTimersByTimeAsync(2500);
    expect(cycle).toHaveBeenCalledTimes(1);
    const gate = deferred();
    cycle.mockImplementationOnce(() => gate.promise);
    const first = c.request('manual');
    await vi.advanceTimersByTimeAsync(0);
    const second = c.request('manual'),
      third = c.request('manual');
    gate.resolve();
    await vi.advanceTimersByTimeAsync(0);
    await Promise.all([first, second, third]);
    expect(cycle).toHaveBeenCalledTimes(3);
  });
  it('does not lose writes or manual requests during asynchronous eligibility checks', async () => {
    const gate = deferred();
    const { c, cycle } = setup(
      undefined,
      vi.fn(async () => {
        await gate.promise;
        return true;
      }),
    );
    c.setForeground(true);
    await vi.advanceTimersByTimeAsync(0);
    c.request('local-write');
    const manual = c.request('manual');
    gate.resolve();
    await vi.advanceTimersByTimeAsync(0);
    await manual;
    expect(cycle).toHaveBeenCalledTimes(2);
    expect(cycle.mock.calls.map((args) => args[0])).toEqual([false, true]);
  });
  it('paused/ineligible automatic requests do not transport or self-retry', async () => {
    const { c, cycle, eligible } = setup();
    eligible.mockResolvedValue(false);
    await active(c);
    c.request('local-write');
    await vi.advanceTimersByTimeAsync(20000);
    expect(cycle).not.toHaveBeenCalled();
    eligible.mockResolvedValue(true);
    c.setForeground(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(cycle).toHaveBeenCalledTimes(1);
  });
  it('errors are best effort, retain a new request, and do not create a polling loop', async () => {
    const { c, cycle } = setup(
      vi.fn(async () => {
        throw new Error('offline');
      }),
    );
    await active(c);
    expect(c.error).toBe('offline');
    await vi.advanceTimersByTimeAsync(60000);
    expect(cycle).toHaveBeenCalledTimes(1);
    c.request('local-write');
    await vi.advanceTimersByTimeAsync(2000);
    expect(cycle).toHaveBeenCalledTimes(2);
    expect(c.lastCompletedAt).toBeUndefined();
  });
  it('suspends debounce and aborts transport when inactive; resume retries without background execution', async () => {
    const { c, cycle } = setup();
    await active(c);
    cycle.mockClear();
    c.request('local-write');
    c.setForeground(false);
    await vi.advanceTimersByTimeAsync(60000);
    expect(cycle).not.toHaveBeenCalled();
    c.setForeground(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(cycle).toHaveBeenCalledTimes(1);
    const gate = deferred();
    cycle.mockImplementationOnce(() => gate.promise);
    const manual = c.request('manual').catch((e) => e.message);
    await vi.advanceTimersByTimeAsync(0);
    const signal = cycle.mock.calls.at(-1)![1];
    c.setForeground(false);
    expect(signal.aborted).toBe(true);
    c.request('local-write');
    gate.resolve();
    await vi.advanceTimersByTimeAsync(60000);
    expect(cycle).toHaveBeenCalledTimes(2);
    c.setForeground(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(cycle).toHaveBeenCalledTimes(3);
    expect(await manual).toBeUndefined();
  });
  it('cleanup cancels queued timers/listeners and rejects manual work outside foreground', async () => {
    const { c, cycle } = setup();
    await expect(c.request('manual')).rejects.toThrow('foreground_inactive');
    await active(c);
    cycle.mockClear();
    c.request('local-write');
    c.dispose();
    await vi.advanceTimersByTimeAsync(60000);
    expect(cycle).not.toHaveBeenCalled();
  });
  it('recovery waits for an aborted pass to finish its profile write', async () => {
    const gate = deferred();
    let profileSaved = false;
    const { c, cycle } = setup(vi.fn(async () => {
      await gate.promise;
      profileSaved = true;
    }));
    c.setForeground(true);
    await vi.advanceTimersByTimeAsync(0);
    let settled = false;
    const stopped = c.cancelAndWait().then(() => { settled = true; });
    expect(cycle.mock.calls[0][1].aborted).toBe(true);
    expect(settled).toBe(false);
    gate.resolve();
    await stopped;
    expect(profileSaved).toBe(true);
    expect(c.running).toBe(false);
    await vi.advanceTimersByTimeAsync(60000);
    expect(cycle).toHaveBeenCalledTimes(1);
  });
});
