/** Additive sidecars. No financial FK: identity and history survive local deletion. */
export const syncColumns: Record<string, string[]> = {
  sync_local_state: [
    'id',
    'local_scope_id',
    'mode',
    'server_id',
    'server_epoch',
    'vault_id',
    'device_id',
    'local_seq',
    'device_seq',
    'received_cursor',
    'applied_cursor',
  ],
  sync_identity: ['entity_type', 'local_id', 'object_id'],
  sync_revisions: [
    'revision_id',
    'object_id',
    'commit_id',
    'local_seq',
    'action',
    'authored_at',
    'parents_json',
    'payload_json',
  ],
  sync_heads: ['object_id', 'revision_id'],
  sync_tombstones: ['object_id', 'revision_id', 'deleted_at'],
  sync_outbox: [
    'commit_id',
    'local_seq',
    'state',
    'payload_json',
    'envelope_json',
    'envelope_sha256',
    'last_error',
  ],
  sync_inbox: [
    'commit_id',
    'log_position',
    'state',
    'envelope_json',
    'last_error',
  ],
};
export const syncTables = Object.keys(syncColumns);
export const syncMigration = [
  `CREATE TABLE sync_local_state (
    id INTEGER PRIMARY KEY CHECK(id = 1), local_scope_id TEXT,
    mode TEXT NOT NULL CHECK(mode IN ('disabled','synthetic_manual')),
    server_id TEXT, server_epoch TEXT, vault_id TEXT, device_id TEXT,
    local_seq TEXT NOT NULL DEFAULT '0', device_seq TEXT NOT NULL DEFAULT '0', received_cursor TEXT NOT NULL DEFAULT '0', applied_cursor TEXT NOT NULL DEFAULT '0',
    CHECK(mode = 'disabled' OR local_scope_id IS NOT NULL))`,
  `INSERT INTO sync_local_state(id, mode) VALUES(1, 'disabled')`,
  `CREATE TABLE sync_identity (
    entity_type TEXT NOT NULL CHECK(entity_type = 'manualTransaction'), local_id TEXT NOT NULL,
    object_id TEXT NOT NULL UNIQUE, PRIMARY KEY(entity_type,local_id))`,
  `CREATE TABLE sync_revisions (
    revision_id TEXT PRIMARY KEY NOT NULL, object_id TEXT NOT NULL REFERENCES sync_identity(object_id),
    commit_id TEXT NOT NULL, local_seq TEXT NOT NULL UNIQUE, action TEXT NOT NULL CHECK(action IN ('put','delete')),
    authored_at TEXT NOT NULL, parents_json TEXT NOT NULL, payload_json TEXT NOT NULL,
    UNIQUE(object_id,revision_id))`,
  `CREATE TABLE sync_heads (
    object_id TEXT NOT NULL, revision_id TEXT NOT NULL,
    PRIMARY KEY(object_id,revision_id),
    FOREIGN KEY(object_id,revision_id) REFERENCES sync_revisions(object_id,revision_id))`,
  `CREATE TABLE sync_tombstones (
    object_id TEXT NOT NULL, revision_id TEXT NOT NULL, deleted_at TEXT NOT NULL,
    PRIMARY KEY(object_id,revision_id),
    FOREIGN KEY(object_id,revision_id) REFERENCES sync_revisions(object_id,revision_id))`,
  `CREATE TABLE sync_outbox (
    commit_id TEXT PRIMARY KEY NOT NULL, local_seq TEXT NOT NULL UNIQUE,
    state TEXT NOT NULL CHECK(state IN ('pending','prepared','in_flight','acknowledged','retry','blocked')),
    payload_json TEXT NOT NULL, envelope_json TEXT, envelope_sha256 TEXT, last_error TEXT,
    CHECK((envelope_json IS NULL) = (envelope_sha256 IS NULL)))`,
  `CREATE TABLE sync_inbox (
    commit_id TEXT PRIMARY KEY NOT NULL, log_position TEXT NOT NULL UNIQUE,
    state TEXT NOT NULL CHECK(state IN ('received','applied','quarantined')),
    envelope_json TEXT NOT NULL, last_error TEXT)`,
];
