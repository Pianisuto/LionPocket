import type { SqlWorkflow } from './manual';
export type ServerResetIntent = 'source-of-truth' | 'join-existing';
export function assertServerResetIntent(value: unknown): asserts value is ServerResetIntent {
  if (value !== 'source-of-truth' && value !== 'join-existing')
    throw new Error('Escolha como este aparelho será conectado ao servidor recriado.');
}
/** Unlink only synchronization metadata. Financial rows and import provenance are untouched. */
export function* unlinkRecreatedServer(): SqlWorkflow {
  // Pending financial choices must be resolved before changing their namespace.
  const conflicts = yield {sql:'SELECT conflict_id FROM sync_conflicts WHERE resolution_id IS NULL LIMIT 1'};
  const reviews = yield {sql:"SELECT review_id FROM sync_review WHERE reason NOT IN ('active_key_version','reemission_provenance','legacy_import_review_provenance','catalog_projection_audit','restore_reconnect_backup') AND reason NOT LIKE 'import_receipt:%' LIMIT 1"};
  if (conflicts.length || reviews.length) throw new Error('Resolva as revisões locais antes de recriar a sincronização.');
  yield {sql:'UPDATE sync_control SET applying=1,paused=1 WHERE id=1'};
  for (const table of ['sync_conflicts','sync_rejected','sync_revision_origin','sync_heads','sync_tombstones','sync_revisions','sync_outbox','sync_inbox','sync_dirty','sync_bootstrap','sync_bindings'])
    yield {sql:`DELETE FROM ${table}`};
  // Financial object identities, aliases and schedule slots remain stable across the new vault.
  // Other copies of this bank can join without assigning a second identity to the same record.
  // Import receipts also remain local and continue preventing duplicate financial imports.
  yield {sql:"DELETE FROM sync_review WHERE reason NOT LIKE 'import_receipt:%' AND reason!='legacy_import_review_provenance'"};
  yield {sql:"UPDATE sync_local_state SET mode='disabled',local_scope_id=NULL,binding_id=NULL,server_id=NULL,server_epoch=NULL,vault_id=NULL,device_id=NULL,local_seq='0',device_seq='0',received_cursor='0',applied_cursor='0',pull_upper_bound=NULL WHERE id=1"};
  yield {sql:'UPDATE sync_control SET applying=0,paused=0 WHERE id=1'};
}
