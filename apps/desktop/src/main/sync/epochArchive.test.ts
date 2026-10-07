import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import sodium from 'libsodium-wrappers-sumo';
import {
  authorizeEpochRecovery, prepareAnchorArchive, planAnchorBaseline, plannedAnchorOperations,
  epochArchiveColumns, startFinancialBaseline, ManualSync, incrementDecimal64, syncTables,
  ProvisioningCrypto, type LocalSyncDatabase, type SqlWorkflow,
  anchorPlanCommitments, cancelAnchorPlan, discardLegacyAnchorPlan, migrateAnchorPlan,
  applyCommit, projectObject, resolveFinancial, causalCommonBase,
  sql,
} from '@lionpocket/sync-local';
import { canonicalStringify, type CommitEnvelope, type EpochRecoveryChallenge } from '@lionpocket/sync-protocol';
import { founder } from '../../../../sync-server/src/testSupport';
import { LionPocketDatabase } from '../database';
import { createEpochAnchorBackup, inspectEpochAnchorBackup } from './epochBackup';
import { sqliteTestConnection } from '../../../../mobile/src/db/sqliteTestConnection';
import { migrate } from '../../../../mobile/src/db/migrations';
import { mobileSyncDatabase } from '../../../../mobile/src/sync/database';
import { MobileRepository } from '../../../../mobile/src/db/repository';
import { captureBackup } from '../../../../mobile/src/db/backupRepository';

describe('anchor archive and graph planning; activation remains unavailable', () => {
  const dispose: (() => void)[] = [];
  beforeAll(async () => { await sodium.ready; });
  afterEach(() => { for (const close of dispose.splice(0).reverse()) close(); });
  const input = { kind: 'expense' as const, description: 'C1_ARCHIVE_PRIVATE_CANARY', plannedAmount: 12.34,
    dueDate: '2026-10-02', status: 'planned' as const };
  async function fixture(dialect: 'desktop' | 'android' = 'desktop') {
    const directory = mkdtempSync(join(tmpdir(), 'lp-anchor-archive-test-'));
    dispose.push(() => rmSync(directory, { force: true, recursive: true }));
    const crypto = new ProvisioningCrypto(sodium), { client } = await founder(crypto);
    const bank = dialect === 'desktop' ? new LionPocketDatabase(join(directory, 'anchor.sqlite')) : null;
    const mobile = dialect === 'android' ? sqliteTestConnection(join(directory, 'anchor.sqlite')) : null;
    if (mobile) await migrate(mobile.db);
    const sqlite = bank?.db ?? mobile!.sqlite;
    dispose.push(() => sqlite.close());
    sqlite.exec('DELETE FROM categories; DELETE FROM payment_methods; DELETE FROM cards;');
    const db = bank?.syncDatabase() ?? mobileSyncDatabase(mobile!.db);
    const repo = mobile ? new MobileRepository(mobile.db, randomUUID) : null;
    const save = async (description: string) => bank ? bank.saveTransaction({ ...input, description }) : repo!.save({ ...input, description });
    await save(input.description);
    await db.run(startFinancialBaseline(client.profile, 'https://fixture.invalid', '/fixture/before-binding.sqlite', randomUUID));
    await save('C2_AFTER_SERVER_BACKUP');
    const challenge: EpochRecoveryChallenge = { formatVersion: 1, serverId: client.profile.pin.serverId, vaultId: client.profile.pin.vaultId,
      fromEpoch: client.profile.pin.serverEpoch, toEpoch: randomUUID(), authorityPublicKey: client.profile.pin.authorityPublicKey,
      restoreId: randomUUID(), challengeId: randomUUID(), nonce: crypto.nonce(), restoredRegistry: client.profile.checkpoint!,
      restoredStateSha256: crypto.hash('synthetic server snapshot C1'), expiresAt: 1790942400000 };
    const acceptedAuthorization = await authorizeEpochRecovery(client, challenge, true);
    const prepare = (overrides: Partial<Parameters<typeof prepareAnchorArchive>[0]> = {}) => prepareAnchorArchive({
      db, device: client, acceptedAuthorization, confirmed: true,
      backup: () => createEpochAnchorBackup(sqlite, join(directory, randomUUID()+'.sqlite')),
      inspectBackup: inspectEpochAnchorBackup, ...overrides,
    });
    const snapshot = () => Object.fromEntries(syncTables.map(t => [t, sqlite.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all()]));
    return { client, sqlite, db, directory, prepare, snapshot, acceptedAuthorization, save, bank, mobile, crypto };
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>;
  function root(f: Fixture) { return f.sqlite.prepare('SELECT * FROM sync_revisions ORDER BY length(local_seq),local_seq LIMIT 1').get()!; }
  function append(f: Fixture, base: ReturnType<typeof root>, parents: string[], options: { deleted?: boolean; description?: string; dependencies?: { objectId: string; revisionId: string }[] } = {}) {
    const revision = JSON.parse(String(base.payload_json));
    if (options.description && revision.action === 'put') revision.snapshot.description = options.description;
    if (options.dependencies) revision.dependencies = options.dependencies;
    if (options.deleted) Object.assign(revision, { action: 'delete', snapshot: null, reason: 'user', deletedAt: revision.authoredAt, slotKey: null, importKey: null });
    const id = randomUUID(), seq = incrementDecimal64(String(f.sqlite.prepare('SELECT local_seq FROM sync_local_state').get()!.local_seq));
    f.sqlite.prepare('INSERT INTO sync_revisions VALUES(?,?,?,?,?,?,?,?)').run(id, base.object_id, randomUUID(), seq, revision.action, revision.authoredAt, canonicalStringify(parents), canonicalStringify(revision));
    f.sqlite.prepare('UPDATE sync_local_state SET local_seq=?').run(seq);
    for (const parent of parents) f.sqlite.prepare('DELETE FROM sync_heads WHERE revision_id=?').run(parent);
    f.sqlite.prepare('INSERT INTO sync_heads VALUES(?,?)').run(base.object_id, id);
    if (revision.action === 'delete') f.sqlite.prepare('INSERT INTO sync_tombstones VALUES(?,?,?)').run(base.object_id, id, revision.deletedAt);
    f.sqlite.prepare('INSERT INTO sync_revision_origin VALUES(?,?,?,?,NULL)').run(id, randomUUID(), seq, '1');
    return f.sqlite.prepare('SELECT * FROM sync_revisions WHERE revision_id=?').get(id)!;
  }
  async function plan(f: Fixture) {
    await f.prepare(); await f.db.run(planAnchorBaseline(f.acceptedAuthorization.restoreId, randomUUID));
    const journal = f.sqlite.prepare('SELECT * FROM recovery_journal').get()!;
    expect(f.sqlite.prepare('SELECT * FROM recovery_plan_reviews').all()).toEqual([]);
    expect(journal.phase).toBe('planned'); expect(journal.plan_format).toBe(2);
    const page = await plannedAnchorOperations(f.db, f.acceptedAuthorization.restoreId), all = [];
    let ordinal = 0;
    for (;;) { const rows = await page(ordinal); if (!rows.length) break; all.push(...rows); ordinal = rows.at(-1)!.ordinal; }
    return all;
  }
  async function blocked(f: Fixture, reason: string) {
    const before = f.snapshot();
    await f.prepare(); await f.db.run(planAnchorBaseline(f.acceptedAuthorization.restoreId, randomUUID));
    expect(f.sqlite.prepare('SELECT phase FROM recovery_journal').get()!.phase).toBe('review-required');
    expect(f.sqlite.prepare('SELECT reason FROM recovery_plan_reviews').all()).toContainEqual({ reason });
    expect(f.sqlite.prepare('SELECT * FROM recovery_revision_mapping').all()).toEqual([]);
    expect(f.snapshot()).toEqual(before);
    expect(f.sqlite.prepare("SELECT name FROM sqlite_temp_master WHERE type='table'").all()).toEqual([]);
  }
  for (const dialect of ['desktop', 'android'] as const) {
    it(`${dialect}: opened consistent backup, immutable row archives, C1+C2 mapping and exact outbox preservation`, async () => {
      const f = await fixture(dialect);
      const sync = new ManualSync(f.db, f.client, sodium, dialect, 'https://fixture.invalid');
      for (const row of f.sqlite.prepare('SELECT commit_id FROM sync_outbox ORDER BY length(local_seq),local_seq').all())
        await sync.prepare(String(row.commit_id));
      const before = f.snapshot(), profile = canonicalStringify(f.client.profile);
      await f.prepare();
      expect(f.snapshot()).toEqual(before);
      const journal = f.sqlite.prepare('SELECT * FROM recovery_journal').get()!;
      expect((await inspectEpochAnchorBackup(String(journal.backup_path))).sha256).toBe(journal.backup_sha256);
      expect(canonicalStringify(f.client.profile)).toBe(profile);
      for (const [table, columns] of Object.entries(epochArchiveColumns))
        expect(f.sqlite.prepare(`SELECT ${columns.join(',')} FROM recovery_archive_${table} ORDER BY rowid`).all()).toEqual(expect.arrayContaining(before[table]));
      const digest = f.sqlite.prepare('SELECT archive_sha256 FROM recovery_generations').get()!.archive_sha256;
      expect(String(digest)).toHaveLength(43);
      await f.prepare({ backup: async () => { throw new Error('retry must reuse backup'); } });
      await f.db.run(planAnchorBaseline(f.acceptedAuthorization.restoreId, randomUUID));
      const page = await plannedAnchorOperations(f.db, f.acceptedAuthorization.restoreId), operations = await page();
      expect(operations.map(o => o.revision.action === 'put' ? o.revision.snapshot : null)).toEqual(expect.arrayContaining([
        expect.objectContaining({ description: input.description }), expect.objectContaining({ description: 'C2_AFTER_SERVER_BACKUP' }),
      ]));
      expect(operations).toHaveLength(2);
      const oldIds = new Set((before.sync_revisions as { revision_id: string }[]).map(r => r.revision_id));
      for (const op of operations) {
        expect(oldIds.has(op.opId)).toBe(false); expect(oldIds.has(op.revision.restoredFrom!)).toBe(true);
        expect(op.parents).toEqual([]); expect(op.revision.provenance.origin).toBe('restore');
      }
      const firstMapping = f.sqlite.prepare('SELECT * FROM recovery_revision_mapping ORDER BY ordinal').all();
      await f.db.run(planAnchorBaseline(f.acceptedAuthorization.restoreId, () => { throw new Error('retry must reuse mapping'); }));
      expect(f.sqlite.prepare('SELECT * FROM recovery_revision_mapping ORDER BY ordinal').all()).toEqual(firstMapping);
      const commitments = await anchorPlanCommitments(f.db, f.acceptedAuthorization.restoreId, text => f.crypto.hash(text));
      expect(commitments.operationCount).toBe('2');
      expect(commitments.archiveSha256).toBe(digest);
      expect(await anchorPlanCommitments(f.db, f.acceptedAuthorization.restoreId, text => f.crypto.hash(text))).toEqual(commitments);
      expect(f.snapshot()).toEqual(before);
      expect(() => f.sqlite.exec("UPDATE recovery_archive_sync_outbox SET envelope_json='changed'")).toThrow('immutable');
      expect(() => f.sqlite.exec('DELETE FROM recovery_archive_sync_heads')).toThrow('immutable');
      expect(() => f.sqlite.exec('UPDATE recovery_generations SET sealed=0')).toThrow('immutable');
      expect(() => f.sqlite.exec("UPDATE recovery_revision_mapping SET revision_b_json='{}'")).toThrow('immutable');
      expect(f.sqlite.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      if (f.bank) expect(() => f.bank!.exportData(true)).toThrow('epoch_archive_requires_sqlite_backup');
      else await expect(captureBackup(f.mobile!.db)).rejects.toThrow('epoch_archive_requires_sqlite_backup');
    });
  }
  it('requires the explicit owner action and aborts before any SQLite mutation on failed/mismatched backup', async () => {
    const f = await fixture(), before = f.snapshot();
    await expect(f.prepare({ confirmed: false })).rejects.toThrow('epoch_anchor_confirmation_required');
    await expect(f.prepare({ backup: async () => { throw new Error('disk-full'); } })).rejects.toThrow('disk-full');
    await expect(f.prepare({ inspectBackup: async path => ({ ...await inspectEpochAnchorBackup(path), sha256: 'A'.repeat(43) }) })).rejects.toThrow('epoch_backup_invalid');
    expect(f.sqlite.prepare("SELECT name FROM sqlite_master WHERE name='recovery_journal'").all()).toEqual([]);
    expect(f.snapshot()).toEqual(before);
    const authorityScope = f.client.scope('authoritySeed');
    await f.client.secrets.remove(authorityScope);
    await expect(f.prepare({ backup: async () => { throw new Error('must not reach backup'); } })).rejects.toThrow('authority_secret_unavailable');
    expect(f.snapshot()).toEqual(before);
  });
  it('pages large graphs and permits only local cancellation with all A evidence intact', async () => {
    const f = await fixture();
    for (let i = 0; i < 105; i++) await f.save('BATCHED_GRAPH_' + i);
    const before = f.snapshot(); await f.prepare();
    await f.db.run(planAnchorBaseline(f.acceptedAuthorization.restoreId, randomUUID));
    const page = await plannedAnchorOperations(f.db, f.acceptedAuthorization.restoreId);
    const first = await page(), second = await page(first.at(-1)!.ordinal);
    expect(first).toHaveLength(100); expect(second).toHaveLength(7);
    const digest = await anchorPlanCommitments(f.db, f.acceptedAuthorization.restoreId, text => f.crypto.hash(text));
    expect(digest.operationCount).toBe('107');
    await f.db.run(cancelAnchorPlan(f.acceptedAuthorization.restoreId));
    await f.db.run(cancelAnchorPlan(f.acceptedAuthorization.restoreId));
    expect(f.snapshot()).toEqual(before);
    expect(f.sqlite.prepare('SELECT count(*) AS n FROM recovery_revision_mapping').get()!.n).toBe(107);
    await expect(plannedAnchorOperations(f.db, f.acceptedAuthorization.restoreId)).rejects.toThrow('epoch_baseline_review_required');
    await expect(f.db.run(planAnchorBaseline(f.acceptedAuthorization.restoreId, randomUUID))).rejects.toThrow('recovery_attempt_cancelled');
  }, 30000);
  it('retains tombstones and two branches for both edit/edit and delete/edit without choosing a winner', async () => {
    const f = await fixture();
    const [c1, c2] = f.sqlite.prepare('SELECT * FROM sync_revisions ORDER BY length(local_seq),local_seq').all();
    const addBranch = (row: typeof c1, deleted: boolean) => {
      const revision = JSON.parse(String(row.payload_json));
      if (deleted) Object.assign(revision, { action: 'delete', snapshot: null, reason: 'user', deletedAt: revision.authoredAt, slotKey: null, importKey: null });
      else revision.snapshot.description = 'CONFLICTING_BRANCH';
      const id = randomUUID(), commit = randomUUID(), seq = incrementDecimal64(String(f.sqlite.prepare('SELECT local_seq FROM sync_local_state').get()!.local_seq));
      f.sqlite.prepare('INSERT INTO sync_revisions VALUES(?,?,?,?,?,?,?,?)').run(id, row.object_id, commit, seq, revision.action, revision.authoredAt, '[]', canonicalStringify(revision));
      f.sqlite.prepare('UPDATE sync_local_state SET local_seq=?').run(seq);
      f.sqlite.prepare('INSERT INTO sync_heads VALUES(?,?)').run(row.object_id, id);
      if (deleted) f.sqlite.prepare('INSERT INTO sync_tombstones VALUES(?,?,?)').run(row.object_id, id, revision.deletedAt);
    };
    addBranch(c1, false); addBranch(c2, true);
    const before = f.snapshot(); await f.prepare();
    await f.db.run(planAnchorBaseline(f.acceptedAuthorization.restoreId, randomUUID));
    const rows = f.sqlite.prepare('SELECT * FROM recovery_revision_mapping ORDER BY ordinal').all();
    expect(rows).toHaveLength(4);
    expect(rows.filter(r => r.object_id === c1.object_id)).toHaveLength(2);
    expect(rows.filter(r => r.object_id === c2.object_id)).toHaveLength(2);
    expect(rows.map(r => JSON.parse(String(r.revision_b_json)).action).filter(a => a === 'delete')).toHaveLength(1);
    expect(f.snapshot()).toEqual(before);
  });
  it('maps dependency heads topologically and refuses an impossible missing head and unknown review', async () => {
    const f = await fixture();
    const rows = f.sqlite.prepare('SELECT * FROM sync_revisions ORDER BY length(local_seq),local_seq').all();
    const revision = JSON.parse(String(rows[1].payload_json));
    revision.dependencies = [{ objectId: rows[0].object_id, revisionId: rows[0].revision_id }];
    f.sqlite.prepare('UPDATE sync_revisions SET payload_json=? WHERE revision_id=?').run(canonicalStringify(revision), rows[1].revision_id);
    await f.prepare(); await f.db.run(planAnchorBaseline(f.acceptedAuthorization.restoreId, randomUUID));
    const mapping = f.sqlite.prepare('SELECT * FROM recovery_revision_mapping ORDER BY ordinal').all();
    expect(mapping.map(r => r.revision_a)).toEqual(rows.map(r => r.revision_id));
    expect(JSON.parse(String(mapping[1].revision_b_json)).dependencies[0].revisionId).toBe(mapping[0].revision_b);
    const blocked = await fixture();
    blocked.sqlite.prepare('INSERT INTO sync_review VALUES(?,?,?,?)').run(randomUUID(), null, 'unknown_future_blocker', '{}');
    await blocked.prepare(); await blocked.db.run(planAnchorBaseline(blocked.acceptedAuthorization.restoreId, randomUUID));
    expect(blocked.sqlite.prepare('SELECT phase FROM recovery_journal').get()!.phase).toBe('review-required');
    expect(blocked.sqlite.prepare('SELECT * FROM recovery_revision_mapping').all()).toEqual([]);
    await expect(plannedAnchorOperations(blocked.db, blocked.acceptedAuthorization.restoreId)).rejects.toThrow('epoch_baseline_review_required');
    const historical = await fixture();
    const historyRows = historical.sqlite.prepare('SELECT * FROM sync_revisions ORDER BY length(local_seq),local_seq').all();
    await historical.save(input.description); // independent new object; create an actual ancestor on C1 below.
    const ancestor = historyRows[0], payload = JSON.parse(String(historyRows[1].payload_json));
    payload.dependencies = [{ objectId: ancestor.object_id, revisionId: ancestor.revision_id }];
    historical.sqlite.prepare('UPDATE sync_revisions SET payload_json=? WHERE revision_id=?').run(canonicalStringify(payload), historyRows[1].revision_id);
    historical.sqlite.prepare('DELETE FROM sync_heads WHERE object_id=?').run(ancestor.object_id);
    await historical.prepare(); await historical.db.run(planAnchorBaseline(historical.acceptedAuthorization.restoreId, randomUUID));
    expect(historical.sqlite.prepare('SELECT reason FROM recovery_plan_reviews').all()).toContainEqual({ reason: 'baseline_replay:replay_heads_changed' });
    expect(historical.sqlite.prepare('SELECT * FROM recovery_revision_mapping').all()).toEqual([]);
  });
  it('rebases Z→X/Y and keeps its mapped common base, transaction and open conflict', async () => {
    const f = await fixture();
    const base = f.sqlite.prepare('SELECT * FROM sync_revisions ORDER BY length(local_seq),local_seq LIMIT 1').get()!;
    f.sqlite.prepare('DELETE FROM sync_heads WHERE object_id=?').run(base.object_id);
    for (const description of ['BRANCH_X', 'BRANCH_Y']) {
      const revision = JSON.parse(String(base.payload_json)); revision.snapshot.description = description;
      const seq = incrementDecimal64(String(f.sqlite.prepare('SELECT local_seq FROM sync_local_state').get()!.local_seq));
      const id = randomUUID();
      f.sqlite.prepare('INSERT INTO sync_revisions VALUES(?,?,?,?,?,?,?,?)').run(id, base.object_id, randomUUID(), seq,
        'put', revision.authoredAt, canonicalStringify([base.revision_id]), canonicalStringify(revision));
      f.sqlite.prepare('INSERT INTO sync_heads VALUES(?,?)').run(base.object_id, id);
      f.sqlite.prepare('UPDATE sync_local_state SET local_seq=?').run(seq);
    }
    function* projectExisting(): SqlWorkflow {
      yield sql('UPDATE sync_control SET applying=1 WHERE id=1');
      yield* projectObject(String(base.object_id), 'desktop', randomUUID);
      yield sql('UPDATE sync_control SET applying=0 WHERE id=1');
    }
    await f.db.run(projectExisting());
    const localId = f.sqlite.prepare('SELECT local_id FROM sync_identity WHERE object_id=?').get(base.object_id)!.local_id;
    expect(f.sqlite.prepare('SELECT deleted_at FROM transactions WHERE id=?').get(localId)!.deleted_at).toBe(null);
    await f.prepare(); await f.db.run(planAnchorBaseline(f.acceptedAuthorization.restoreId, randomUUID));
    const page = await plannedAnchorOperations(f.db, f.acceptedAuthorization.restoreId);
    const branches = (await page()).filter(op => op.objectId === base.object_id);
    expect(branches).toHaveLength(3);
    const zB = branches.find(op => op.revision.restoredFrom === base.revision_id)!;
    expect(zB.isHead).toBe(false);
    for (const branch of branches.filter(op => op.isHead)) expect(branch.parents).toEqual([zB.opId]);
    const destination = new LionPocketDatabase(join(f.directory, 'projection-probe-only.sqlite')); dispose.push(() => destination.db.close());
    destination.db.exec('DELETE FROM categories; DELETE FROM payment_methods; DELETE FROM cards;');
    const pinB = { ...f.client.profile.pin, serverEpoch: f.acceptedAuthorization.toEpoch };
    await destination.syncDatabase().run(startFinancialBaseline({ ...f.client.profile, pin: pinB }, 'https://fixture.invalid', '/fixture/projection-probe.sqlite', randomUUID));
    // Projection-only test: signature/ciphertext validation belongs to ManualSync. No server or activation is used here.
    const envelope: CommitEnvelope = { protocolVersion: 1, serverId: pinB.serverId, serverEpoch: pinB.serverEpoch,
      vaultId: pinB.vaultId, deviceId: f.client.profile.deviceId, deviceSeq: '1', commitId: randomUUID(), keyVersion: 1,
      deviceRegistryVersion: '1', cryptoSuite: 'lp-sodium-v1', signature: 'A'.repeat(86),
      operations: branches.map(op => ({ opId: op.opId, objectId: op.objectId, parents: op.parents, nonce: 'A'.repeat(32), ciphertext: 'A'.repeat(22) })) };
    await destination.syncDatabase().run(applyCommit(envelope, '1', '1', branches, 'desktop', randomUUID));
    expect(destination.db.prepare('SELECT * FROM sync_heads WHERE object_id=?').all(base.object_id)).toHaveLength(2);
    expect(destination.db.prepare('SELECT * FROM sync_conflicts WHERE object_id=?').get(base.object_id)?.base_revision_id).toBe(zB.opId);
    expect(destination.db.prepare('SELECT deleted_at,description FROM transactions').get()).toEqual({ deleted_at: null, description: input.description });
    expect(destination.db.prepare('SELECT resolution_id FROM sync_conflicts WHERE object_id=?').get(base.object_id)!.resolution_id).toBe(null);
  });
  it('rolls back interrupted archiving/planning and converges on retry, with backup and A intact', async () => {
    const f = await fixture(), before = f.snapshot();
    const faulty: LocalSyncDatabase = { read: f.db.read, run: async workflow => {
      function* interrupt(): SqlWorkflow {
        let step = workflow.next();
        while (!step.done) {
          if (step.value.sql.startsWith('UPDATE recovery_generations SET sealed')) throw new Error('injected-before-seal');
          const rows = yield step.value; step = workflow.next(rows);
        }
      }
      await f.db.run(interrupt());
    } };
    await expect(f.prepare({ db: faulty })).rejects.toThrow('injected-before-seal');
    expect(f.sqlite.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'recovery_%'").all()).toEqual([]);
    expect(f.snapshot()).toEqual(before);
    await f.prepare();
    let generated = 0;
    await expect(f.db.run(planAnchorBaseline(f.acceptedAuthorization.restoreId, () => {
      if (++generated === 4) throw new Error('injected-mid-mapping'); return randomUUID();
    }))).rejects.toThrow('injected-mid-mapping');
    expect(f.sqlite.prepare('SELECT * FROM recovery_revision_mapping').all()).toEqual([]);
    expect(f.sqlite.prepare('SELECT phase FROM recovery_journal').get()!.phase).toBe('archived');
    await f.db.run(planAnchorBaseline(f.acceptedAuthorization.restoreId, randomUUID));
    expect(f.sqlite.prepare('SELECT phase FROM recovery_journal').get()!.phase).toBe('planned');
    expect(f.snapshot()).toEqual(before);
    expect(f.sqlite.prepare('PRAGMA integrity_check').get()!.integrity_check).toBe('ok');
    const path = String(f.sqlite.prepare('SELECT backup_path FROM recovery_journal').get()!.backup_path);
    expect(readFileSync(path).subarray(0, 16).toString()).toBe('SQLite format 3\u0000');
  });
  for (const scenario of ['linear', 'deep-branches', 'three-heads', 'delete-edit', 'tombstone-ancestor'] as const) {
    it(`complete causal replay: ${scenario}`, async () => {
      const f = await fixture(), a0 = root(f);
      const a1 = append(f, a0, [String(a0.revision_id)], { description: 'A1_COMMON_BASE' });
      if (scenario === 'linear') append(f, a1, [String(a1.revision_id)]);
      if (scenario === 'deep-branches') {
        const a2 = append(f, a1, [String(a1.revision_id)], { description: 'A2' });
        const b2 = append(f, a1, [String(a1.revision_id)], { description: 'B2' });
        append(f, a2, [String(a2.revision_id)]); append(f, b2, [String(b2.revision_id)]);
      }
      if (scenario === 'three-heads') for (const description of ['X', 'Y', 'W']) append(f, a1, [String(a1.revision_id)], { description });
      if (scenario === 'delete-edit') {
        append(f, a1, [String(a1.revision_id)], { deleted: true });
        append(f, a1, [String(a1.revision_id)], { description: 'EDIT' });
      }
      if (scenario === 'tombstone-ancestor') {
        const del = append(f, a1, [String(a1.revision_id)], { deleted: true });
        append(f, del, [String(del.revision_id)]);
      }
      const headsA = f.sqlite.prepare('SELECT * FROM sync_heads ORDER BY object_id,revision_id').all(), before = f.snapshot();
      const operations = await plan(f), mapping = new Map(operations.map(o => [o.revision.restoredFrom, o.opId]));
      if (['deep-branches', 'three-heads', 'delete-edit'].includes(scenario)) {
        const graph = new Map(f.sqlite.prepare('SELECT revision_id,parents_json FROM sync_revisions').all().map(r => [String(r.revision_id), { parents: JSON.parse(String(r.parents_json)) as string[] }]));
        const heads = headsA.filter(h => h.object_id === a0.object_id).map(h => String(h.revision_id));
        expect(causalCommonBase(graph, heads)).toBe(a1.revision_id);
      }
      const operationsForObject = operations.filter(o => o.objectId === a0.object_id);
      expect(operationsForObject.some(o => o.revision.restoredFrom === a0.revision_id)).toBe(true);
      expect(operations.filter(o => o.isHead).map(o => ({ objectId: o.objectId, id: o.revision.restoredFrom })).sort((a,b) => a.id!.localeCompare(b.id!)))
        .toEqual(headsA.map(h => ({ objectId: h.object_id, id: h.revision_id })).sort((a,b) => String(a.id).localeCompare(String(b.id))));
      for (const op of operations) {
        const original = f.sqlite.prepare('SELECT * FROM sync_revisions WHERE revision_id=?').get(op.revision.restoredFrom!)!;
        expect(op.parents).toEqual((JSON.parse(String(original.parents_json)) as string[]).map(p => mapping.get(p)).sort());
        for (const p of op.parents) expect(operations.find(o => o.opId === p)!.ordinal).toBeLessThan(op.ordinal);
      }
      expect(f.snapshot()).toEqual(before);
      expect(f.sqlite.prepare("SELECT name FROM sqlite_temp_master WHERE type='table'").all()).toEqual([]);
    });
  }
  it('historical C1 dependency and dependency-of-dependency are preserved, never substituted with C2', async () => {
    const f = await fixture(), tx = root(f);
    const categoryId = randomUUID(), methodId = randomUUID();
    const catalog = (objectId: string, type: string, snapshot: unknown) => {
      const payload = JSON.parse(String(tx.payload_json)); payload.entityType = type; payload.snapshot = snapshot;
      const base = { ...tx, object_id: objectId, payload_json: canonicalStringify(payload) };
      f.sqlite.prepare('INSERT INTO sync_identity VALUES(?,?,?)').run(type, randomUUID(), objectId);
      return append(f, base, []);
    };
    const d1 = catalog(methodId, 'paymentMethod', { name: 'D1' });
    const c1 = catalog(categoryId, 'category', { name: 'C1', kind: 'expense', color: '#123456' });
    const payload = JSON.parse(String(c1.payload_json)); payload.dependencies = [{ objectId: methodId, revisionId: d1.revision_id }];
    f.sqlite.prepare('UPDATE sync_revisions SET payload_json=? WHERE revision_id=?').run(canonicalStringify(payload), c1.revision_id);
    const c2 = append(f, c1, [String(c1.revision_id)]);
    const tp = JSON.parse(String(tx.payload_json)); tp.dependencies = [{ objectId: categoryId, revisionId: c1.revision_id }];
    f.sqlite.prepare('UPDATE sync_revisions SET payload_json=? WHERE revision_id=?').run(canonicalStringify(tp), tx.revision_id);
    const ops = await plan(f), mapped = (id: string) => ops.find(o => o.revision.restoredFrom === id)!;
    expect(mapped(String(c1.revision_id)).isHead).toBe(false);
    expect(mapped(String(c2.revision_id)).parents).toEqual([mapped(String(c1.revision_id)).opId]);
    expect(mapped(String(tx.revision_id)).revision.dependencies).toEqual([{ objectId: categoryId, revisionId: mapped(String(c1.revision_id)).opId }]);
    expect(mapped(String(c1.revision_id)).revision.dependencies).toEqual([{ objectId: methodId, revisionId: mapped(String(d1.revision_id)).opId }]);
  });
  for (const kind of ['head', 'parent', 'dependency'] as const) it(`blocks rejected required ${kind}`, async () => {
    const f = await fixture(), base = root(f);
    if (kind === 'parent') append(f, base, [String(base.revision_id)]);
    if (kind === 'dependency') {
      const other = f.sqlite.prepare('SELECT * FROM sync_revisions WHERE revision_id!=?').get(base.revision_id)!;
      const revision = JSON.parse(String(other.payload_json)); revision.dependencies = [{ objectId: base.object_id, revisionId: base.revision_id }];
      f.sqlite.prepare('UPDATE sync_revisions SET payload_json=? WHERE revision_id=?').run(canonicalStringify(revision), other.revision_id);
    }
    f.sqlite.prepare('INSERT INTO sync_rejected VALUES(?,?)').run(base.revision_id, 'rejected');
    await blocked(f, 'rejected_required_revision');
  });
  for (const kind of ['parents', 'dependencies', 'combined'] as const) it(`blocks ${kind} cycle`, async () => {
    const f = await fixture(), base = root(f), child = append(f, base, [String(base.revision_id)]);
    const revision = JSON.parse(String(base.payload_json));
    if (kind === 'parents') f.sqlite.prepare('UPDATE sync_revisions SET parents_json=? WHERE revision_id=?').run(canonicalStringify([child.revision_id]), base.revision_id);
    else {
      revision.dependencies = [{ objectId: child.object_id, revisionId: child.revision_id }];
      f.sqlite.prepare('UPDATE sync_revisions SET payload_json=? WHERE revision_id=?').run(canonicalStringify(revision), base.revision_id);
      if (kind === 'dependencies') {
        const cr = JSON.parse(String(child.payload_json)); cr.dependencies = [{ objectId: base.object_id, revisionId: base.revision_id }];
        f.sqlite.prepare('UPDATE sync_revisions SET parents_json=?,payload_json=? WHERE revision_id=?').run('[]', canonicalStringify(cr), child.revision_id);
      }
    }
    await blocked(f, `causal_${kind}_cycle`);
  });
  it('blocks disconnected historical tombstones and forbidden resurrection', async () => {
    const f = await fixture(), base = root(f);
    const del = append(f, base, [], { deleted: true });
    f.sqlite.prepare('DELETE FROM sync_heads WHERE revision_id=?').run(del.revision_id);
    await blocked(f, 'disconnected_historical_tombstone');
    const g = await fixture(), b = root(g), d = append(g, b, [String(b.revision_id)], { deleted: true });
    append(g, b, [String(d.revision_id)]);
    await blocked(g, 'tombstone_resurrection');
  });
  for (const field of ['revision_id', 'commit_id', 'duplicate-new'] as const) it(`refuses transport ID collision: ${field}`, async () => {
    const f = await fixture(), base = root(f); await f.prepare();
    const id = field === 'duplicate-new' ? randomUUID() : String(base[field]);
    await expect(f.db.run(planAnchorBaseline(f.acceptedAuthorization.restoreId, () => id))).rejects.toThrow('reused_transport_id');
    expect(f.sqlite.prepare('SELECT * FROM recovery_revision_mapping').all()).toEqual([]);
    expect(f.sqlite.prepare('SELECT phase FROM recovery_journal').get()!.phase).toBe('archived');
  });
  it('refuses a real seven-column PR #10 plan, idempotently migrates and replans without changing archive A', async () => {
    const f = await fixture(); await f.prepare();
    f.sqlite.exec('ALTER TABLE recovery_journal DROP COLUMN plan_format; ALTER TABLE recovery_revision_mapping DROP COLUMN parents_b_json; ALTER TABLE recovery_revision_mapping DROP COLUMN is_head;');
    const base = root(f);
    f.sqlite.prepare('INSERT INTO recovery_revision_mapping VALUES(?,?,?,?,?,?,?)').run(f.acceptedAuthorization.restoreId, base.revision_id, randomUUID(), base.object_id, randomUUID(), 1, base.payload_json);
    f.sqlite.exec("UPDATE recovery_journal SET phase='planned'");
    const archive = f.sqlite.prepare('SELECT * FROM recovery_generations').all();
    await expect(plannedAnchorOperations(f.db, f.acceptedAuthorization.restoreId)).rejects.toThrow('incompatible_recovery_plan_format');
    await f.db.run(migrateAnchorPlan()); await f.db.run(migrateAnchorPlan());
    await expect(f.db.run(planAnchorBaseline(f.acceptedAuthorization.restoreId, randomUUID))).rejects.toThrow('incompatible_recovery_plan_format');
    await f.db.run(discardLegacyAnchorPlan(f.acceptedAuthorization.restoreId));
    expect(await plan(f)).toHaveLength(2);
    expect(f.sqlite.prepare('SELECT * FROM recovery_generations').all()).toEqual(archive);
    expect(() => f.sqlite.exec('DELETE FROM recovery_revision_mapping')).toThrow('immutable');
  });
  it('same archived bytes and deterministic UUID source produce identical plans and commitments', async () => {
    const f = await fixture(); append(f, root(f), [String(root(f).revision_id)]); await f.prepare();
    const copyPath = join(f.directory, 'deterministic-copy.sqlite'); f.sqlite.prepare('VACUUM INTO ?').run(copyPath);
    const copy = new LionPocketDatabase(copyPath); dispose.push(() => copy.db.close());
    const source = () => { let n = 0; return () => `aaaaaaaa-aaaa-4aaa-aaaa-${(++n).toString(16).padStart(12, '0')}`; };
    await f.db.run(planAnchorBaseline(f.acceptedAuthorization.restoreId, source()));
    await copy.syncDatabase().run(planAnchorBaseline(f.acceptedAuthorization.restoreId, source()));
    expect(copy.db.prepare('SELECT * FROM recovery_revision_mapping ORDER BY ordinal').all()).toEqual(f.sqlite.prepare('SELECT * FROM recovery_revision_mapping ORDER BY ordinal').all());
    expect(await anchorPlanCommitments(copy.syncDatabase(), f.acceptedAuthorization.restoreId, t => f.crypto.hash(t))).toEqual(await anchorPlanCommitments(f.db, f.acceptedAuthorization.restoreId, t => f.crypto.hash(t)));
  });
  it('restored heads suppress otherwise mergeable field groups on the same anchor device, explicit resolution remains available', async () => {
    const f = await fixture(), base = root(f);
    const a = append(f, base, [String(base.revision_id)], { description: 'NEW_DESCRIPTION' });
    const b = append(f, base, [String(base.revision_id)]);
    const payload = JSON.parse(String(b.payload_json)); payload.snapshot.notes = 'NEW_NOTES';
    f.sqlite.prepare('UPDATE sync_revisions SET payload_json=? WHERE revision_id=?').run(canonicalStringify(payload), b.revision_id);
    const ops = await plan(f);
    const dst = new LionPocketDatabase(join(f.directory, 'automerge-probe.sqlite')); dispose.push(() => dst.db.close());
    dst.db.exec('DELETE FROM categories; DELETE FROM payment_methods; DELETE FROM cards;');
    await dst.syncDatabase().run(startFinancialBaseline(f.client.profile, 'https://fixture.invalid', '/fixture/probe.sqlite', randomUUID));
    for (const op of ops) {
      const envelope = { commitId: op.commitId, deviceId: f.client.profile.deviceId, deviceSeq: String(op.ordinal) } as CommitEnvelope;
      await dst.syncDatabase().run(applyCommit(envelope, String(op.ordinal), '1', [op], 'desktop', randomUUID));
    }
    expect(dst.db.prepare('SELECT revision_id FROM sync_heads WHERE object_id=?').all(base.object_id)).toHaveLength(2);
    expect(dst.db.prepare('SELECT base_revision_id,resolution_id FROM sync_conflicts WHERE object_id=?').get(base.object_id)).toEqual({ base_revision_id: ops.find(o => o.revision.restoredFrom === base.revision_id)!.opId, resolution_id: null });
    expect(dst.db.prepare('SELECT * FROM sync_outbox').all()).toEqual([]);
    expect(ops.find(o => o.revision.restoredFrom === a.revision_id)!.isHead).toBe(true);
    const heads = dst.db.prepare('SELECT revision_id FROM sync_heads WHERE object_id=? ORDER BY revision_id').all(base.object_id).map(r => String(r.revision_id));
    const choice = ops.find(o => o.revision.restoredFrom === a.revision_id)!.revision;
    await dst.syncDatabase().run(resolveFinancial(String(base.object_id), heads, { ...choice, provenance: { ...choice.provenance, origin: 'local' } }, 'desktop', randomUUID));
    expect(dst.db.prepare('SELECT * FROM sync_heads WHERE object_id=?').all(base.object_id)).toHaveLength(1);
    const resolved = dst.db.prepare('SELECT * FROM sync_revisions WHERE revision_id=(SELECT revision_id FROM sync_heads WHERE object_id=?)').get(base.object_id)!;
    const g = { ...f, sqlite: dst.db };
    const x = append(g, resolved, [String(resolved.revision_id)], { description: 'AFTER_RESTORE_LOCAL' });
    const y = append(g, resolved, [String(resolved.revision_id)]);
    const yp = JSON.parse(String(y.payload_json)); yp.snapshot.notes = 'AFTER_RESTORE_NOTES';
    dst.db.prepare('UPDATE sync_revisions SET payload_json=? WHERE revision_id=?').run(canonicalStringify(yp), y.revision_id);
    dst.db.prepare('UPDATE sync_revision_origin SET device_id=? WHERE revision_id IN (?,?)').run(f.client.profile.deviceId, x.revision_id, y.revision_id);
    await dst.syncDatabase().run(projectObject(String(base.object_id), 'desktop', randomUUID));
    expect(dst.db.prepare('SELECT * FROM sync_heads WHERE object_id=?').all(base.object_id)).toHaveLength(1);
    expect(dst.db.prepare('SELECT description,notes FROM transactions WHERE id=(SELECT local_id FROM sync_identity WHERE object_id=?)').get(base.object_id)).toEqual({ description: 'AFTER_RESTORE_LOCAL', notes: 'AFTER_RESTORE_NOTES' });
  });
  it('plans and replays 4000 causally ordered revisions without recursion or quadratic ancestry scans', async () => {
    const f = await fixture(), base = root(f); let previous = base;
    f.sqlite.exec('BEGIN');
    for (let i = 0; i < 3998; i++) previous = append(f, base, [String(previous.revision_id)]);
    f.sqlite.exec('COMMIT');
    const before = f.snapshot(); const ops = await plan(f);
    expect(ops).toHaveLength(4000);
    expect(ops.filter(o => o.isHead)).toHaveLength(2);
    const emitted = new Set<string>();
    for (const op of ops) { expect(op.parents.every(p => emitted.has(p))).toBe(true); emitted.add(op.opId); }
    expect(f.snapshot()).toEqual(before);
  }, 30000);

  for (const reason of ['dirty', 'inbox', 'quarantine', 'identity', 'missing-parent', 'foreign-parent', 'foreign-dependency', 'invalid-revision', 'replay-failure'] as const) {
    it(`review remains blocking: ${reason}`, async () => {
      const f = await fixture(), base = root(f), other = f.sqlite.prepare('SELECT * FROM sync_revisions WHERE revision_id!=?').get(base.revision_id)!;
      const payload = JSON.parse(String(base.payload_json)); let expected: string = reason;
      if (reason === 'dirty') { f.sqlite.prepare('INSERT INTO sync_dirty VALUES(?,?,?,?)').all('transactions', randomUUID(), 'update', '{}'); expected = 'uncaptured_local_writes'; }
      if (reason === 'inbox' || reason === 'quarantine') { f.sqlite.prepare('INSERT INTO sync_inbox VALUES(?,?,?,?,?,?)').run(randomUUID(), '100', reason === 'inbox' ? 'received' : 'quarantined', '{}', null, '1'); expected = 'unapplied_inbox'; }
      if (reason === 'identity') { f.sqlite.prepare('INSERT INTO sync_series VALUES(?,?,?,?,?)').run('recurring', randomUUID(), randomUUID(), '{}', 'identity_unresolved'); expected = 'identity_unresolved'; }
      if (reason === 'missing-parent' || reason === 'foreign-parent') { f.sqlite.prepare('UPDATE sync_revisions SET parents_json=? WHERE revision_id=?').run(canonicalStringify([reason === 'missing-parent' ? randomUUID() : other.revision_id]), base.revision_id); expected = reason === 'missing-parent' ? 'missing_causal_revision' : 'invalid_parent_object'; }
      if (reason === 'foreign-dependency') { payload.dependencies = [{ objectId: base.object_id, revisionId: other.revision_id }]; expected = 'invalid_dependency_object'; }
      if (reason === 'invalid-revision') { payload.domainSchema = 99; expected = 'Unsupported domain schema.'; }
      if (reason === 'replay-failure') { payload.snapshot.categoryId = randomUUID(); expected = 'baseline_replay:missing_dependencies'; }
      if (['foreign-dependency', 'invalid-revision', 'replay-failure'].includes(reason)) f.sqlite.prepare('UPDATE sync_revisions SET payload_json=? WHERE revision_id=?').run(canonicalStringify(payload), base.revision_id);
      if (reason === 'invalid-revision') {
        await f.prepare(); await f.db.run(planAnchorBaseline(f.acceptedAuthorization.restoreId, randomUUID));
        expect(f.sqlite.prepare('SELECT phase FROM recovery_journal').get()!.phase).toBe('review-required');
        expect(f.sqlite.prepare('SELECT * FROM recovery_revision_mapping').all()).toEqual([]);
      } else await blocked(f, expected);
    });
  }
  it('excludes unrelated history, commits parents/head classification, and verifies a SQLite backup containing the plan', async () => {
    const f = await fixture(), base = root(f);
    const unrelated = append(f, base, []); f.sqlite.prepare('DELETE FROM sync_heads WHERE revision_id=?').run(unrelated.revision_id);
    append(f, base, [String(base.revision_id)]);
    const ops = await plan(f);
    expect(ops.some(o => o.revision.restoredFrom === unrelated.revision_id)).toBe(false);
    const original = await anchorPlanCommitments(f.db, f.acceptedAuthorization.restoreId, t => f.crypto.hash(t));
    const changed: LocalSyncDatabase = { run: f.db.run, read: async (query, args) => {
      const rows = await f.db.read(query, args);
      return query.startsWith('SELECT * FROM recovery_revision_mapping') ? rows.map(r => r.parents_b_json !== '[]' ? { ...r, parents_b_json: canonicalStringify([randomUUID()]) } : r) : rows;
    } };
    const mutated = await anchorPlanCommitments(changed, f.acceptedAuthorization.restoreId, t => f.crypto.hash(t));
    expect(mutated.mappingSha256).not.toBe(original.mappingSha256); expect(mutated.headsSha256).toBe(original.headsSha256);
    const backup = await createEpochAnchorBackup(f.sqlite, join(f.directory, 'with-plan.sqlite'));
    expect((await inspectEpochAnchorBackup(backup.path)).sha256).toBe(backup.sha256);
    expect(() => f.sqlite.exec('UPDATE recovery_journal SET plan_format=1')).toThrow('immutable');
  });

  it('crash after all mapping inserts but before planned rolls everything back', async () => {
    const f = await fixture(); await f.prepare(); const before = f.snapshot();
    const workflow = planAnchorBaseline(f.acceptedAuthorization.restoreId, randomUUID);
    function* crash(): SqlWorkflow {
      let step = workflow.next();
      while (!step.done) {
        if (step.value.sql.startsWith("UPDATE recovery_journal SET phase='planned'")) throw new Error('crash-before-plan-commit');
        const rows = yield step.value; step = workflow.next(rows);
      }
    }
    await expect(f.db.run(crash())).rejects.toThrow('crash-before-plan-commit');
    expect(f.sqlite.prepare('SELECT * FROM recovery_revision_mapping').all()).toEqual([]);
    expect(f.sqlite.prepare('SELECT phase FROM recovery_journal').get()!.phase).toBe('archived');
    expect(f.snapshot()).toEqual(before); expect(await plan(f)).toHaveLength(2);
  });
  it('replays priorities, goals, series, installment slots and aliases with logical IDs intact', async () => {
    const f = await fixture(), bank = f.bank!;
    bank.saveMonthlyPlanning({ month: '2026-10', safetyMarginCents: 50001 });
    bank.saveMonthlyPlanning({ month: '2026-11', safetyMarginCents: 0 });
    bank.createCatalogItem({ type: 'card', name: 'CARD', dueDay: 10, closingDay: 3 });
    const card = bank.getCatalogs().cards[0];
    bank.saveRecurringExpense({ kind: 'expense', active: true, description: 'SERIES', plannedAmount: 10, startMonth: '2026-10', dueDay: 10, chargeDay: 5, cardId: card.id });
    bank.saveInstallmentPurchase({ description: 'INSTALLMENTS', installmentAmount: 10, totalInstallments: 3, currentInstallment: 1, currentDueDate: '2026-10-10' });
    bank.saveGoal({ name: 'GOAL', itemModel: '', link: '', targetAmount: 10, savedAmount: 2, priority: 'high', status: 'planned' });
    const tx = bank.listTransactions({ month: '2026-11' }).find(t => t.sourceType === 'recurring')!;
    bank.setTransactionPriority({ month: '2026-11', transactionId: tx.id, pinned: true });
    const identity = f.sqlite.prepare('SELECT * FROM sync_identity LIMIT 1').get()!;
    f.sqlite.prepare('INSERT INTO sync_aliases VALUES(?,?)').run(randomUUID(), identity.object_id);
    const before = f.snapshot(); const ops = await plan(f);
    expect(ops.map(o => o.revision.entityType)).toEqual(expect.arrayContaining(['recurring', 'installmentPurchase', 'monthlyPriorityList', 'recurringPriorityList', 'goal', 'monthlyPlanning']));
    expect(f.snapshot()).toEqual(before);
    for (const op of ops) {
      const original = JSON.parse(String(f.sqlite.prepare('SELECT payload_json FROM sync_revisions WHERE revision_id=?').get(op.revision.restoredFrom!)!.payload_json));
      expect(op.revision.snapshot).toEqual(original.snapshot);
    }
  });

  it('does not invent a unique common base for unrelated roots or two maximal common ancestors', () => {
    const graph = new Map([
      ['P', { parents: [] }], ['Q', { parents: [] }],
      ['X', { parents: ['P', 'Q'] }], ['Y', { parents: ['P', 'Q'] }],
    ]);
    expect(causalCommonBase(graph, ['P', 'Q'])).toBe(null);
    expect(causalCommonBase(graph, ['X', 'Y'])).toBe(null);
  });
  it('keeps ambiguous historical delete audit in review rather than choosing a timestamp', async () => {
    const f = await fixture(), base = root(f), d1 = append(f, base, [String(base.revision_id)], { deleted: true });
    const d2 = append(f, d1, [String(d1.revision_id)]);
    const payload = JSON.parse(String(d2.payload_json)); payload.authoredAt = '2026-10-02T15:00:00.000Z'; payload.deletedAt = payload.authoredAt;
    f.sqlite.prepare('UPDATE sync_revisions SET authored_at=?,payload_json=? WHERE revision_id=?').run(payload.authoredAt, canonicalStringify(payload), d2.revision_id);
    f.sqlite.prepare('UPDATE sync_tombstones SET deleted_at=? WHERE revision_id=?').run(payload.deletedAt, d2.revision_id);
    await blocked(f, 'ambiguous_tombstone_projection');
  });

  it('replays equivalent legacy deletion timestamps despite different migration authorship', async () => {
    const f = await fixture(), base = root(f);
    const d1 = append(f, base, [String(base.revision_id)], { deleted: true });
    const d2 = append(f, d1, [String(d1.revision_id)]);
    for (const [index, row] of [d1, d2].entries()) {
      const payload = JSON.parse(String(row.payload_json));
      payload.reason = 'legacy_unknown';
      payload.provenance.legacyDeletedAt = '2020-12-01 11:12:13';
      payload.provenance.legacyUpdatedAt = '2020-12-01 11:12:13';
      payload.authoredAt = `2026-10-0${index + 1}T15:00:00.000Z`;
      payload.deletedAt = payload.authoredAt;
      f.sqlite.prepare('UPDATE sync_revisions SET authored_at=?,payload_json=? WHERE revision_id=?').run(payload.authoredAt, canonicalStringify(payload), row.revision_id);
      f.sqlite.prepare('UPDATE sync_tombstones SET deleted_at=? WHERE revision_id=?').run(payload.deletedAt, row.revision_id);
    }
    await f.db.run((function* () {
      yield sql('UPDATE sync_control SET applying=1');
      yield* projectObject(String(base.object_id), 'desktop', randomUUID);
      yield sql('UPDATE sync_control SET applying=0');
    })());
    const operations = await plan(f);
    expect(operations.filter(o => o.revision.action === 'delete')).toHaveLength(2);
    expect(f.sqlite.prepare('SELECT deleted_at FROM transactions WHERE id=(SELECT local_id FROM sync_identity WHERE object_id=?)').get(base.object_id)!.deleted_at).toBe('2020-12-01 11:12:13');
  });

  it('does not plan a stale archive when the anchor captures another local operation after preparation', async () => {
    const f = await fixture(); await f.prepare(); const digest = f.sqlite.prepare('SELECT archive_sha256 FROM recovery_generations').get()!.archive_sha256;
    await f.save('NEW_LOCAL_AFTER_ARCHIVE');
    await blocked(f, 'anchor_graph_changed_since_archive');
    expect(f.sqlite.prepare('SELECT archive_sha256 FROM recovery_generations').get()!.archive_sha256).toBe(digest);
  });

});
