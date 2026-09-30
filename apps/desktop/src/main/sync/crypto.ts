import sodium, { ready } from 'libsodium-wrappers-sumo';
/** Main only. No renderer/preload/IPC export of key material. */
export async function desktopCrypto() {
  if (process.versions.electron && process.type !== 'browser')
    throw new Error('Sync crypto requires Electron main.');
  await ready;
  return sodium;
}
