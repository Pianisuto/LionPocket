import { canonicalStringify } from '@lionpocket/sync-protocol';
import { derivedId } from './financial';
import type { SqlWorkflow } from './manual';
import type { LocalSyncDatabase } from './transport-state';
import type { ProvisionedProfile } from './provisioning';
import { epochPreparationSecretScope } from './epoch-preparation-secrets';
import { secretContext, type SecretScope, type StoredSecretScope } from './secrets';
import type { SyncSaved } from './sync';

export const unlinkServerCopy = {
  title: 'Desvincular servidor',
  description: 'Interrompe a sincronização e remove o vínculo e as credenciais somente deste aparelho.',
  confirmation: 'Um backup completo será criado antes de remover o vínculo. Seus dados financeiros locais serão mantidos, incluindo alterações ainda não sincronizadas. O cofre remoto, a conta, o servidor e os dados de outros aparelhos não serão apagados. Você poderá conectar este aparelho a um servidor novamente quando quiser.',
  action: 'Confirmar desvinculação',
} as const;

const historyTables = ['sync_revisions', 'sync_heads', 'sync_tombstones', 'sync_conflicts', 'sync_dirty', 'sync_review'] as const;

/** Financial rows, stable identities, schedule slots and import receipts stay local. */
export function* unlinkLocalServer(): SqlWorkflow {
  yield { sql: 'UPDATE sync_control SET applying=1,paused=1 WHERE id=1' };
  // Alternate conflict snapshots and pending review choices are financial information too.
  // Archive their plaintext locally before removing the old transport namespace.
  const existing = yield { sql: "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'recovery_%'" };
  const recovery = new Set(existing.map(row => String(row.name)));
  for (const table of [...historyTables, ...historyTables.map(table => `recovery_archive_${table}`).filter(table => recovery.has(table))]) {
    const rows = yield { sql: `SELECT * FROM ${table}` };
    for (const original of rows) {
      const row = Object.fromEntries(Object.entries(original).filter(([name]) => !['vault_id_scope', 'epoch_scope'].includes(name)));
      if (row.reason === 'detached_history') {
        yield { sql: 'INSERT OR IGNORE INTO sync_review VALUES(?,NULL,?,?)', params: [row.review_id, row.reason, row.payload_json] };
        continue;
      }
      const payload = canonicalStringify({ sourceTable: table, row });
      yield {
        sql: "INSERT OR IGNORE INTO sync_review VALUES(?,NULL,'detached_history',?)",
        params: [derivedId('c5f94c78-d3c0-4e47-8c02-3e76b3f961d5', payload), payload],
      };
    }
  }
  // Recovery tables are optional, contain old device profiles/pins and have immutable triggers.
  // Drop only this explicit local sidecar family, children before parents, in the transaction.
  for (const table of [
    'recovery_activation_saga', 'recovery_b_envelopes', 'recovery_b_batches', 'recovery_b_saga',
    'recovery_revision_mapping', 'recovery_plan_reviews', 'recovery_owner_requests', 'recovery_journal',
    ...existing.map(row => String(row.name)).filter(name => /^recovery_archive_sync_[a-z_]+$/.test(name)),
    'recovery_generations',
  ]) if (recovery.has(table)) yield { sql: `DROP TABLE ${table}` };
  for (const table of ['sync_conflicts', 'sync_rejected', 'sync_revision_origin', 'sync_heads', 'sync_tombstones', 'sync_revisions', 'sync_outbox', 'sync_inbox', 'sync_dirty', 'sync_bootstrap', 'sync_bindings'])
    yield { sql: `DELETE FROM ${table}` };
  yield { sql: "DELETE FROM sync_review WHERE reason NOT LIKE 'import_receipt:%' AND reason NOT IN ('legacy_import_review_provenance','detached_history')" };
  yield { sql: "UPDATE sync_local_state SET mode='disabled',local_scope_id=NULL,binding_id=NULL,server_id=NULL,server_epoch=NULL,vault_id=NULL,device_id=NULL,local_seq='0',device_seq='0',received_cursor='0',applied_cursor='0',pull_upper_bound=NULL WHERE id=1" };
  yield { sql: 'UPDATE sync_control SET applying=0,paused=0 WHERE id=1' };
}

/** Enumerate only this bank's saved devices, including staged/historical recovery devices. */
export async function serverSecretScopes(db: LocalSyncDatabase, saved: SyncSaved): Promise<StoredSecretScope[]> {
  const scopes = new Map<string, StoredSecretScope>();
  const add = (scope: StoredSecretScope) => scopes.set(secretContext(scope), scope);
  const profiles: ProvisionedProfile[] = saved.profile ? [saved.profile] : [];
  const existing = new Set((await db.read("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('recovery_journal','recovery_b_saga')")).map(row => String(row.name)));
  if (existing.has('recovery_journal')) {
    for (const row of await db.read('SELECT profile_a_json,restore_id,to_epoch FROM recovery_journal')) {
      const profile = JSON.parse(String(row.profile_a_json)) as ProvisionedProfile;
      profiles.push(profile);
      add(epochPreparationSecretScope(profile, String(row.restore_id), String(row.to_epoch)));
    }
  }
  if (existing.has('recovery_b_saga'))
    for (const row of await db.read('SELECT profile_b_json FROM recovery_b_saga'))
      profiles.push(JSON.parse(String(row.profile_b_json)) as ProvisionedProfile);
  for (const profile of profiles) {
    const base = {
      installationId: profile.installationId, deviceId: profile.deviceId,
      serverId: profile.pin.serverId, serverEpoch: profile.pin.serverEpoch, vaultId: profile.pin.vaultId,
    };
    for (const purpose of ['authoritySeed', 'signingSeed', 'boxSeed', 'recoveryMaster', 'pairingCapability'] as const)
      add({ ...base, purpose, keyVersion: 1 });
    const versions = new Set([profile.pin.keyVersion, profile.activeKeyVersion ?? profile.pin.keyVersion, ...((profile.keyCheckpoints ?? []).map(key => key.keyVersion))]);
    if (profile === saved.profile && saved.pendingKeyCheckpoint) versions.add(saved.pendingKeyCheckpoint.keyVersion);
    // Rotation can persist the new key immediately before persisting its public checkpoint.
    versions.add((profile.activeKeyVersion ?? profile.pin.keyVersion) + 1);
    const highestVersion = Math.max(...versions);
    for (let keyVersion = profile.pin.keyVersion; keyVersion <= highestVersion; keyVersion++)
      add({ ...base, purpose: 'dataKey', keyVersion } satisfies SecretScope);
  }
  return [...scopes.values()];
}
