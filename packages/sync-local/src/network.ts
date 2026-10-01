export type SyncTextTransport = (url: string, init: RequestInit, signal: AbortSignal) => Promise<{ ok: boolean; text: string }>;
let nativeTransport: SyncTextTransport | undefined;
/** Android fetch does not consistently implement redirect:error. Install the native
 * no-redirect transport once, before discovery or sending credentials/proofs. */
export function setSyncTextTransport(transport: SyncTextTransport) { nativeTransport = transport; }

/** Deadline includes reading the body. Works with the native fetch AbortController too. */
export async function syncFetchText(
  url: string,
  init: RequestInit = {},
  signal?: AbortSignal,
) {
  const abort = new AbortController();
  const cancel = () => abort.abort();
  signal?.addEventListener('abort', cancel);
  if (signal?.aborted) cancel();
  const timer = setTimeout(cancel, 15000);
  try {
    if (nativeTransport) return await nativeTransport(url, init, abort.signal);
    const response = await fetch(url, {
      ...init,
      redirect: 'error',
      signal: abort.signal,
    });
    if (Number(response.headers.get('content-length') ?? 0) > 4194304)
      throw new Error('payload_too_large');
    const text = await response.text();
    if (text.length > 4194304) throw new Error("payload_too_large");
    return { ok: response.ok, text };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
  }
}
