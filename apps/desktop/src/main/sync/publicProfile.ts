import { open, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { SyncSaved } from '@lionpocket/sync-local';

/** Public metadata only; Unix directory fsync is unavailable on Windows. */
export async function savePublicProfile(target: string, value: SyncSaved): Promise<void> {
  const temporary = target + '.' + randomUUID();
  const handle = await open(temporary, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); }
  finally { await handle.close(); }
  await rename(temporary, target);
  if (process.platform !== 'win32') {
    const parent = await open(dirname(target), 'r');
    try { await parent.sync(); } finally { await parent.close(); }
  }
}
