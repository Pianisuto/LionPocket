import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, open } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { dirname } from 'node:path';
import type { AnchorBackupInspection, VerifiedAnchorBackup } from '@lionpocket/sync-local';

/** Native SQLite backup, not JSON export. Target must be a new private file chosen by the caller. */
export async function createEpochAnchorBackup(db: DatabaseSync, target: string): Promise<VerifiedAnchorBackup> {
  db.prepare('VACUUM INTO ?').run(target);
  await chmod(target, 0o600);
  // Windows FlushFileBuffers requires write access; r+ preserves the completed backup bytes.
  const handle = await open(target, 'r+');
  try { await handle.sync(); } finally { await handle.close(); }
  if (process.platform !== 'win32') {
    const directory = await open(dirname(target), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  }
  const inspection = await inspectEpochAnchorBackup(target);
  return { path: target, sha256: inspection.sha256 };
}
export async function inspectEpochAnchorBackup(path: string): Promise<AnchorBackupInspection> {
  const backup = new DatabaseSync(path, { readOnly: true });
  let bindingPinJson: string;
  try {
    const integrity = backup.prepare('PRAGMA integrity_check').all();
    if (integrity.length !== 1 || integrity[0].integrity_check !== 'ok') throw new Error('epoch_backup_invalid');
    if (backup.prepare('PRAGMA foreign_key_check').all().length) throw new Error('epoch_backup_invalid');
    const binding = backup.prepare('SELECT pin_json FROM sync_bindings WHERE binding_id=(SELECT binding_id FROM sync_local_state WHERE id=1)').get();
    if (!binding || typeof binding.pin_json !== 'string') throw new Error('epoch_backup_invalid');
    bindingPinJson = binding.pin_json;
  } finally { backup.close(); }
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return { sha256: hash.digest('base64url'), integrity: 'ok', bindingPinJson, foreignKeyViolations: 0 };
}
