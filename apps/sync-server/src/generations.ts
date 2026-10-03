import type { PoolClient } from 'pg';
import type { TrustPin } from '@lionpocket/sync-protocol';

/** Keep the ordinary v1 log tables simple. Archives have one indexed row per original row, never one vault-sized JSON. */
export const generationArchiveKeys = {
  sync_vaults: ['vault_id'],
  sync_grants: ['vault_id', 'registry_version'],
  sync_pairings: ['vault_id', 'device_id'],
  sync_deliveries: ['vault_id', 'recipient_device_id'],
  sync_commits: ['vault_id', 'commit_id'],
  sync_operations: ['vault_id', 'op_id'],
  sync_remote_heads: ['vault_id', 'object_id', 'op_id'],
  sync_remote_bindings: ['binding_id'],
} as const;

/** Runs after the v1 control/log/binding schemas. Safe to repeat, including on restored v1/v2 backups. */
export const generationSchema = `
CREATE TABLE IF NOT EXISTS sync_generations (
  vault_id uuid NOT NULL REFERENCES sync_vaults(vault_id), server_epoch uuid NOT NULL,
  state text NOT NULL CHECK(state IN ('active','archived')),
  archive_sealed boolean NOT NULL DEFAULT false,
  PRIMARY KEY(vault_id,server_epoch)
);
CREATE UNIQUE INDEX IF NOT EXISTS sync_generation_active ON sync_generations(vault_id) WHERE state='active';
INSERT INTO sync_generations(vault_id,server_epoch,state)
SELECT vault_id,(pin->>'serverEpoch')::uuid,'active' FROM sync_vaults ON CONFLICT DO NOTHING;
CREATE OR REPLACE FUNCTION sync_preserve_sealed_generation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' AND OLD.archive_sealed THEN RAISE EXCEPTION 'Generation archive is immutable'; END IF;
  IF TG_OP='UPDATE' AND ((OLD.archive_sealed AND (NOT NEW.archive_sealed OR NEW.vault_id<>OLD.vault_id OR NEW.server_epoch<>OLD.server_epoch))
      OR (OLD.state='archived' AND NEW.state<>'archived')) THEN
    RAISE EXCEPTION 'Generation archive is immutable';
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $$;
DROP TRIGGER IF EXISTS sync_preserve_generation ON sync_generations;
CREATE TRIGGER sync_preserve_generation BEFORE UPDATE OR DELETE ON sync_generations
FOR EACH ROW EXECUTE FUNCTION sync_preserve_sealed_generation();
CREATE OR REPLACE FUNCTION sync_register_generation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO sync_generations(vault_id,server_epoch,state)
  VALUES(NEW.vault_id,(NEW.pin->>'serverEpoch')::uuid,'active');
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS sync_register_generation ON sync_vaults;
CREATE TRIGGER sync_register_generation AFTER INSERT ON sync_vaults FOR EACH ROW EXECUTE FUNCTION sync_register_generation();
CREATE OR REPLACE FUNCTION sync_immutable_generation_archive() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' OR (SELECT archive_sealed FROM sync_generations
      WHERE vault_id=NEW.vault_id AND server_epoch=NEW.generation_epoch) IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'Generation archive is immutable';
  END IF;
  RETURN NEW;
END $$;
` + Object.entries(generationArchiveKeys).map(([table, keys]) => `
CREATE TABLE IF NOT EXISTS archive_${table} (
  LIKE ${table} INCLUDING DEFAULTS,
  generation_epoch uuid NOT NULL,
  PRIMARY KEY(generation_epoch,${keys.join(',')}),
  FOREIGN KEY(vault_id,generation_epoch) REFERENCES sync_generations(vault_id,server_epoch)
);
CREATE INDEX IF NOT EXISTS archive_${table}_generation ON archive_${table}(vault_id,generation_epoch);
DROP TRIGGER IF EXISTS immutable_archive ON archive_${table};
CREATE TRIGGER immutable_archive BEFORE INSERT OR UPDATE OR DELETE ON archive_${table}
FOR EACH ROW EXECUTE FUNCTION sync_immutable_generation_archive();
`).join('') + `
-- Existing archive rows preserve the exact legacy pin and checkpoint chain.
ALTER TABLE archive_sync_vaults ADD COLUMN IF NOT EXISTS base_key_version bigint;
ALTER TABLE archive_sync_vaults ADD COLUMN IF NOT EXISTS active_key_version bigint;
-- Backfill is deliberately performed only before the archive immutability trigger is restored by this migration.
CREATE INDEX IF NOT EXISTS archive_sync_commits_position ON archive_sync_commits(vault_id,generation_epoch,log_position);
CREATE INDEX IF NOT EXISTS archive_sync_operations_object ON archive_sync_operations(vault_id,generation_epoch,object_id);
`;

/** Caller owns the vault lock and transaction. Only a restored, transport-blocked A may be frozen.
 * This copies evidence, never activates a generation, edits a pin or deletes the original log. */
export async function sealRestoredGeneration(tx: PoolClient, vaultId: string, currentEpoch: string): Promise<void> {
  const vault = (await tx.query('SELECT pin FROM sync_vaults WHERE vault_id=$1 FOR UPDATE', [vaultId])).rows[0];
  if (!vault || vault.pin.serverEpoch === currentEpoch) throw new Error('restore_record_required');
  const epoch = vault.pin.serverEpoch as string;
  const generation = (await tx.query(
    'SELECT archive_sealed FROM sync_generations WHERE vault_id=$1 AND server_epoch=$2 FOR UPDATE', [vaultId, epoch],
  )).rows[0];
  if (!generation) throw new Error('generation_missing');
  if (generation.archive_sealed) return;
  for (const table of Object.keys(generationArchiveKeys)) {
    // Table names are a fixed internal allowlist. All source fields, including exact envelope_text/receipts, are copied.
    const columns = (await tx.query("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position", [table])).rows.map(r => String(r.column_name));
    await tx.query(`INSERT INTO archive_${table}(${columns.join(',')},generation_epoch) SELECT ${columns.map(c => `t.${c}`).join(',')},$2::uuid FROM ${table} t WHERE vault_id=$1`, [vaultId, epoch]);
  }
  await tx.query('UPDATE sync_generations SET archive_sealed=true WHERE vault_id=$1 AND server_epoch=$2', [vaultId, epoch]);
}

/** The ordinary v1 tables serve precisely the selected active generation in the current environment. */
export async function requireActiveGeneration(tx: PoolClient, pin: TrustPin): Promise<void> {
  const result = await tx.query(`SELECT 1 FROM sync_generations g JOIN sync_vaults v USING(vault_id)
    JOIN sync_environment e ON e.singleton
    WHERE g.vault_id=$1 AND g.server_epoch=$2 AND g.state='active'
      AND v.pin->>'serverEpoch'=$2::text AND e.server_epoch=$2 AND e.server_id=$3`,
    [pin.vaultId, pin.serverEpoch, pin.serverId]);
  if (!result.rowCount) throw new Error('epoch_changed');
}
