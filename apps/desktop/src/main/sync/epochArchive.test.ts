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
  anchorPlanCommitments, cancelAnchorPlan,
  applyCommit, projectObject,
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
  it('maps dependency heads topologically and blocks historical dependencies, dirty writes, quarantine and unknown review', async () => {
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
    expect(historical.sqlite.prepare('SELECT reason FROM recovery_plan_reviews').all()).toContainEqual({ reason: 'historical_dependency_requires_graph_rebase' });
    expect(historical.sqlite.prepare('SELECT * FROM recovery_revision_mapping').all()).toEqual([]);
  });
  it('demonstrates why normal projection cannot install a root-only conflict baseline yet', async () => {
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
    expect(branches).toHaveLength(2);
    const destination = new LionPocketDatabase(join(f.directory, 'projection-probe-only.sqlite')); dispose.push(() => destination.db.close());
    destination.db.exec('DELETE FROM categories; DELETE FROM payment_methods; DELETE FROM cards;');
    const pinB = { ...f.client.profile.pin, serverEpoch: f.acceptedAuthorization.toEpoch };
    await destination.syncDatabase().run(startFinancialBaseline({ ...f.client.profile, pin: pinB }, 'https://fixture.invalid', '/fixture/projection-probe.sqlite', randomUUID));
    // Projection-only test: signature/ciphertext validation belongs to ManualSync. No server or activation is used here.
    const envelope: CommitEnvelope = { protocolVersion: 1, serverId: pinB.serverId, serverEpoch: pinB.serverEpoch,
      vaultId: pinB.vaultId, deviceId: f.client.profile.deviceId, deviceSeq: '1', commitId: randomUUID(), keyVersion: 1,
      deviceRegistryVersion: '1', cryptoSuite: 'lp-sodium-v1', signature: 'A'.repeat(86),
      operations: branches.map(op => ({ opId: op.opId, objectId: op.objectId, parents: [], nonce: 'A'.repeat(32), ciphertext: 'A'.repeat(22) })) };
    await destination.syncDatabase().run(applyCommit(envelope, '1', '1', branches, 'desktop', randomUUID));
    expect(destination.db.prepare('SELECT * FROM sync_heads WHERE object_id=?').all(base.object_id)).toHaveLength(2);
    expect(destination.db.prepare('SELECT * FROM sync_conflicts WHERE object_id=?').get(base.object_id)?.base_revision_id).toBe(null);
    // An object visible via the common base in A is hidden in B by projectObject's no-base path.
    // Activating with this installer would violate financial continuity even though both branch snapshots exist.
    expect(destination.db.prepare('SELECT deleted_at FROM transactions').get()).toBeUndefined();
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
});
