import {
  assertBase64Url, assertFinancialRevision, assertUuid, canonicalStringify,
  validateGrantChain, verifyEpochRecoveryAuthorization,
  type EpochRecoveryAuthorization, type RevisionPlaintext,
} from '@lionpocket/sync-protocol';
import { DeviceProvisioning, type ProvisionedProfile } from './provisioning';
import { validateKeyCheckpoints } from './security';
import { syncColumns } from './schema';
import { sql, type LocalSyncDatabase } from './transport-state';
import { incrementDecimal64, type SqlRow, type SqlWorkflow } from './manual';

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
    FOREIGN KEY(vault_id,from_epoch) REFERENCES recovery_generations(vault_id,server_epoch),CHECK(from_epoch!=to_epoch))`,
  'CREATE UNIQUE INDEX IF NOT EXISTS recovery_one_attempt ON recovery_journal(vault_id,to_epoch)',
  `CREATE TRIGGER IF NOT EXISTS recovery_journal_identity BEFORE UPDATE OF restore_id,vault_id,from_epoch,to_epoch,
    backup_path,backup_sha256,profile_a_json,authorization_json ON recovery_journal
    BEGIN SELECT RAISE(ABORT,'Recovery attempt is immutable'); END`,
  `CREATE TABLE IF NOT EXISTS recovery_revision_mapping (
    restore_id TEXT NOT NULL REFERENCES recovery_journal(restore_id),revision_a TEXT NOT NULL,revision_b TEXT NOT NULL UNIQUE,
    object_id TEXT NOT NULL,commit_b TEXT NOT NULL UNIQUE,ordinal INTEGER NOT NULL,
    revision_b_json TEXT NOT NULL,PRIMARY KEY(restore_id,revision_a),UNIQUE(restore_id,ordinal))`,
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
  await db.run(archiveAnchorGeneration(publicProfile(device.profile), authorization, backup, text => device.crypto.hash(text)));
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
  yield sql('INSERT INTO recovery_journal VALUES(?,?,?,?,?,?,?,?,?)', [authorization.restoreId, profile.pin.vaultId,
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

/** Durable planning only. No financial projection or normal outbox is installed.
 * Do not smuggle historical dependencies into B as extra live heads. */
export function* planAnchorBaseline(restoreId: string, uuid: () => string): SqlWorkflow {
  assertUuid(restoreId, '4');
  const [journal] = yield sql('SELECT * FROM recovery_journal WHERE restore_id=?', [restoreId]);
  if (!journal) throw new Error('recovery_attempt_missing');
  if (journal.phase === 'planned' || journal.phase === 'review-required') return;
  if (journal.phase !== 'archived') throw new Error('recovery_attempt_cancelled');
  const args = [journal.vault_id, journal.from_epoch];
  const query = (table: string) => sql(`SELECT * FROM recovery_archive_${table} WHERE vault_id_scope=? AND epoch_scope=?`, args);
  const reviews: { reason: string; objectId: string | null; revision: string | null }[] = [];
  const informativeReviews = new Set(['active_key_version', 'reemission_provenance', 'legacy_import_review_provenance']);
  for (const row of yield query('sync_review'))
    if (!informativeReviews.has(String(row.reason)) && !String(row.reason).startsWith('import_receipt:'))
      reviews.push({ reason: String(row.reason), objectId: row.object_id as string | null, revision: null });
  if ((yield query('sync_series')).some(r => r.identity_status !== 'resolved')) reviews.push({ reason: 'identity_unresolved', objectId: null, revision: null });
  if ((yield query('sync_dirty')).length) reviews.push({ reason: 'uncaptured_local_writes', objectId: null, revision: null });
  if ((yield query('sync_inbox')).some(r => r.state !== 'applied')) reviews.push({ reason: 'unapplied_inbox', objectId: null, revision: null });
  const heads = yield query('sync_heads');
  const identities = new Map((yield query('sync_identity')).map(r => [String(r.object_id), r]));
  const rejected = new Set((yield query('sync_rejected')).map(r => String(r.revision_id)));
  const old = new Map<string, { row: SqlRow; revision: RevisionPlaintext }>();
  for (const head of heads) {
    const [row] = yield sql('SELECT * FROM recovery_archive_sync_revisions WHERE vault_id_scope=? AND epoch_scope=? AND revision_id=?', [...args, head.revision_id]);
    try {
      if (!row || row.object_id !== head.object_id || rejected.has(String(head.revision_id))) throw new Error('invalid_head');
      const revision: unknown = JSON.parse(String(row.payload_json));
      assertFinancialRevision(revision);
      if (canonicalStringify(revision) !== row.payload_json || revision.action !== row.action || revision.authoredAt !== row.authored_at ||
          identities.get(String(head.object_id))?.entity_type !== revision.entityType) throw new Error('invalid_head');
      if (revision.action === 'put' && 'identityStatus' in revision.snapshot && revision.snapshot.identityStatus !== 'resolved')
        throw new Error('identity_unresolved');
      old.set(String(head.revision_id), { row, revision });
    } catch { reviews.push({ reason: 'invalid_head_snapshot', objectId: String(head.object_id), revision: String(head.revision_id) }); }
  }
  // A historical tombstone not present among heads cannot be silently discarded.
  for (const tombstone of yield query('sync_tombstones'))
    if (!old.has(String(tombstone.revision_id))) reviews.push({ reason: 'historical_tombstone_requires_graph_rebase', objectId: String(tombstone.object_id), revision: String(tombstone.revision_id) });
  for (const [id, { row, revision }] of old)
    for (const dep of revision.dependencies) {
      const found = old.get(dep.revisionId);
      if (!found || found.row.object_id !== dep.objectId) reviews.push({ reason: 'historical_dependency_requires_graph_rebase', objectId: String(row.object_id), revision: id });
    }
  const ordered: string[] = [], complete = new Set<string>(), visiting = new Set<string>();
  const visit = (id: string): void => {
    if (complete.has(id)) return;
    if (visiting.has(id)) throw new Error('cyclic_dependencies');
    visiting.add(id);
    for (const dep of old.get(id)!.revision.dependencies) if (old.has(dep.revisionId)) visit(dep.revisionId);
    visiting.delete(id); complete.add(id); ordered.push(id);
  };
  try { for (const id of [...old.keys()].sort()) visit(id); }
  catch { reviews.push({ reason: 'cyclic_dependencies', objectId: null, revision: null }); }
  if (reviews.length) {
    for (const r of reviews) yield sql('INSERT INTO recovery_plan_reviews VALUES(?,?,?,?)', [restoreId, r.reason, r.objectId, r.revision]);
    yield sql("UPDATE recovery_journal SET phase='review-required' WHERE restore_id=?", [restoreId]);
    return;
  }
  const mapping = new Map(ordered.map(id => [id, uuid()]));
  for (const [index, id] of ordered.entries()) {
    const { row, revision } = old.get(id)!;
    const next: RevisionPlaintext = { ...revision, provenance: { ...revision.provenance, origin: 'restore' }, restoredFrom: id,
      dependencies: revision.dependencies.map(d => ({ ...d, revisionId: mapping.get(d.revisionId)! })) };
    assertFinancialRevision(next);
    const revisionB = mapping.get(id)!;
    assertUuid(revisionB, '4');
    if ((yield sql('SELECT revision_id FROM recovery_archive_sync_revisions WHERE vault_id_scope=? AND epoch_scope=? AND revision_id=?', [...args, revisionB])).length)
      throw new Error('reused_revision_id');
    const commitB = uuid(); assertUuid(commitB, '4');
    if ((yield sql('SELECT commit_id FROM recovery_archive_sync_revisions WHERE vault_id_scope=? AND epoch_scope=? AND commit_id=?', [...args, commitB])).length)
      throw new Error('reused_commit_id');
    yield sql('INSERT INTO recovery_revision_mapping VALUES(?,?,?,?,?,?,?)', [restoreId, id, revisionB, row.object_id, commitB, index+1, canonicalStringify(next)]);
  }
  yield sql("UPDATE recovery_journal SET phase='planned' WHERE restore_id=?", [restoreId]);
}

/** v1 JSON exports do not include this extension. Fail explicitly instead of silently losing recovery evidence. */
export async function assertEpochArchiveExportSupported(db: Pick<LocalSyncDatabase, 'read'>): Promise<void> {
  if ((await db.read("SELECT name FROM sqlite_master WHERE type='table' AND name='recovery_journal'")).length &&
      (await db.read('SELECT restore_id FROM recovery_journal LIMIT 1')).length) throw new Error('epoch_archive_requires_sqlite_backup');
}

export async function plannedAnchorOperations(db: LocalSyncDatabase, restoreId: string) {
  assertUuid(restoreId, '4');
  const [journal] = await db.read('SELECT phase FROM recovery_journal WHERE restore_id=?', [restoreId]);
  if (journal?.phase !== 'planned') throw new Error('epoch_baseline_review_required');
  // A paginated uploader must consume these rows by ordinal; this helper reads a single bounded page.
  return async (afterOrdinal = 0) => {
    if (!Number.isSafeInteger(afterOrdinal) || afterOrdinal < 0) throw new Error('invalid_ordinal');
    const rows = await db.read('SELECT * FROM recovery_revision_mapping WHERE restore_id=? AND ordinal>? ORDER BY ordinal LIMIT 100', [restoreId, afterOrdinal]);
    return rows.map(r => ({ ordinal: Number(r.ordinal), commitId: String(r.commit_b),
      opId: String(r.revision_b), objectId: String(r.object_id), parents: [] as string[], revision: JSON.parse(String(r.revision_b_json)) as RevisionPlaintext }));
  };
}

/** Only the local, unactivated plan exists in this draft. Cancellation preserves backup, archive, mapping and A. */
export function* cancelAnchorPlan(restoreId: string): SqlWorkflow {
  assertUuid(restoreId, '4');
  const [journal] = yield sql('SELECT phase FROM recovery_journal WHERE restore_id=?', [restoreId]);
  if (!journal) throw new Error('recovery_attempt_missing');
  yield sql("UPDATE recovery_journal SET phase='cancelled' WHERE restore_id=?", [restoreId]);
}

/** Public plan commitments, without snapshots. These are not a staged manifest or a proof of activation. */
export async function anchorPlanCommitments(db: LocalSyncDatabase, restoreId: string, hash: (text: string) => string) {
  const [journal] = await db.read('SELECT * FROM recovery_journal WHERE restore_id=?', [restoreId]);
  if (journal?.phase !== 'planned') throw new Error('epoch_baseline_review_required');
  const [generation] = await db.read('SELECT * FROM recovery_generations WHERE vault_id=? AND server_epoch=?',
    [journal.vault_id, journal.from_epoch]);
  if (generation?.sealed !== 1) throw new Error('epoch_archive_unsealed');
  const scope = { restoreId, vaultId: String(journal.vault_id), fromEpoch: String(journal.from_epoch), toEpoch: String(journal.to_epoch) };
  let mappingSha256 = hash(canonicalStringify({ context: 'LionPocket/epoch-baseline-mapping/v1', ...scope }));
  let operationCount = '0', ordinal = 0;
  const page = await plannedAnchorOperations(db, restoreId);
  for (;;) {
    const rows = await page(ordinal);
    if (!rows.length) break;
    for (const row of rows) {
      mappingSha256 = hash(canonicalStringify({ context: 'LionPocket/epoch-baseline-mapping-entry/v1', previousSha256: mappingSha256,
        ordinal: row.ordinal, revisionA: row.revision.restoredFrom, revisionB: row.opId, objectId: row.objectId,
        commitId: row.commitId, revisionSha256: hash(canonicalStringify(row.revision)) }));
      ordinal = row.ordinal; operationCount = incrementDecimal64(operationCount);
    }
  }
  let headsSha256 = hash(canonicalStringify({ context: 'LionPocket/epoch-baseline-heads/v1', ...scope }));
  let object = '', revision = '';
  for (;;) {
    const rows = await db.read(`SELECT object_id,revision_b FROM recovery_revision_mapping
      WHERE restore_id=? AND (object_id>? OR (object_id=? AND revision_b>?)) ORDER BY object_id,revision_b LIMIT 100`,
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
