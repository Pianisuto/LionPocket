import { NativeModules } from 'react-native';
import { setSyncTextTransport } from '@lionpocket/sync-local';
let installed = false;
let sequence = 0;
/** Platform trust store + no HTTP redirects, also for Authorization Code exchange. */
export function installAndroidSyncTransport() {
  if (installed) return;
  const native = NativeModules.LionPocketIdentity;
  if (!native?.fetchText) throw new Error('Transporte seguro indisponível.');
  setSyncTextTransport(async (url, init, signal) => {
    if (signal.aborted) throw new Error('request_cancelled');
    const id = String(++sequence);
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((value, key) => { headers[key] = value; });
    const cancel = () => native.cancelFetch(id);
    signal.addEventListener('abort', cancel);
    try {
      const result = await native.fetchText(id, url, init.method ?? 'GET', headers, init.body == null ? null : String(init.body));
      if (signal.aborted) throw new Error('request_cancelled');
      return result;
    } finally { signal.removeEventListener('abort', cancel); }
  });
  installed = true;
}
