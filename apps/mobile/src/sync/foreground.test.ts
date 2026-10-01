import { afterEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({
  currentState: 'active' as string,
  callback: undefined as ((s: string) => void) | undefined,
  remove: vi.fn(),
  setForeground: vi.fn(),
  completed: undefined as (() => void) | undefined,
  unsubscribe: vi.fn(),
  init: vi.fn(),
}));
vi.mock('react-native', () => ({
  AppState: {
    get currentState() {
      return state.currentState;
    },
    addEventListener: (_: string, cb: (s: string) => void) => {
      state.callback = cb;
      return { remove: state.remove };
    },
  },
}));
vi.mock('./beta', () => ({ privateBeta: true, betaSync: state.init }));
import { startBetaForeground } from './foreground';
afterEach(() => {
  vi.clearAllMocks();
  state.currentState = 'active';
});
function controller() {
  return {
    setForeground: state.setForeground,
    coordinator: { lastCompletedAt: undefined as string | undefined },
    subscribe: (cb: () => void) => {
      state.completed = cb;
      return state.unsubscribe;
    },
  };
}
describe('real React Native AppState subscription adapter', () => {
  it('requests startup/resume only while active and removes listeners on unmount', async () => {
    const c = controller();
    state.init.mockResolvedValue(c);
    const refresh = vi.fn(),
      stop = startBetaForeground(refresh);
    await Promise.resolve();
    expect(state.setForeground).toHaveBeenCalledWith(true);
    state.currentState = 'background';
    state.callback!('background');
    expect(state.setForeground).toHaveBeenLastCalledWith(false);
    c.coordinator.lastCompletedAt = '2026-10-01T12:00:00Z';
    state.completed!();
    expect(refresh).not.toHaveBeenCalled();
    state.currentState = 'active';
    state.callback!('active');
    expect(state.setForeground).toHaveBeenLastCalledWith(true);
    c.coordinator.lastCompletedAt = '2026-10-01T12:00:02Z';
    state.completed!();
    expect(refresh).toHaveBeenCalledTimes(1);
    stop();
    expect(state.remove).toHaveBeenCalledTimes(1);
    expect(state.unsubscribe).toHaveBeenCalledTimes(1);
    expect(state.setForeground).toHaveBeenLastCalledWith(false);
  });
  it('checks current lifecycle after slow initialization and does not revive after unmount', async () => {
    let resolve!: (c: ReturnType<typeof controller>) => void;
    state.init.mockReturnValue(
      new Promise((r) => {
        resolve = r;
      }),
    );
    const stop = startBetaForeground(vi.fn());
    state.currentState = 'background';
    resolve(controller());
    await Promise.resolve();
    expect(state.setForeground).toHaveBeenCalledExactlyOnceWith(false);
    stop();
    state.setForeground.mockClear();
    state.init.mockReturnValue(
      new Promise((r) => {
        resolve = r;
      }),
    );
    const stopEarly = startBetaForeground(vi.fn());
    stopEarly();
    resolve(controller());
    await Promise.resolve();
    expect(state.setForeground).not.toHaveBeenCalled();
  });
});
