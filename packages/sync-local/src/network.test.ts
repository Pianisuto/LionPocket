import { afterEach, describe, expect, it, vi } from 'vitest';
import { syncFetchText } from './network';
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
describe('bounded foreground network requests', () => {
  it('aborts on timeout including stalled response bodies', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => ({
        ok: true,
        headers: new Headers(),
        text: () =>
          new Promise<string>((_resolve, reject) =>
            init.signal!.addEventListener('abort', () =>
              reject(new Error('timeout')),
            ),
          ),
      })),
    );
    const result = syncFetchText('https://fixture.invalid').catch(
      (e) => e.message,
    );
    await vi.advanceTimersByTimeAsync(15000);
    expect(await result).toBe('timeout');
  });
  it('uses lifecycle cancellation and refuses redirects without continuing transport', async () => {
    const abort = new AbortController();
    const fetch = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal!.addEventListener('abort', () =>
            reject(new Error('inactive')),
          );
        }),
    );
    vi.stubGlobal('fetch', fetch);
    const result = syncFetchText(
      'https://fixture.invalid',
      {},
      abort.signal,
    ).catch((e) => e.message);
    abort.abort();
    expect(await result).toBe('inactive');
    expect(fetch.mock.calls[0][1].redirect).toBe('error');
  });
});
