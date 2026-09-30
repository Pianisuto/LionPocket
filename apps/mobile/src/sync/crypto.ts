import sodium from 'react-native-libsodium';
import { uuidFromRandom } from '@lionpocket/sync-local';
export async function androidCrypto() {
  const runtime = globalThis as typeof globalThis & {
    HermesInternal?: unknown;
    jsi_crypto_sign_detached?: unknown;
  };
  if (
    !runtime.HermesInternal ||
    typeof runtime.jsi_crypto_sign_detached !== 'function'
  )
    throw new Error('Sync crypto requires Android Hermes/JSI.');
  await sodium.ready;
  return sodium;
}
export async function androidSyncUuidGenerator(): Promise<() => string> {
  const crypto = await androidCrypto();
  return () => uuidFromRandom(crypto.randombytes_buf(16));
}
