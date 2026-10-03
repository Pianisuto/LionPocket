/** Immutable activation audit, separate from prepared artifacts and the ordinary ciphertext log. */
export const activationSchema = `
CREATE TABLE IF NOT EXISTS sync_epoch_activations (
 activation_id uuid PRIMARY KEY,restore_id uuid NOT NULL,vault_id uuid NOT NULL,
 from_epoch uuid NOT NULL,to_epoch uuid NOT NULL,anchor_device_id uuid NOT NULL,
 request_text text NOT NULL,request_sha256 text NOT NULL,manifest_sha256 text NOT NULL,
 transition_sha256 text NOT NULL,record jsonb NOT NULL,log_position bigint NOT NULL CHECK(log_position>=0),
 activated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(restore_id,vault_id),UNIQUE(vault_id,to_epoch),
 FOREIGN KEY(restore_id,vault_id) REFERENCES sync_epoch_transitions(restore_id,vault_id),
 FOREIGN KEY(vault_id,from_epoch) REFERENCES sync_generations(vault_id,server_epoch),
 FOREIGN KEY(vault_id,to_epoch) REFERENCES sync_generations(vault_id,server_epoch)
);
DROP TRIGGER IF EXISTS immutable_activation ON sync_epoch_activations;
CREATE TRIGGER immutable_activation BEFORE UPDATE OR DELETE ON sync_epoch_activations
 FOR EACH ROW EXECUTE FUNCTION sync_immutable_staging_bytes();
`;
