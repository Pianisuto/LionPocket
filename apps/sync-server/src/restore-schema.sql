-- Public operational history. No private authority, data keys or financial plaintext.
CREATE TABLE IF NOT EXISTS sync_restores (
  restore_id uuid PRIMARY KEY, server_id uuid NOT NULL,
  from_epoch uuid NOT NULL, to_epoch uuid NOT NULL UNIQUE,
  displaced_epoch uuid NOT NULL, restored_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  backup_manifest_sha256 text NOT NULL,
  CHECK(from_epoch <> to_epoch), CHECK(displaced_epoch <> to_epoch)
);
CREATE TABLE IF NOT EXISTS sync_restore_vaults (
  restore_id uuid NOT NULL REFERENCES sync_restores(restore_id), vault_id uuid NOT NULL,
  source_epoch uuid NOT NULL,
  state text NOT NULL DEFAULT 'awaiting_authority'
    CHECK(state IN ('awaiting_authority','authorized_awaiting_baseline','recovered')),
  PRIMARY KEY(restore_id,vault_id)
);
CREATE TABLE IF NOT EXISTS sync_epoch_challenges (
  challenge_id uuid PRIMARY KEY, restore_id uuid NOT NULL,
  vault_id uuid NOT NULL, owner_issuer text NOT NULL, owner_subject text NOT NULL,
  challenge jsonb NOT NULL, expires_at timestamptz NOT NULL, consumed boolean NOT NULL DEFAULT false,
  FOREIGN KEY(restore_id,vault_id) REFERENCES sync_restore_vaults(restore_id,vault_id)
);
CREATE INDEX IF NOT EXISTS sync_epoch_challenges_vault ON sync_epoch_challenges(restore_id,vault_id);
CREATE TABLE IF NOT EXISTS sync_epoch_authorizations (
  restore_id uuid NOT NULL, vault_id uuid NOT NULL,
  challenge_id uuid NOT NULL UNIQUE REFERENCES sync_epoch_challenges(challenge_id),
  authorization_envelope jsonb NOT NULL, known_grants jsonb NOT NULL,
  PRIMARY KEY(restore_id,vault_id),
  FOREIGN KEY(restore_id,vault_id) REFERENCES sync_restore_vaults(restore_id,vault_id)
);
