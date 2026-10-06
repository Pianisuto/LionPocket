import { afterEach, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { SQLInputValue } from 'node:sqlite';
import {
  applyCommit, reissueForKeyVersion, startFinancialBaseline,
  type DecodedOperation, type ProvisionedProfile,
} from '@lionpocket/sync-local';
import type { CommitEnvelope } from '@lionpocket/sync-protocol';
import { migrate } from './migrations';
import { MobileRepository } from './repository';
import { sqliteTestConnection } from './sqliteTestConnection';
import { mobileSyncDatabase } from '../sync/database';

const cleanup: (() => void)[] = [];
afterEach(() => cleanup.splice(0).forEach(fn => fn()));
async function bank() {
  const native = sqliteTestConnection();
  cleanup.push(() => native.sqlite.close());
  await migrate(native.db);
  return { ...native, repo: new MobileRepository(native.db, randomUUID), sync: mobileSyncDatabase(native.db) };
}
function profile(): ProvisionedProfile {
  return {
    formatVersion: 1, installationId: randomUUID(), deviceId: randomUUID(),
    signingPublicKey: '', boxPublicKey: '', grants: [],
    checkpoint: { version: '1', sha256: 'A'.repeat(43) },
    pin: { serverId: randomUUID(), serverEpoch: randomUUID(), vaultId: randomUUID(),
      founderDeviceId: randomUUID(), authorityPublicKey: 'A'.repeat(43), keyVersion: 1 },
  };
}
function ids(prefix: string) {
  let seq = 0;
  return () => `${prefix}0000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`;
}
const input = { kind: 'expense' as const, description: 'Synthetic adoption',
  plannedAmount: 12.34, dueDate: '2026-10-02', status: 'planned' as const };

it('pairing rotation preserves an unciphered baseline and its equivalent-root resolution', async () => {
  const source = await bank(), target = await bank(), owner = profile();
  const receiver = { ...owner, deviceId: randomUUID(), installationId: randomUUID() };
  await source.repo.save(input);
  const row = source.sqlite.prepare('SELECT * FROM transactions').get()!;
  target.sqlite.prepare(`INSERT INTO transactions(${Object.keys(row).join(',')}) VALUES(${Object.keys(row).map(() => '?').join(',')})`)
    .run(...Object.values(row) as SQLInputValue[]);
  await source.sync.run(startFinancialBaseline(owner, 'https://fixture.invalid', '/fixture/source.sqlite', ids('f')));
  await target.sync.run(startFinancialBaseline(receiver, 'https://fixture.invalid', '/fixture/target.sqlite', ids('1')));
  const incoming = source.sqlite.prepare('SELECT * FROM sync_outbox ORDER BY rowid').all();
  for (const [index, commit] of incoming.entries()) {
    await target.sync.run(applyCommit({ commitId: commit.commit_id, deviceId: owner.deviceId, deviceSeq: commit.local_seq } as CommitEnvelope,
      String(index + 1), '1', JSON.parse(String(commit.payload_json)).operations as DecodedOperation[], 'android', ids('2')));
  }
  const before = target.sqlite.prepare('SELECT * FROM sync_outbox ORDER BY rowid').all();
  expect(before.some(r => JSON.parse(String(r.payload_json)).operations.some((o: { expectedHeads?: string[] }) => o.expectedHeads))).toBe(true);
  const heads = target.sqlite.prepare('SELECT * FROM sync_heads').all();
  await target.sync.run(reissueForKeyVersion(2, randomUUID));
  expect(target.sqlite.prepare('SELECT * FROM sync_outbox ORDER BY rowid').all()).toEqual(before);
  expect(target.sqlite.prepare('SELECT * FROM sync_heads').all()).toEqual(heads);
  expect(target.sqlite.prepare("SELECT * FROM sync_review WHERE reason='rotation_resolution_review' OR reason='reemission_provenance'").all()).toEqual([]);
  expect(target.sqlite.prepare('SELECT count(*) AS n FROM sync_conflicts WHERE resolution_id IS NULL').get()!.n).toBe(0);
  expect(target.sqlite.prepare('SELECT count(*) AS n FROM transactions').get()!.n).toBe(1);
  for (const [index, commit] of before.entries()) {
    await source.sync.run(applyCommit({ commitId: commit.commit_id, deviceId: receiver.deviceId, deviceSeq: commit.local_seq } as CommitEnvelope,
      String(index + 1), '2', JSON.parse(String(commit.payload_json)).operations as DecodedOperation[], 'android', ids('3')));
  }
  await source.sync.run(reissueForKeyVersion(2, randomUUID));
  expect(source.sqlite.prepare('SELECT count(*) AS n FROM sync_conflicts WHERE resolution_id IS NULL').get()!.n).toBe(0);
  expect(source.sqlite.prepare("SELECT * FROM sync_review WHERE reason='rotation_resolution_review'").all()).toEqual([]);
  expect(source.sqlite.prepare('SELECT count(*) AS n FROM transactions').get()!.n).toBe(1);
});

it('rotation archives an old encrypted revision and remaps its unciphered descendant', async () => {
  const local = await bank();
  await local.sync.run(startFinancialBaseline(profile(), 'https://fixture.invalid', '/fixture/backup.sqlite', randomUUID));
  await local.repo.save(input);
  const id = String(local.sqlite.prepare('SELECT id FROM transactions').get()!.id);
  const first = local.sqlite.prepare('SELECT * FROM sync_outbox ORDER BY rowid').all()
    .find(r => JSON.parse(String(r.payload_json)).operations[0].revision.entityType === 'transaction')!;
  const oldRevision = JSON.parse(String(first.payload_json)).operations[0].opId;
  const oldEnvelope = JSON.stringify({ keyVersion: 1, immutableFixture: true });
  local.sqlite.prepare('UPDATE sync_outbox SET envelope_json=?,envelope_sha256=? WHERE commit_id=?').run(oldEnvelope, 'A'.repeat(43), first.commit_id!);
  await local.repo.save({ ...input, id, notes: 'Synthetic descendant' });
  await local.sync.run(reissueForKeyVersion(2, randomUUID));
  expect(local.sqlite.prepare('SELECT envelope_json,state,last_error FROM sync_outbox WHERE commit_id=?').get(first.commit_id!))
    .toMatchObject({ envelope_json: oldEnvelope, state: 'blocked', last_error: 'key_rotated' });
  const pending = local.sqlite.prepare("SELECT payload_json FROM sync_outbox WHERE state='pending' ORDER BY length(local_seq),local_seq").all()
    .map(r => JSON.parse(String(r.payload_json)).operations[0] as DecodedOperation)
    .filter(o => o.revision.entityType === 'transaction');
  expect(pending).toHaveLength(2);
  expect(pending[0].opId).not.toBe(oldRevision);
  expect(pending[1].parents).toEqual([pending[0].opId]);
  expect(local.sqlite.prepare('SELECT revision_id FROM sync_heads WHERE object_id=?').get(pending[1].objectId)!.revision_id).toBe(pending[1].opId);
});
