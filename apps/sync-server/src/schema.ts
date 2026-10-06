import { pairingSchema } from './pairing';
import { readFileSync } from 'node:fs';
import { stagingSchema } from './stagingSchema';
import { generationSchema } from './generations';
import { activationSchema } from './activationSchema';
export const restoreSchema = readFileSync(new URL('./restore-schema.sql', import.meta.url), 'utf8');
/** Public identities and authorization only. No financial plaintext. */
export const controlSchema = `
CREATE TABLE IF NOT EXISTS sync_disabled_accounts (issuer text NOT NULL, subject text NOT NULL, PRIMARY KEY(issuer, subject));
CREATE TABLE IF NOT EXISTS sync_environment (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
  server_id uuid NOT NULL, server_epoch uuid NOT NULL
);
CREATE TABLE IF NOT EXISTS sync_vaults (
  vault_id uuid PRIMARY KEY, owner_issuer text NOT NULL, owner_subject text NOT NULL,
  pin jsonb NOT NULL, registry_version bigint NOT NULL DEFAULT 1
);
ALTER TABLE sync_vaults ADD COLUMN IF NOT EXISTS key_checkpoints jsonb NOT NULL DEFAULT '[]';
ALTER TABLE sync_vaults ADD COLUMN IF NOT EXISTS recovery jsonb;
ALTER TABLE sync_vaults ADD COLUMN IF NOT EXISTS rotation_required boolean NOT NULL DEFAULT false;
-- NULL is a migration sentinel: backfill once, without changing legacy pins or signed artifacts.
ALTER TABLE sync_vaults ADD COLUMN IF NOT EXISTS base_key_version bigint;
ALTER TABLE sync_vaults ADD COLUMN IF NOT EXISTS active_key_version bigint;
UPDATE sync_vaults SET base_key_version=coalesce((pin->>'keyVersion')::bigint,1) WHERE base_key_version IS NULL;
UPDATE sync_vaults SET active_key_version=CASE WHEN jsonb_array_length(key_checkpoints)>0
  THEN (key_checkpoints->-1->>'keyVersion')::bigint ELSE base_key_version END WHERE active_key_version IS NULL;
ALTER TABLE sync_vaults ALTER COLUMN base_key_version SET DEFAULT 1;
ALTER TABLE sync_vaults ALTER COLUMN base_key_version SET NOT NULL;
ALTER TABLE sync_vaults ALTER COLUMN active_key_version SET DEFAULT 1;
ALTER TABLE sync_vaults ALTER COLUMN active_key_version SET NOT NULL;
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='sync_vault_key_range') THEN
    ALTER TABLE sync_vaults ADD CONSTRAINT sync_vault_key_range CHECK(base_key_version>0
      AND active_key_version>=base_key_version AND active_key_version<=9007199254740991
      AND base_key_version=(pin->>'keyVersion')::bigint);
  END IF;
END $$;
CREATE TABLE IF NOT EXISTS sync_grants (
  vault_id uuid NOT NULL REFERENCES sync_vaults(vault_id), registry_version bigint NOT NULL,
  grant_envelope jsonb NOT NULL, PRIMARY KEY(vault_id, registry_version)
);
CREATE TABLE IF NOT EXISTS sync_pairings (
  vault_id uuid NOT NULL REFERENCES sync_vaults(vault_id), device_id uuid NOT NULL,
  fingerprint text NOT NULL, request jsonb NOT NULL, approved boolean NOT NULL DEFAULT false,
  PRIMARY KEY(vault_id, device_id), UNIQUE(vault_id, fingerprint)
);
CREATE TABLE IF NOT EXISTS sync_deliveries (
  vault_id uuid NOT NULL REFERENCES sync_vaults(vault_id), recipient_device_id uuid NOT NULL,
  delivery jsonb NOT NULL, PRIMARY KEY(vault_id, recipient_device_id)
);
CREATE TABLE IF NOT EXISTS sync_http_nonces (
  server_epoch uuid NOT NULL, device_id uuid NOT NULL, nonce text NOT NULL,
  issued_at bigint NOT NULL, PRIMARY KEY(server_epoch, device_id, nonce)
);
` + restoreSchema + pairingSchema;
/** Ciphertext log and public operation graph only. No financial projection or DEK. */
export const commitSchema = `
ALTER TABLE sync_vaults ADD COLUMN IF NOT EXISTS log_position bigint NOT NULL DEFAULT 0 CHECK(log_position>=0);
CREATE TABLE IF NOT EXISTS sync_commits (
 vault_id uuid NOT NULL REFERENCES sync_vaults(vault_id), commit_id uuid NOT NULL,
 device_id uuid NOT NULL, device_seq bigint NOT NULL CHECK(device_seq>0), log_position bigint NOT NULL CHECK(log_position>0),
 envelope_text text NOT NULL, digest text NOT NULL, accepted_registry_version bigint NOT NULL, receipt jsonb NOT NULL,
 PRIMARY KEY(vault_id,commit_id), UNIQUE(vault_id,device_id,device_seq), UNIQUE(vault_id,log_position)
);
CREATE TABLE IF NOT EXISTS sync_operations (
 vault_id uuid NOT NULL, op_id uuid NOT NULL, object_id uuid NOT NULL, commit_id uuid NOT NULL, parents uuid[] NOT NULL,
 PRIMARY KEY(vault_id,op_id), FOREIGN KEY(vault_id,commit_id) REFERENCES sync_commits(vault_id,commit_id)
);
CREATE TABLE IF NOT EXISTS sync_remote_heads (
 vault_id uuid NOT NULL, object_id uuid NOT NULL, op_id uuid NOT NULL,
 PRIMARY KEY(vault_id,object_id,op_id), FOREIGN KEY(vault_id,op_id) REFERENCES sync_operations(vault_id,op_id)
);
`;
export const bindingSchema = `
CREATE TABLE IF NOT EXISTS sync_remote_bindings (
  binding_id uuid PRIMARY KEY, vault_id uuid NOT NULL REFERENCES sync_vaults(vault_id),
  server_epoch uuid NOT NULL, device_id uuid NOT NULL
);
` + generationSchema + stagingSchema + activationSchema;
