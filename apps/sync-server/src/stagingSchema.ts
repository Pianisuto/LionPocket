/** B stays exclusively here. None of these tables are consumed by ordinary sync. */
export const stagingSchema =
  `
CREATE TABLE IF NOT EXISTS sync_epoch_staging (
 restore_id uuid NOT NULL,vault_id uuid NOT NULL,from_epoch uuid NOT NULL,to_epoch uuid NOT NULL,
 owner_issuer text NOT NULL,owner_subject text NOT NULL,anchor_device_id uuid NOT NULL,
 begin_text text NOT NULL,begin_sha256 text NOT NULL,state text NOT NULL DEFAULT 'uploading'
 CHECK(state IN ('uploading','validated','prepared')),
 commit_count bigint NOT NULL DEFAULT 0 CHECK(commit_count>=0),operation_count bigint NOT NULL DEFAULT 0 CHECK(operation_count>=0),
 batch_count bigint NOT NULL DEFAULT 0 CHECK(batch_count>=0),envelopes_sha256 text NOT NULL,
 heads_sha256 text,manifest_text text,
 PRIMARY KEY(restore_id,vault_id),UNIQUE(vault_id,to_epoch),
 FOREIGN KEY(restore_id,vault_id) REFERENCES sync_epoch_authorizations(restore_id,vault_id)
);
CREATE TABLE IF NOT EXISTS sync_epoch_staging_batches (
 restore_id uuid NOT NULL,vault_id uuid NOT NULL,batch_ordinal bigint NOT NULL CHECK(batch_ordinal>0),
 first_ordinal bigint NOT NULL CHECK(first_ordinal>0),last_ordinal bigint NOT NULL CHECK(last_ordinal>=first_ordinal),
 batch_text text NOT NULL,digest text NOT NULL,
 PRIMARY KEY(restore_id,vault_id,batch_ordinal),
 FOREIGN KEY(restore_id,vault_id) REFERENCES sync_epoch_staging(restore_id,vault_id)
);
CREATE TABLE IF NOT EXISTS sync_epoch_staging_commits (
 restore_id uuid NOT NULL,vault_id uuid NOT NULL,ordinal bigint NOT NULL CHECK(ordinal>0),
 batch_ordinal bigint NOT NULL,commit_id uuid NOT NULL,envelope_text text NOT NULL,digest text NOT NULL,
 PRIMARY KEY(restore_id,vault_id,commit_id),UNIQUE(restore_id,vault_id,ordinal),
 FOREIGN KEY(restore_id,vault_id,batch_ordinal) REFERENCES sync_epoch_staging_batches(restore_id,vault_id,batch_ordinal)
);
CREATE TABLE IF NOT EXISTS sync_epoch_staging_operations (
 restore_id uuid NOT NULL,vault_id uuid NOT NULL,op_id uuid NOT NULL,object_id uuid NOT NULL,
 commit_id uuid NOT NULL,parents uuid[] NOT NULL,
 PRIMARY KEY(restore_id,vault_id,op_id),
 FOREIGN KEY(restore_id,vault_id,commit_id) REFERENCES sync_epoch_staging_commits(restore_id,vault_id,commit_id)
);
CREATE INDEX IF NOT EXISTS staging_operation_parents ON sync_epoch_staging_operations USING gin(parents);
CREATE INDEX IF NOT EXISTS staging_operation_objects ON sync_epoch_staging_operations(restore_id,vault_id,object_id,op_id);
CREATE TABLE IF NOT EXISTS sync_epoch_staging_heads (
 restore_id uuid NOT NULL,vault_id uuid NOT NULL,object_id uuid NOT NULL,op_id uuid NOT NULL,
 PRIMARY KEY(restore_id,vault_id,object_id,op_id),
 FOREIGN KEY(restore_id,vault_id,op_id) REFERENCES sync_epoch_staging_operations(restore_id,vault_id,op_id)
);
CREATE TABLE IF NOT EXISTS sync_epoch_transitions (
 restore_id uuid NOT NULL,vault_id uuid NOT NULL,from_epoch uuid NOT NULL,to_epoch uuid NOT NULL,
 manifest_text text NOT NULL,transition_text text NOT NULL,digest text NOT NULL,state text NOT NULL CHECK(state='prepared'),
 PRIMARY KEY(restore_id,vault_id),UNIQUE(vault_id,to_epoch),
 FOREIGN KEY(restore_id,vault_id) REFERENCES sync_epoch_staging(restore_id,vault_id)
);
CREATE OR REPLACE FUNCTION sync_immutable_staging_bytes() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Staging bytes are immutable'; END $$;
CREATE OR REPLACE FUNCTION sync_preserve_staging_attempt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Staging attempt is immutable'; END IF;
 IF (to_jsonb(OLD)-ARRAY['state','commit_count','operation_count','batch_count','envelopes_sha256','heads_sha256','manifest_text'])
   IS DISTINCT FROM (to_jsonb(NEW)-ARRAY['state','commit_count','operation_count','batch_count','envelopes_sha256','heads_sha256','manifest_text'])
   OR OLD.state='prepared' OR (OLD.state='validated' AND NEW.state<>'prepared')
   OR (OLD.manifest_text IS NOT NULL AND OLD.manifest_text IS DISTINCT FROM NEW.manifest_text) THEN
   RAISE EXCEPTION 'Staging attempt is immutable';
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS immutable_staging_attempt ON sync_epoch_staging;
CREATE TRIGGER immutable_staging_attempt BEFORE UPDATE OR DELETE ON sync_epoch_staging
 FOR EACH ROW EXECUTE FUNCTION sync_preserve_staging_attempt();
` +
  [
    "sync_epoch_staging_batches",
    "sync_epoch_staging_commits",
    "sync_epoch_staging_operations",
    "sync_epoch_transitions",
  ]
    .map(
      (table) => `
DROP TRIGGER IF EXISTS immutable_staging_bytes ON ${table};
CREATE TRIGGER immutable_staging_bytes BEFORE UPDATE OR DELETE ON ${table}
 FOR EACH ROW EXECUTE FUNCTION sync_immutable_staging_bytes();`,
    )
    .join("");
