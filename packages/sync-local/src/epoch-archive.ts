import {
  assertBase64Url, assertFinancialRevision, assertUuid, canonicalStringify, transportLimits,
  validateGrantChain, verifyEpochRecoveryAuthorization,
  type EpochRecoveryAuthorization, type RevisionPlaintext,
} from '@lionpocket/sync-protocol';
import { DeviceProvisioning, type ProvisionedProfile } from './provisioning';
import { validateKeyCheckpoints } from './security';
import { syncColumns } from './schema';
import { causalCommonBase, causalOrder, type CausalNode } from './causal-graph';
import { verifyBaselineReplay, type BaselineOperation } from './epoch-replay';
import { sql, type LocalSyncDatabase } from './transport-state';
import { incrementDecimal64, type SqlRow, type SqlWorkflow } from './manual';

function recoveryWorkflow(workflow: SqlWorkflow): SqlWorkflow {
  workflow.preserveUncapturedWrites = true;
  return workflow;
}

/** Typed, indexed copies of every sidecar. Keep this list coupled to the ordinary sync schema. */
export const epochArchiveColumns: Record<string, readonly string[]> = {
  ...syncColumns,
};
const primary: Record<string, string[]> = {
  sync_local_state: ['id'], sync_identity: ['object_id'], sync_revisions: ['revision_id'],
  sync_heads: ['object_id', 'revision_id'], sync_tombstones: ['object_id', 'revision_id'],
  sync_outbox: ['commit_id'], sync_inbox: ['commit_id'], sync_bindings: ['binding_id'],
  sync_revision_origin: ['revision_id'], sync_conflicts: ['conflict_id'], sync_rejected: ['revision_id'],
  sync_control: ['id'], sync_dirty: ['table_name', 'local_id'], sync_series: ['entity_type', 'local_id'],
  sync_slots: ['local_id'], sync_import_provenance: ['local_id'], sync_bootstrap: ['id'],
  sync_review: ['review_id'], sync_aliases: ['alias_id'],
};
/** This extension is installed only AFTER a native, opened and hashed SQLite backup.
 * It is deliberately not a normal migration or an activation path in the draft. */
export const epochArchiveSchema = [
  `CREATE TABLE IF NOT EXISTS recovery_generations (
    vault_id TEXT NOT NULL,server_epoch TEXT NOT NULL,sealed INTEGER NOT NULL CHECK(sealed IN (0,1)),
    archive_sha256 TEXT,PRIMARY KEY(vault_id,server_epoch),
    CHECK((sealed=0 AND archive_sha256 IS NULL) OR (sealed=1 AND archive_sha256 IS NOT NULL)))`,
  `CREATE TABLE IF NOT EXISTS recovery_journal (
    restore_id TEXT PRIMARY KEY,vault_id TEXT NOT NULL,from_epoch TEXT NOT NULL,to_epoch TEXT NOT NULL,
    backup_path TEXT NOT NULL,backup_sha256 TEXT NOT NULL,profile_a_json TEXT NOT NULL,authorization_json TEXT NOT NULL,
    phase TEXT NOT NULL CHECK(phase IN ('archived','planned','review-required','cancelled')),
    plan_format INTEGER NOT NULL DEFAULT 1,
    FOREIGN KEY(vault_id,from_epoch) REFERENCES recovery_generations(vault_id,server_epoch),CHECK(from_epoch!=to_epoch))`,
  'CREATE UNIQUE INDEX IF NOT EXISTS recovery_one_attempt ON recovery_journal(vault_id,to_epoch)',
  `CREATE TRIGGER IF NOT EXISTS recovery_journal_identity BEFORE UPDATE OF restore_id,vault_id,from_epoch,to_epoch,
    backup_path,backup_sha256,profile_a_json,authorization_json ON recovery_journal
    BEGIN SELECT RAISE(ABORT,'Recovery attempt is immutable'); END`,
  `CREATE TABLE IF NOT EXISTS recovery_revision_mapping (
    restore_id TEXT NOT NULL REFERENCES recovery_journal(restore_id),revision_a TEXT NOT NULL,revision_b TEXT NOT NULL UNIQUE,
    object_id TEXT NOT NULL,commit_b TEXT NOT NULL UNIQUE,ordinal INTEGER NOT NULL,
    revision_b_json TEXT NOT NULL,parents_b_json TEXT NOT NULL,is_head INTEGER NOT NULL CHECK(is_head IN (0,1)),PRIMARY KEY(restore_id,revision_a),UNIQUE(restore_id,ordinal))`,
  ...['INSERT', 'UPDATE', 'DELETE'].map(action => `CREATE TRIGGER IF NOT EXISTS recovery_mapping_${action.toLowerCase()}
    BEFORE ${action} ON recovery_revision_mapping
    ${action === 'INSERT' ? "WHEN (SELECT phase FROM recovery_journal WHERE restore_id=NEW.restore_id)!='archived'" : ''}
    BEGIN SELECT RAISE(ABORT,'Recovery mapping is immutable'); END`),
  'CREATE TABLE IF NOT EXISTS recovery_plan_reviews(restore_id TEXT NOT NULL REFERENCES recovery_journal(restore_id),reason TEXT NOT NULL,object_id TEXT,revision_a TEXT)',
  ...Object.entries(epochArchiveColumns).flatMap(([table, columns]) => [
    `CREATE TABLE IF NOT EXISTS recovery_archive_${table} (
      vault_id_scope TEXT NOT NULL,epoch_scope TEXT NOT NULL,
      ${columns.map(c => `${c} ${['id', 'applying', 'paused', 'original_index'].includes(c) ? 'INTEGER' : 'TEXT'}`).join(',')},
      PRIMARY KEY(vault_id_scope,epoch_scope,${primary[table].join(',')}),
      FOREIGN KEY(vault_id_scope,epoch_scope) REFERENCES recovery_generations(vault_id,server_epoch))`,
    ...['INSERT', 'UPDATE', 'DELETE'].map(action => `CREATE TRIGGER IF NOT EXISTS recovery_archive_${table}_${action.toLowerCase()}
      BEFORE ${action} ON recovery_archive_${table}
      ${action === 'INSERT' ? 'WHEN (SELECT sealed FROM recovery_generations WHERE vault_id=NEW.vault_id_scope AND server_epoch=NEW.epoch_scope) IS NOT 0' : ''}
      BEGIN SELECT RAISE(ABORT,'Generation archive is immutable'); END`),
  ]),
  `CREATE TRIGGER IF NOT EXISTS recovery_generation_sealed BEFORE UPDATE ON recovery_generations
    WHEN OLD.sealed=1 BEGIN SELECT RAISE(ABORT,'Generation archive is immutable'); END`,
  `CREATE TRIGGER IF NOT EXISTS recovery_generation_delete BEFORE DELETE ON recovery_generations
    BEGIN SELECT RAISE(ABORT,'Generation archive is immutable'); END`,
];
export interface VerifiedAnchorBackup { path: string; sha256: string }
export interface AnchorBackupInspection { sha256: string; integrity: 'ok'; bindingPinJson: string; foreignKeyViolations: number }

function publicProfile(profile: ProvisionedProfile): ProvisionedProfile {
  // Explicit whitelist: a native caller cannot accidentally journal extra secret fields.
  return { formatVersion: 1, installationId: profile.installationId, pin: profile.pin,
    deviceId: profile.deviceId, signingPublicKey: profile.signingPublicKey, boxPublicKey: profile.boxPublicKey,
    grants: profile.grants, ...(profile.checkpoint ? { checkpoint: profile.checkpoint } : {}),
    ...(profile.activeKeyVersion ? { activeKeyVersion: profile.activeKeyVersion } : {}),
    ...(profile.keyCheckpoints ? { keyCheckpoints: profile.keyCheckpoints } : {}) };
}

/** Explicit owner action only. No remote call, profile/secret overwrite, outbox edit or automatic foreground work. */
export async function prepareAnchorArchive(options: {
  db: LocalSyncDatabase;
  device: DeviceProvisioning;
  /** The canonical authorization returned by the successful PR #9 authorization request. */
  acceptedAuthorization: EpochRecoveryAuthorization;
  confirmed: boolean;
  backup: () => Promise<VerifiedAnchorBackup>;
  inspectBackup: (path: string) => Promise<AnchorBackupInspection>;
}): Promise<void> {
  if (!options.confirmed) throw new Error('epoch_anchor_confirmation_required');
  const { device, acceptedAuthorization: authorization, db } = options;
  const registry = validateGrantChain(device.profile.grants, device.profile.pin, device.crypto, device.profile.checkpoint);
  validateKeyCheckpoints(device.profile.keyCheckpoints ?? [], device.profile.pin, device.profile.grants, device);
  const { signature, intent, knownRegistry, ...challenge } = authorization;
  void signature; void intent; void knownRegistry;
  verifyEpochRecoveryAuthorization(authorization, { pin: device.profile.pin, challenge, knownRegistry: registry.checkpoint }, device.crypto);
  const authority = await device.secrets.load(device.scope('authoritySeed'));
  if (!authority) throw new Error('authority_secret_unavailable');
  try {
    const pair = device.crypto.sodium.crypto_sign_seed_keypair(authority);
    device.crypto.erase(pair.privateKey);
    if (device.crypto.encode(pair.publicKey) !== device.profile.pin.authorityPublicKey) throw new Error('key_mismatch');
  } finally { device.crypto.erase(authority); }
  const exists = await db.read("SELECT name FROM sqlite_master WHERE type='table' AND name='recovery_journal'");
  if (exists.length) {
    const [attempt] = await db.read('SELECT authorization_json FROM recovery_journal WHERE restore_id=?', [authorization.restoreId]);
    if (attempt) {
      if (attempt.authorization_json !== canonicalStringify(authorization)) throw new Error('recovery_attempt_mismatch');
      return; // No replacement snapshot/profile/IDs on retry.
    }
  }
  const backup = await options.backup();
  assertBase64Url(backup.sha256, 32);
  if (!backup.path) throw new Error('epoch_backup_invalid');
  const inspected = await options.inspectBackup(backup.path);
  if (inspected.integrity !== 'ok' || inspected.foreignKeyViolations !== 0 || inspected.sha256 !== backup.sha256 ||
      inspected.bindingPinJson !== canonicalStringify(device.profile.pin)) throw new Error('epoch_backup_invalid');
  await db.run(recoveryWorkflow(archiveAnchorGeneration(publicProfile(device.profile), authorization, backup, text => device.crypto.hash(text))));
}

/** Caller must use a transaction covering schema, all source rows, journal and seal; both real adapters do. */
function* archiveAnchorGeneration(profile: ProvisionedProfile, authorization: EpochRecoveryAuthorization,
  backup: VerifiedAnchorBackup, hash: (text: string) => string): SqlWorkflow {
  const [state] = yield sql('SELECT * FROM sync_local_state WHERE id=1');
  const [binding] = yield sql('SELECT * FROM sync_bindings WHERE binding_id=?', [state.binding_id]);
  if (state.mode !== 'financial' || state.vault_id !== profile.pin.vaultId || state.server_epoch !== profile.pin.serverEpoch ||
      state.device_id !== profile.deviceId || binding?.pin_json !== canonicalStringify(profile.pin)) throw new Error('epoch_anchor_binding_mismatch');
  for (const statement of epochArchiveSchema) yield sql(statement);
  const [prior] = yield sql('SELECT * FROM recovery_generations WHERE vault_id=? AND server_epoch=?', [profile.pin.vaultId, profile.pin.serverEpoch]);
  if (prior) throw new Error('epoch_archive_exists'); // A new snapshot requires a separately designed, explicit abandon/restart.
  yield sql('INSERT INTO recovery_generations VALUES(?,?,0,NULL)', [profile.pin.vaultId, profile.pin.serverEpoch]);
  yield sql('INSERT INTO recovery_journal(restore_id,vault_id,from_epoch,to_epoch,backup_path,backup_sha256,profile_a_json,authorization_json,phase,plan_format) VALUES(?,?,?,?,?,?,?,?,?,2)', [authorization.restoreId, profile.pin.vaultId,
    profile.pin.serverEpoch, authorization.toEpoch, backup.path, backup.sha256, canonicalStringify(profile), canonicalStringify(authorization), 'archived']);
  let digest = hash(canonicalStringify({ context: 'LionPocket/local-epoch-archive/v1', profile, authorization }));
  for (const [table, columns] of Object.entries(epochArchiveColumns).sort(([a], [b]) => a < b ? -1 : 1)) {
    let offset = 0;
    for (;;) {
      const rows = yield sql(`SELECT ${columns.join(',')} FROM ${table} ORDER BY ${primary[table].join(',')} LIMIT 100 OFFSET ?`, [offset]);
      if (!rows.length) break;
      for (const row of rows) {
        yield sql(`INSERT INTO recovery_archive_${table} VALUES(${Array(columns.length+2).fill('?').join(',')})`,
          [profile.pin.vaultId, profile.pin.serverEpoch, ...columns.map(c => row[c])]);
        digest = hash(canonicalStringify({ context: 'LionPocket/local-epoch-archive-row/v1', previousSha256: digest, table, row }));
      }
      offset += rows.length;
    }
  }
  yield sql('UPDATE recovery_generations SET sealed=1,archive_sha256=? WHERE vault_id=? AND server_epoch=?',
    [digest, profile.pin.vaultId, profile.pin.serverEpoch]);
}

/** Idempotent extension for PR #10 archives. Old plans stay format 1 and are never consumable. */
export function migrateAnchorPlan(): SqlWorkflow {
  return recoveryWorkflow(migrateAnchorPlanWorkflow());
}
function* migrateAnchorPlanWorkflow(): SqlWorkflow {
  for (const [table, columns] of Object.entries({ recovery_journal: { plan_format: 'INTEGER NOT NULL DEFAULT 1' },
    recovery_revision_mapping: { parents_b_json: "TEXT NOT NULL DEFAULT '[]'", is_head: 'INTEGER NOT NULL DEFAULT 0 CHECK(is_head IN (0,1))' } })) {
    const present = new Set((yield sql(`PRAGMA table_info(${table})`)).map(r => r.name));
    if (!present.size) throw new Error('recovery_attempt_missing');
    for (const [column, definition] of Object.entries(columns))
      if (!present.has(column)) yield sql(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
  yield sql(`CREATE TRIGGER IF NOT EXISTS recovery_plan_format_update BEFORE UPDATE OF plan_format ON recovery_journal
    WHEN NEW.plan_format!=OLD.plan_format AND (OLD.plan_format!=1 OR NEW.plan_format!=2 OR NEW.phase!='archived'
      OR EXISTS(SELECT 1 FROM recovery_revision_mapping WHERE restore_id=OLD.restore_id))
    BEGIN SELECT RAISE(ABORT,'Recovery plan format is immutable'); END`);
  yield sql('CREATE INDEX IF NOT EXISTS recovery_archive_revision_commits ON recovery_archive_sync_revisions(vault_id_scope,epoch_scope,commit_id)');
}

/** Explicitly discard only an incompatible unactivated plan; the sealed archive and backup survive. */
export function discardLegacyAnchorPlan(restoreId: string): SqlWorkflow {
  return recoveryWorkflow(discardLegacyAnchorPlanWorkflow(restoreId));
}
function* discardLegacyAnchorPlanWorkflow(restoreId: string): SqlWorkflow {
  assertUuid(restoreId, '4');
  yield* migrateAnchorPlan();
  const [journal] = yield sql('SELECT * FROM recovery_journal WHERE restore_id=?', [restoreId]);
  if (!journal || journal.plan_format !== 1) throw new Error('recovery_plan_not_legacy');
  // The normal mapping is immutable. This narrow transactional migration deletes only format 1 evidence.
  yield sql('DROP TRIGGER recovery_mapping_delete');
  yield sql('DELETE FROM recovery_revision_mapping WHERE restore_id=?', [restoreId]);
  yield sql(epochArchiveSchema.find(s => s.includes('CREATE TRIGGER IF NOT EXISTS recovery_mapping_delete'))!);
  yield sql('DELETE FROM recovery_plan_reviews WHERE restore_id=?', [restoreId]);
  yield sql("UPDATE recovery_journal SET phase='archived',plan_format=2 WHERE restore_id=?", [restoreId]);
}

/** Complete necessary causal closure, durable mapping and disposable normal-projection oracle.
 * No financial main table, normal outbox, binding or secret is installed in B. */
export function planAnchorBaseline(restoreId: string, uuid: () => string): SqlWorkflow {
  return recoveryWorkflow(planAnchorBaselineWorkflow(restoreId, uuid));
}
function* planAnchorBaselineWorkflow(restoreId: string, uuid: () => string): SqlWorkflow {
  assertUuid(restoreId, '4');
  yield* migrateAnchorPlan();
  const [journal] = yield sql('SELECT * FROM recovery_journal WHERE restore_id=?', [restoreId]);
  if (!journal) throw new Error('recovery_attempt_missing');
  if (journal.plan_format !== 2) throw new Error('incompatible_recovery_plan_format');
  if (journal.phase === 'planned' || journal.phase === 'review-required') return;
  if (journal.phase !== 'archived') throw new Error('recovery_attempt_cancelled');
  const args = [journal.vault_id, journal.from_epoch];
  const query = (table: string) => sql(`SELECT * FROM recovery_archive_${table} WHERE vault_id_scope=? AND epoch_scope=?`, args);
  const reviews: { reason: string; objectId: string | null; revision: string | null }[] = [];
  const informativeReviews = new Set(['active_key_version', 'reemission_provenance', 'legacy_import_review_provenance']);
  const reviewKeys = new Set<string>();
  for (const row of [...(yield query('sync_review')), ...(yield sql('SELECT * FROM sync_review'))])
    if (!informativeReviews.has(String(row.reason)) && !String(row.reason).startsWith('import_receipt:'))
      if (!reviewKeys.has(canonicalStringify([row.reason, row.object_id]))) {
        reviewKeys.add(canonicalStringify([row.reason, row.object_id]));
        reviews.push({ reason: String(row.reason), objectId: row.object_id as string | null, revision: null });
      }
  if ((yield query('sync_series')).some(r => r.identity_status !== 'resolved')) reviews.push({ reason: 'identity_unresolved', objectId: null, revision: null });
  if ((yield query('sync_dirty')).length) reviews.push({ reason: 'uncaptured_local_writes', objectId: null, revision: null });
  if ((yield query('sync_inbox')).some(r => r.state !== 'applied')) reviews.push({ reason: 'unapplied_inbox', objectId: null, revision: null });
  const heads = yield query('sync_heads');
  const [generation] = yield sql('SELECT * FROM recovery_generations WHERE vault_id=? AND server_epoch=?', args);
  if (generation?.sealed !== 1) reviews.push({ reason: 'epoch_archive_unsealed', objectId: null, revision: null });
  // The archive is authoritative, but a newer live anchor must not be silently represented by it.
  const liveHeads = yield sql('SELECT object_id,revision_id FROM sync_heads');
  const headSet = (rows: SqlRow[]) => canonicalStringify(rows.map(r => canonicalStringify([r.object_id, r.revision_id])).sort());
  if (headSet(heads) !== headSet(liveHeads)) reviews.push({ reason: 'anchor_graph_changed_since_archive', objectId: null, revision: null });
  if ((yield sql('SELECT 1 FROM sync_dirty LIMIT 1')).length && !reviews.some(r => r.reason === 'uncaptured_local_writes'))
    reviews.push({ reason: 'uncaptured_local_writes', objectId: null, revision: null });
  if ((yield sql("SELECT 1 FROM sync_inbox WHERE state!='applied' LIMIT 1")).length && !reviews.some(r => r.reason === 'unapplied_inbox'))
    reviews.push({ reason: 'unapplied_inbox', objectId: null, revision: null });
  const headIds = new Set(heads.map(r => String(r.revision_id)));
  const headObjects = new Map(heads.map(r => [String(r.revision_id), String(r.object_id)]));
  const identities = new Map((yield query('sync_identity')).map(r => [String(r.object_id), r]));
  const rejected = new Set([...(yield query('sync_rejected')), ...(yield sql('SELECT revision_id FROM sync_rejected'))].map(r => String(r.revision_id)));
  const old = new Map<string, { row: SqlRow; revision: RevisionPlaintext }>();
  const graph = new Map<string, CausalNode>();
  // Indexed lookups fetch only necessary revisions. Iterative traversal avoids call-stack limits.
  const pending = [...headIds].sort(), seen = new Set<string>();
  while (pending.length) {
    const id = pending.pop()!; if (seen.has(id)) continue; seen.add(id);
    const [row] = yield sql('SELECT * FROM recovery_archive_sync_revisions WHERE vault_id_scope=? AND epoch_scope=? AND revision_id=?', [...args, id]);
    try {
      if (rejected.has(id)) throw new Error('rejected_required_revision');
      if (!row) throw new Error('missing_causal_revision');
      assertUuid(id, '4'); assertUuid(row.commit_id, '4');
      const [live] = yield sql('SELECT * FROM sync_revisions WHERE revision_id=?', [id]);
      if (!live || ['object_id', 'commit_id', 'action', 'authored_at', 'parents_json', 'payload_json'].some(field => live[field] !== row[field]))
        throw new Error('anchor_graph_changed_since_archive');
      const revision: unknown = JSON.parse(String(row.payload_json)); assertFinancialRevision(revision);
      const parents: unknown = JSON.parse(String(row.parents_json));
      if (!Array.isArray(parents) || parents.some(p => typeof p !== 'string') || new Set(parents).size !== parents.length)
        throw new Error('invalid_parents');
      if (parents.length > transportLimits.parents || parents.some((p, i) => i > 0 && parents[i - 1] >= p)) throw new Error('invalid_parents');
      for (const parent of parents) assertUuid(parent, '4');
      if (canonicalStringify(revision) !== row.payload_json || canonicalStringify(parents) !== row.parents_json ||
          revision.action !== row.action || revision.authoredAt !== row.authored_at ||
          identities.get(String(row.object_id))?.entity_type !== revision.entityType ||
          (headObjects.has(id) && headObjects.get(id) !== row.object_id)) throw new Error('invalid_revision');
      if (revision.action === 'put' && 'identityStatus' in revision.snapshot && revision.snapshot.identityStatus !== 'resolved')
        throw new Error('identity_unresolved');
      old.set(id, { row, revision });
      graph.set(id, { objectId: String(row.object_id), parents, dependencies: revision.dependencies });
      pending.push(...parents, ...revision.dependencies.map(d => d.revisionId));
    } catch (error) { reviews.push({ reason: error instanceof Error ? error.message : 'invalid_revision', objectId: row ? String(row.object_id) : null, revision: id }); }
  }
  for (const [id, node] of graph) {
    for (const parent of node.parents) if (graph.get(parent)?.objectId !== node.objectId)
      reviews.push({ reason: 'invalid_parent_object', objectId: node.objectId, revision: id });
    for (const dep of node.dependencies) if (graph.get(dep.revisionId)?.objectId !== dep.objectId)
      reviews.push({ reason: 'invalid_dependency_object', objectId: node.objectId, revision: id });
    // Ordinary applyCommit rejects resurrection. Do not bypass that invariant during restore.
    if (old.get(id)!.revision.action === 'put' && node.parents.some(p => old.get(p)?.revision.action === 'delete'))
      reviews.push({ reason: 'tombstone_resurrection', objectId: node.objectId, revision: id });
  }
  const tombstones = yield query('sync_tombstones');
  const tombstoneIds = new Set(tombstones.map(r => String(r.revision_id)));
  for (const row of tombstones) {
    const revision = old.get(String(row.revision_id));
    if (!revision) reviews.push({ reason: 'disconnected_historical_tombstone', objectId: String(row.object_id), revision: String(row.revision_id) });
    else if (revision.row.object_id !== row.object_id || revision.revision.action !== 'delete' || revision.revision.deletedAt !== row.deleted_at)
      reviews.push({ reason: 'invalid_tombstone', objectId: String(row.object_id), revision: String(row.revision_id) });
  }
  for (const [id, { row, revision }] of old) if (revision.action === 'delete' && !tombstoneIds.has(id))
    reviews.push({ reason: 'missing_tombstone', objectId: String(row.object_id), revision: id });
  // projectObject currently selects a delete row without a semantic tie breaker. Different
  // deletion authorship among necessary tombstones is not safe to replay by a new ID ordering.
  const deleteAuthorship = new Map<string, string>();
  for (const [id, { row, revision }] of old) if (revision.action === 'delete') {
    const objectId = String(row.object_id), prior = deleteAuthorship.get(objectId);
    if (prior && prior !== revision.authoredAt) reviews.push({ reason: 'ambiguous_tombstone_projection', objectId, revision: id });
    deleteAuthorship.set(objectId, revision.authoredAt);
  }
  let ordered: string[] = [];
  for (const relation of ['parents', 'dependencies', 'combined'] as const) {
    try { const result = causalOrder(graph, relation); if (relation === 'combined') ordered = result; }
    catch (error) { reviews.push({ reason: (error as Error).message, objectId: null, revision: null }); }
  }
  const block = function* (): SqlWorkflow {
    for (const r of reviews) yield sql('INSERT INTO recovery_plan_reviews VALUES(?,?,?,?)', [restoreId, r.reason, r.objectId, r.revision]);
    yield sql("UPDATE recovery_journal SET phase='review-required' WHERE restore_id=?", [restoreId]);
  };
  if (reviews.length) { yield* block(); return; }
  // Reserve against every old transport ID, including empty/control commits, plus every new ID.
  const reserved = new Set<string>();
  for (const table of ['sync_revisions', 'sync_outbox', 'sync_inbox']) {
    let after = '';
    const key = table === 'sync_revisions' ? 'revision_id' : 'commit_id';
    for (;;) {
      const rows = yield sql(`SELECT * FROM recovery_archive_${table} WHERE vault_id_scope=? AND epoch_scope=? AND ${key}>? ORDER BY ${key} LIMIT 100`, [...args, after]);
      if (!rows.length) break;
      for (const row of rows) { reserved.add(String(row.commit_id)); if (row.revision_id) reserved.add(String(row.revision_id)); }
      after = String(rows.at(-1)![key]);
    }
  }
  const fresh = () => { const id = uuid(); assertUuid(id, '4'); if (reserved.has(id)) throw new Error('reused_transport_id'); reserved.add(id); return id; };
  const mapping = new Map<string, string>();
  const operationsA: BaselineOperation[] = [], operationsB: BaselineOperation[] = [];
  const graphB = new Map<string, CausalNode>();
  for (const id of ordered) {
    const { row, revision } = old.get(id)!, node = graph.get(id)!;
    const revisionB = fresh(), commitB = fresh(); mapping.set(id, revisionB);
    const parents = node.parents.map(p => mapping.get(p)!).sort();
    const next: RevisionPlaintext = { ...revision, provenance: { ...revision.provenance, origin: 'restore' }, restoredFrom: id,
      dependencies: revision.dependencies.map(d => ({ ...d, revisionId: mapping.get(d.revisionId)! })) };
    assertFinancialRevision(next);
    operationsA.push({ opId: id, commitId: String(row.commit_id), objectId: node.objectId, parents: node.parents, revision, isHead: headIds.has(id) });
    operationsB.push({ opId: revisionB, commitId: commitB, objectId: node.objectId, parents, revision: next, isHead: headIds.has(id) });
    graphB.set(revisionB, { objectId: node.objectId, parents, dependencies: next.dependencies });
  }
  const headsByObject = new Map<string, string[]>();
  for (const head of heads) {
    const objectId = String(head.object_id), list = headsByObject.get(objectId) ?? [];
    list.push(String(head.revision_id)); headsByObject.set(objectId, list);
  }
  for (const [objectId, a] of headsByObject) {
    const baseA = causalCommonBase(graph, a), baseB = causalCommonBase(graphB, a.map(id => mapping.get(id)!));
    if (baseB !== (baseA === null ? null : mapping.get(baseA))) reviews.push({ reason: 'common_base_mismatch', objectId, revision: baseA });
  }
  if (!reviews.length) {
    try { yield* verifyBaselineReplay(args, operationsA, operationsB, mapping); }
    catch (error) { reviews.push({ reason: `baseline_replay:${(error as Error).message}`, objectId: null, revision: null }); }
  }
  if (reviews.length) { yield* block(); return; }
  for (const [index, op] of operationsB.entries())
    yield sql('INSERT INTO recovery_revision_mapping(restore_id,revision_a,revision_b,object_id,commit_b,ordinal,revision_b_json,parents_b_json,is_head) VALUES(?,?,?,?,?,?,?,?,?)',
      [restoreId, op.revision.restoredFrom!, op.opId, op.objectId, op.commitId, index + 1, canonicalStringify(op.revision), canonicalStringify(op.parents), op.isHead ? 1 : 0]);
  yield sql("UPDATE recovery_journal SET phase='planned' WHERE restore_id=?", [restoreId]);
}

/** v1 JSON exports do not include this extension. Fail explicitly instead of silently losing recovery evidence. */
export async function assertEpochArchiveExportSupported(db: Pick<LocalSyncDatabase, 'read'>): Promise<void> {
  if ((await db.read("SELECT name FROM sqlite_master WHERE type='table' AND name='recovery_journal'")).length &&
      (await db.read('SELECT restore_id FROM recovery_journal LIMIT 1')).length) throw new Error('epoch_archive_requires_sqlite_backup');
}

export async function plannedAnchorOperations(db: LocalSyncDatabase, restoreId: string) {
  assertUuid(restoreId, '4');
  const [journal] = await db.read('SELECT * FROM recovery_journal WHERE restore_id=?', [restoreId]);
  if (journal?.plan_format !== 2) throw new Error('incompatible_recovery_plan_format');
  if (journal?.phase !== 'planned') throw new Error('epoch_baseline_review_required');
  // A paginated uploader must consume these rows by ordinal; this helper reads a single bounded page.
  return async (afterOrdinal = 0) => {
    if (!Number.isSafeInteger(afterOrdinal) || afterOrdinal < 0) throw new Error('invalid_ordinal');
    const [current] = await db.read('SELECT phase,plan_format FROM recovery_journal WHERE restore_id=?', [restoreId]);
    if (current?.phase !== 'planned' || current.plan_format !== 2) throw new Error('epoch_baseline_review_required');
    const rows = await db.read('SELECT * FROM recovery_revision_mapping WHERE restore_id=? AND ordinal>? ORDER BY ordinal LIMIT 100', [restoreId, afterOrdinal]);
    return rows.map(r => ({ ordinal: Number(r.ordinal), commitId: String(r.commit_b),
      opId: String(r.revision_b), objectId: String(r.object_id), parents: JSON.parse(String(r.parents_b_json)) as string[], isHead: r.is_head === 1, revision: JSON.parse(String(r.revision_b_json)) as RevisionPlaintext }));
  };
}

/** Only the local, unactivated plan exists in this draft. Cancellation preserves backup, archive, mapping and A. */
export function cancelAnchorPlan(restoreId: string): SqlWorkflow {
  return recoveryWorkflow(cancelAnchorPlanWorkflow(restoreId));
}
function* cancelAnchorPlanWorkflow(restoreId: string): SqlWorkflow {
  assertUuid(restoreId, '4');
  const [journal] = yield sql('SELECT * FROM recovery_journal WHERE restore_id=?', [restoreId]);
  if (!journal) throw new Error('recovery_attempt_missing');
  if ((yield sql("SELECT name FROM sqlite_master WHERE name='recovery_b_saga'")).length) {
    const [saga] = yield sql('SELECT * FROM recovery_b_saga WHERE restore_id=?', [restoreId]);
    if (saga?.remote_started === 1) throw new Error('remote_staging_requires_resume');
    if (saga) {
      if (saga.preparation_format !== 2) throw new Error('legacy_preparation_blocked');
      if (saga.phase !== 'cancelled') yield sql("UPDATE recovery_b_saga SET resume_phase=phase,phase='cancelled' WHERE restore_id=?", [restoreId]);
      return; // The reviewed causal plan remains available for explicit resume of this same B.
    }
  }
  yield sql("UPDATE recovery_journal SET phase='cancelled' WHERE restore_id=?", [restoreId]);
}

/** Public plan commitments, without snapshots. These are not a staged manifest or a proof of activation. */
export async function anchorPlanCommitments(db: LocalSyncDatabase, restoreId: string, hash: (text: string) => string) {
  const [journal] = await db.read('SELECT * FROM recovery_journal WHERE restore_id=?', [restoreId]);
  if (journal?.plan_format !== 2) throw new Error('incompatible_recovery_plan_format');
  if (journal?.phase !== 'planned') throw new Error('epoch_baseline_review_required');
  const [generation] = await db.read('SELECT * FROM recovery_generations WHERE vault_id=? AND server_epoch=?',
    [journal.vault_id, journal.from_epoch]);
  if (generation?.sealed !== 1) throw new Error('epoch_archive_unsealed');
  const scope = { restoreId, vaultId: String(journal.vault_id), fromEpoch: String(journal.from_epoch), toEpoch: String(journal.to_epoch) };
  let mappingSha256 = hash(canonicalStringify({ context: 'LionPocket/epoch-baseline-mapping/v2', ...scope }));
  let operationCount = '0', ordinal = 0;
  const page = await plannedAnchorOperations(db, restoreId);
  for (;;) {
    const rows = await page(ordinal);
    if (!rows.length) break;
    for (const row of rows) {
      mappingSha256 = hash(canonicalStringify({ context: 'LionPocket/epoch-baseline-mapping-entry/v2', previousSha256: mappingSha256,
        ordinal: row.ordinal, revisionA: row.revision.restoredFrom, revisionB: row.opId, objectId: row.objectId,
        commitId: row.commitId, parentsB: row.parents, isHead: row.isHead, revisionSha256: hash(canonicalStringify(row.revision)) }));
      ordinal = row.ordinal; operationCount = incrementDecimal64(operationCount);
    }
  }
  let headsSha256 = hash(canonicalStringify({ context: 'LionPocket/epoch-baseline-heads/v1', ...scope }));
  let object = '', revision = '';
  for (;;) {
    const rows = await db.read(`SELECT object_id,revision_b FROM recovery_revision_mapping
      WHERE restore_id=? AND is_head=1 AND (object_id>? OR (object_id=? AND revision_b>?)) ORDER BY object_id,revision_b LIMIT 100`,
      [restoreId, object, object, revision]);
    if (!rows.length) break;
    for (const row of rows) {
      object = String(row.object_id); revision = String(row.revision_b);
      headsSha256 = hash(canonicalStringify({ context: 'LionPocket/epoch-baseline-head-entry/v1', previousSha256: headsSha256,
        objectId: object, revisionId: revision }));
    }
  }
  return { archiveSha256: String(generation.archive_sha256), mappingSha256, headsSha256, operationCount };
}

/** SQLite backup verification keeps old evidence valid, while validating usable v2 plans.
 * A local plan is never interpreted as an active generation or a remote server artifact. */
export async function verifyAnchorPlanBackup(db: Pick<LocalSyncDatabase, 'read'>): Promise<void> {
  if (!(await db.read("SELECT name FROM sqlite_master WHERE type='table' AND name='recovery_journal'")).length) return;
  const journals = await db.read('SELECT * FROM recovery_journal');
  for (const journal of journals) {
    if (journal.plan_format === undefined || journal.plan_format === 1) continue; // Valid historical evidence, unusable for B.
    if (journal.plan_format !== 2) throw new Error('incompatible_recovery_plan_format');
    const [generation] = await db.read('SELECT * FROM recovery_generations WHERE vault_id=? AND server_epoch=?', [journal.vault_id, journal.from_epoch]);
    if (generation?.sealed !== 1 || !generation.archive_sha256) throw new Error('epoch_archive_unsealed');
    const rows = new Map<string, SqlRow>();
    let ordinal = 0;
    const ids = new Set<string>();
    for (;;) {
      const page = await db.read('SELECT * FROM recovery_revision_mapping WHERE restore_id=? AND ordinal>? ORDER BY ordinal LIMIT 100', [journal.restore_id, ordinal]);
      if (!page.length) break;
      if (!['planned', 'cancelled'].includes(String(journal.phase))) throw new Error('partial_recovery_plan');
      for (const row of page) {
        if (row.ordinal !== ++ordinal || ids.has(String(row.revision_b)) || ids.has(String(row.commit_b)) || row.commit_b === row.revision_b) throw new Error('invalid_recovery_mapping');
        assertUuid(row.revision_b, '4'); assertUuid(row.commit_b, '4'); ids.add(String(row.revision_b)); ids.add(String(row.commit_b));
        const [source] = await db.read('SELECT * FROM recovery_archive_sync_revisions WHERE vault_id_scope=? AND epoch_scope=? AND revision_id=?', [journal.vault_id, journal.from_epoch, row.revision_a]);
        if (!source || source.object_id !== row.object_id) throw new Error('invalid_recovery_mapping');
        const revision: unknown = JSON.parse(String(row.revision_b_json)); assertFinancialRevision(revision);
        const original: RevisionPlaintext = JSON.parse(String(source.payload_json));
        const expected = { ...original, provenance: { ...original.provenance, origin: 'restore' }, restoredFrom: row.revision_a,
          dependencies: original.dependencies.map(d => ({ ...d, revisionId: rows.get(d.revisionId)?.revision_b })) };
        const parents = (JSON.parse(String(source.parents_json)) as string[]).map(id => rows.get(id)?.revision_b).sort();
        if (parents.some(id => !id) || expected.dependencies.some(d => !d.revisionId) || canonicalStringify(parents) !== row.parents_b_json ||
            canonicalStringify(expected) !== canonicalStringify(revision) || canonicalStringify(revision) !== row.revision_b_json || ![0, 1].includes(Number(row.is_head))) throw new Error('invalid_recovery_mapping');
        if ((await db.read(`SELECT revision_id FROM recovery_archive_sync_revisions WHERE vault_id_scope=? AND epoch_scope=? AND
          (revision_id IN (?,?) OR commit_id IN (?,?)) LIMIT 1`, [journal.vault_id, journal.from_epoch, row.revision_b, row.commit_b, row.revision_b, row.commit_b])).length) throw new Error('reused_transport_id');
        rows.set(String(row.revision_a), row);
      }
    }
    if (journal.phase === 'planned' || rows.size) {
      const heads = await db.read('SELECT * FROM recovery_archive_sync_heads WHERE vault_id_scope=? AND epoch_scope=?', [journal.vault_id, journal.from_epoch]);
      const expected = new Set(heads.map(h => String(h.revision_id)));
      if (heads.some(h => rows.get(String(h.revision_id))?.is_head !== 1 || rows.get(String(h.revision_id))?.object_id !== h.object_id) ||
          [...rows.values()].some(r => (r.is_head === 1) !== expected.has(String(r.revision_a)))) throw new Error('invalid_recovery_heads');
    }
  }
}
