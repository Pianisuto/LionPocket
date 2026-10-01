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
    const response = await fetch(url, {
      ...init,
      redirect: 'error',
      signal: abort.signal,
    });
    if (Number(response.headers.get('content-length') ?? 0) > 4194304)
      throw new Error('payload_too_large');
    const text = await response.text();
    return { ok: response.ok, text };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
  }
}
