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

export const foundationColumns = Object.fromEntries(
  Object.entries(syncColumns).map(([table, columns]) => [table, [...columns]]),
);
export const foundationTables = [...syncTables];
syncColumns.sync_local_state.push('binding_id', 'pull_upper_bound');
syncColumns.sync_inbox.push('accepted_registry_version');
syncColumns.sync_outbox.push('receipt_json');
syncColumns.sync_bindings = [
  'binding_id',
  'local_scope_id',
  'endpoint',
  'server_id',
  'server_epoch',
  'vault_id',
  'device_id',
  'pin_json',
  'registry_json',
  'checkpoint_json',
];
syncColumns.sync_revision_origin = [
  'revision_id',
  'device_id',
  'device_seq',
  'registry_version',
  'log_position',
];
syncColumns.sync_conflicts = [
  'conflict_id',
  'object_id',
  'heads_json',
  'base_revision_id',
  'resolution_id',
];
syncColumns.sync_rejected = ['revision_id', 'last_error'];
syncTables.push(
  'sync_bindings',
  'sync_revision_origin',
  'sync_conflicts',
  'sync_rejected',
);
export const transportMigration = [
  'ALTER TABLE sync_local_state ADD COLUMN binding_id TEXT',
  'ALTER TABLE sync_local_state ADD COLUMN pull_upper_bound TEXT',
  'ALTER TABLE sync_inbox ADD COLUMN accepted_registry_version TEXT',
  'ALTER TABLE sync_outbox ADD COLUMN receipt_json TEXT',
  `CREATE TABLE sync_bindings (binding_id TEXT PRIMARY KEY, local_scope_id TEXT NOT NULL,
    endpoint TEXT NOT NULL, server_id TEXT NOT NULL, server_epoch TEXT NOT NULL, vault_id TEXT NOT NULL, device_id TEXT NOT NULL,
    pin_json TEXT NOT NULL, registry_json TEXT NOT NULL, checkpoint_json TEXT NOT NULL)`,
  `CREATE TABLE sync_revision_origin (revision_id TEXT PRIMARY KEY REFERENCES sync_revisions(revision_id), device_id TEXT NOT NULL,
    device_seq TEXT NOT NULL, registry_version TEXT NOT NULL, log_position TEXT)`,
  `CREATE TABLE sync_conflicts (conflict_id TEXT PRIMARY KEY, object_id TEXT NOT NULL REFERENCES sync_identity(object_id),
    heads_json TEXT NOT NULL, base_revision_id TEXT REFERENCES sync_revisions(revision_id), resolution_id TEXT REFERENCES sync_revisions(revision_id))`,
  'CREATE TABLE sync_rejected (revision_id TEXT PRIMARY KEY REFERENCES sync_revisions(revision_id), last_error TEXT NOT NULL)',
  'CREATE UNIQUE INDEX sync_conflict_open ON sync_conflicts(object_id) WHERE resolution_id IS NULL',
  `CREATE TRIGGER sync_outbox_immutable BEFORE UPDATE OF envelope_json,envelope_sha256,payload_json,commit_id ON sync_outbox
    WHEN OLD.envelope_json IS NOT NULL AND (NEW.envelope_json IS NOT OLD.envelope_json OR NEW.envelope_sha256 IS NOT OLD.envelope_sha256 OR NEW.payload_json IS NOT OLD.payload_json OR NEW.commit_id IS NOT OLD.commit_id)
    BEGIN SELECT RAISE(ABORT,'Prepared envelope is immutable'); END`,
];

// Freeze the prior format before extending the public backup registry.
export const transportColumns = Object.fromEntries(Object.entries(syncColumns).map(([t, c]) => [t, [...c]]));
export const transportTables = [...syncTables];
export const financialColumns: Record<string, string[]> = {
  sync_control: ['id', 'applying', 'paused'],
  sync_dirty: ['table_name', 'local_id', 'operation', 'row_json'],
  sync_series: ['entity_type', 'local_id', 'schedule_epoch', 'structure_json', 'identity_status'],
  sync_slots: ['local_id', 'series_id', 'slot_key', 'slot_id', 'object_id', 'original_date', 'original_index'],
  sync_import_provenance: ['local_id', 'import_key', 'legacy_key'],
  sync_bootstrap: ['id', 'state', 'manifest_json', 'backup_path'],
  sync_review: ['review_id', 'object_id', 'reason', 'payload_json'],
  sync_aliases: ['alias_id', 'object_id'],
};
Object.assign(syncColumns, financialColumns);
syncTables.push(...Object.keys(financialColumns));
export const financialSidecars = [
  'CREATE TABLE sync_control(id INTEGER PRIMARY KEY CHECK(id=1),applying INTEGER NOT NULL DEFAULT 0 CHECK(applying IN (0,1)),paused INTEGER NOT NULL DEFAULT 0 CHECK(paused IN (0,1)))',
  'INSERT INTO sync_control(id) VALUES(1)',
  'CREATE TABLE sync_dirty(table_name TEXT NOT NULL,local_id TEXT NOT NULL,operation TEXT NOT NULL,row_json TEXT NOT NULL,PRIMARY KEY(table_name,local_id))',
  "CREATE TABLE sync_series(entity_type TEXT NOT NULL,local_id TEXT NOT NULL,schedule_epoch TEXT NOT NULL,structure_json TEXT NOT NULL,identity_status TEXT NOT NULL CHECK(identity_status IN ('resolved','identity_unresolved')),PRIMARY KEY(entity_type,local_id))",
  'CREATE TABLE sync_slots(local_id TEXT PRIMARY KEY,series_id TEXT NOT NULL,slot_key TEXT NOT NULL,slot_id TEXT,object_id TEXT NOT NULL,original_date TEXT,original_index INTEGER,UNIQUE(series_id,slot_key))',
  'CREATE TABLE sync_import_provenance(local_id TEXT PRIMARY KEY,import_key TEXT NOT NULL,legacy_key TEXT)',
  "CREATE TABLE sync_bootstrap(id INTEGER PRIMARY KEY CHECK(id=1),state TEXT NOT NULL,manifest_json TEXT NOT NULL,backup_path TEXT NOT NULL)",
  'CREATE TABLE sync_review(review_id TEXT PRIMARY KEY,object_id TEXT,reason TEXT NOT NULL,payload_json TEXT NOT NULL)',
  'CREATE TABLE sync_aliases(alias_id TEXT PRIMARY KEY,object_id TEXT NOT NULL)',
];
export const financialTableTypes = {
  categories: 'category', payment_methods: 'paymentMethod', cards: 'card', recurring_expenses: 'recurring', installment_purchases: 'installmentPurchase', transactions: 'transaction', goals: 'goal', recurring_transaction_priorities: 'recurringPriorityList', transaction_priority_order: 'monthlyPriorityList', monthly_planning: 'monthlyPlanning', goal_monthly_reinforcements: 'goalMonthlyReinforcement',
} as const;
export function financialTriggers(dialect: 'desktop' | 'android', columns: Record<string, string[]>): string[] {
  return Object.keys(financialTableTypes).filter(table => columns[table]?.length).flatMap(table => ['INSERT', 'UPDATE', 'DELETE'].map(action => {
    const row = action === 'DELETE' ? 'OLD' : 'NEW';
    const id = table === 'transaction_priority_order' ? `${row}.month` : table === 'recurring_transaction_priorities' ? "'recurring-priorities'" : `${row}.id`;
    const json = columns[table].flatMap(c => [`'${c}'`, `${row}.${c}`]).join(',');
    // INSERT generated projections are cache; UPDATE promotes, DELETE only tombstones an already promoted object.
    return `CREATE TRIGGER sync_capture_${table}_${action.toLowerCase()} AFTER ${action} ON ${table}
      WHEN (SELECT mode FROM sync_local_state WHERE id=1)='financial' AND (SELECT applying FROM sync_control WHERE id=1)=0
      BEGIN INSERT INTO sync_dirty VALUES('${table}',${id},'${action.toLowerCase()}',json_object(${json})) ON CONFLICT(table_name,local_id) DO UPDATE SET operation=excluded.operation,row_json=excluded.row_json; END`;
  }));
}
/** Rebuild sidecars only. Local financial PKs/FKs and all historical migrations stay intact. */
export const financialMigration = [
  ...transportTables.map(t => `CREATE TEMP TABLE financial_old_${t} AS SELECT * FROM ${t}`),
  ...[...transportTables].reverse().map(t => `DROP TABLE ${t}`),
  ...syncMigration.map(s => s.replace("'disabled','synthetic_manual'", "'disabled','synthetic_manual','financial'").replace("CHECK(entity_type = 'manualTransaction')", "CHECK(entity_type IN ('manualTransaction','transaction','category','paymentMethod','card','recurring','installmentPurchase','goal','recurringPriorityList','monthlyPriorityList'))")),
  ...transportMigration,
  ...transportTables.map(t => `INSERT INTO ${t} SELECT * FROM financial_old_${t} WHERE ${['sync_local_state'].includes(t) ? 'id!=1' : '1=1'}`),
  "UPDATE sync_local_state SET local_scope_id=(SELECT local_scope_id FROM financial_old_sync_local_state),mode=(SELECT mode FROM financial_old_sync_local_state),server_id=(SELECT server_id FROM financial_old_sync_local_state),server_epoch=(SELECT server_epoch FROM financial_old_sync_local_state),vault_id=(SELECT vault_id FROM financial_old_sync_local_state),device_id=(SELECT device_id FROM financial_old_sync_local_state),local_seq=(SELECT local_seq FROM financial_old_sync_local_state),device_seq=(SELECT device_seq FROM financial_old_sync_local_state),received_cursor=(SELECT received_cursor FROM financial_old_sync_local_state),applied_cursor=(SELECT applied_cursor FROM financial_old_sync_local_state),binding_id=(SELECT binding_id FROM financial_old_sync_local_state),pull_upper_bound=(SELECT pull_upper_bound FROM financial_old_sync_local_state) WHERE id=1",
  ...transportTables.map(t => `DROP TABLE financial_old_${t}`),
  ...financialSidecars,
];

/** One aggregate per month. Clearing a component is a put of zero, retaining identity. */
export const monthlyPlanningColumns = ['id', 'month', 'safety_margin_cents', 'created_at', 'updated_at', 'deleted_at'];
export const monthlyPlanningMigration = [
  // Widen sync_identity's SQLite CHECK using the existing transactional sidecar rebuild.
  // Historical financialMigration stays unchanged; queues, receipts and DAG are copied verbatim.
  ...financialMigration.slice(0, -financialSidecars.length).map(statement =>
    statement.replace("'monthlyPriorityList'))", "'monthlyPriorityList','monthlyPlanning'))")),
  `CREATE TABLE monthly_planning (
    id TEXT PRIMARY KEY NOT NULL, month TEXT NOT NULL UNIQUE CHECK(id=month AND month GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]' AND substr(month,6,2) BETWEEN '01' AND '12'),
    safety_margin_cents INTEGER NOT NULL DEFAULT 0 CHECK(typeof(safety_margin_cents)='integer' AND safety_margin_cents BETWEEN 0 AND 9007199254740991),
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT
  )`,
];

/**
 * One row per goal and month. Clearing a reinforcement is a put of zero, so the
 * deterministic identity (derived from the goal and month) can be redefined later.
 * Only deleting the goal retires its rows.
 */
export const goalReinforcementColumns = ['id', 'goal_id', 'month', 'amount_cents', 'created_at', 'updated_at', 'deleted_at'];
export const goalReinforcementMigration = [
  // Same transactional sidecar rebuild used by monthlyPlanningMigration, widening the CHECK once more.
  ...financialMigration.slice(0, -financialSidecars.length).map(statement =>
    statement.replace("'monthlyPriorityList'))", "'monthlyPriorityList','monthlyPlanning','goalMonthlyReinforcement'))")),
  `CREATE TABLE goal_monthly_reinforcements (
    id TEXT PRIMARY KEY NOT NULL, goal_id TEXT NOT NULL REFERENCES goals(id),
    month TEXT NOT NULL CHECK(month GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]' AND substr(month,6,2) BETWEEN '01' AND '12'),
    amount_cents INTEGER NOT NULL DEFAULT 0 CHECK(typeof(amount_cents)='integer' AND amount_cents BETWEEN 0 AND 9007199254740991),
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT,
    UNIQUE(goal_id, month)
  )`,
];
