import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { fileURLToPath, URL } from 'node:url';
import {
  startFinancialBaseline,
  SyncCoordinator,
  type ProvisionedProfile,
} from '@lionpocket/sync-local';
import { migrate } from './migrations';
import { sqliteTestConnection } from './sqliteTestConnection';
import { MobileRepository } from './repository';
import { onLocalSyncWrite } from './syncWriters';
import { mobileSyncDatabase } from '../sync/database';
const cleanups: (() => void)[] = [];
afterEach(() => {
  cleanups
    .splice(0)
    .reverse()
    .forEach((f) => f());
  vi.useRealTimers();
});
async function setup(activate = true) {
  const bank = sqliteTestConnection();
  cleanups.push(() => bank.sqlite.close());
  await migrate(bank.db);
  const profile: ProvisionedProfile = {
    formatVersion: 1,
    installationId: randomUUID(),
    deviceId: randomUUID(),
    signingPublicKey: '',
    boxPublicKey: '',
    grants: [],
    checkpoint: { version: '1', sha256: 'A'.repeat(43) },
    pin: {
      serverId: randomUUID(),
      serverEpoch: randomUUID(),
      vaultId: randomUUID(),
      founderDeviceId: randomUUID(),
      authorityPublicKey: 'A'.repeat(43),
      keyVersion: 1,
    },
  };
  if (activate)
    await mobileSyncDatabase(bank.db).run(
      startFinancialBaseline(
        profile,
        'https://fixture.invalid',
        '/fixture/backup.sqlite',
        randomUUID,
      ),
    );
  return { ...bank, repo: new MobileRepository(bank.db, randomUUID) };
}
const input = {
  kind: 'expense' as const,
  description: 'Native local save',
  plannedAmount: 12.34,
  dueDate: '2026-10-02',
  status: 'planned' as const,
};
describe('native financial post-commit notification', () => {
  it('fires after successful commit, coalesces writes, and a network error cannot reject a local save', async () => {
    vi.useFakeTimers();
    const bank = await setup();
    const transport = vi.fn(async () => {
      throw new Error('offline');
    });
    const coordinator = new SyncCoordinator({
      eligible: async () => true,
      cycle: transport,
    });
    cleanups.push(() => coordinator.dispose());
    coordinator.setForeground(true);
    await vi.advanceTimersByTimeAsync(0);
    transport.mockClear();
    const listener = vi.fn(() => {
      expect(
        bank.sqlite.prepare('SELECT count(*) AS n FROM transactions').get()!.n,
      ).toBe(1);
      coordinator.request('local-write');
    });
    cleanups.push(onLocalSyncWrite(bank.db, listener));
    await bank.repo.save(input);
    const tx = (await bank.repo.list({ month: '2026-10' }))[0];
    await bank.repo.save({ ...input, id: tx.id, description: 'Saved again' });
    await bank.repo.settleMany([tx.id]);
    expect(listener).toHaveBeenCalledTimes(3);
    const before = bank.sqlite.prepare('SELECT * FROM sync_outbox').all();
    await vi.advanceTimersByTimeAsync(2000);
    expect(transport).toHaveBeenCalledTimes(1);
    expect(bank.sqlite.prepare('SELECT * FROM sync_outbox').all()).toEqual(
      before,
    );
    expect((await bank.repo.list({ month: '2026-10' }))[0].status).toBe('paid');
  });
  it('rollback never notifies and failing post-commit observers cannot roll back saved money', async () => {
    const bank = await setup(),
      listener = vi.fn(() => {
        throw new Error('observer failure');
      });
    cleanups.push(onLocalSyncWrite(bank.db, listener));
    await bank.repo.save(input);
    expect(listener).toHaveBeenCalledTimes(1);
    bank.sqlite.exec(
      "CREATE TRIGGER fail_outbox BEFORE INSERT ON sync_outbox BEGIN SELECT RAISE(ABORT,'disk-full'); END",
    );
    await expect(
      bank.repo.save({ ...input, description: 'rollback' }),
    ).rejects.toThrow('disk-full');
    expect(listener).toHaveBeenCalledTimes(1);
    expect(await bank.repo.list({ month: '2026-10' })).toHaveLength(1);
  });
  it('applying a signed encrypted inbox on the native transaction adapter emits no local-write notification', async () => {
    const bank = await setup(false);
    // Reuse actual sodium/signatures and a real desktop sender, while keeping native types isolated.
    const sodium = (await import('libsodium-wrappers-sumo')).default;
    await sodium.ready;
    const { founder } = await import(
      fileURLToPath(
        new URL('../../../sync-server/src/testSupport.ts', import.meta.url),
      )
    );
    const { LionPocketDatabase } = await import(
      fileURLToPath(
        new URL('../../../desktop/src/main/database.ts', import.meta.url),
      )
    );
    const { ManualSync, ProvisioningCrypto, receivePage } =
      await import('@lionpocket/sync-local');
    const { client } = await founder(new ProvisioningCrypto(sodium));
    const source = new LionPocketDatabase(':memory:');
    cleanups.push(() => source.db.close());
    source.db.exec('DELETE FROM categories; DELETE FROM payment_methods;');
    await source
      .syncDatabase()
      .run(
        startFinancialBaseline(
          client.profile,
          'https://fixture.invalid',
          '/fixture/backup.sqlite',
          randomUUID,
        ),
      );
    source.saveTransaction(input);
    const sender = new ManualSync(
      source.syncDatabase(),
      client,
      sodium,
      'desktop',
      'https://fixture.invalid',
    );
    const id = String(
      source.db.prepare('SELECT commit_id FROM sync_outbox').get()!.commit_id,
    );
    const envelope = JSON.parse(await sender.prepare(id));
    // The receiving financial bank uses the sender's pinned vault/device for this isolated fixture.
    await mobileSyncDatabase(bank.db).run(
      startFinancialBaseline(
        client.profile,
        'https://fixture.invalid',
        '/fixture/backup.sqlite',
        randomUUID,
      ),
    );
    const binding = String(
      bank.sqlite.prepare('SELECT binding_id FROM sync_local_state').get()!
        .binding_id,
    );
    const listener = vi.fn();
    cleanups.push(onLocalSyncWrite(bank.db, listener));
    const before = bank.sqlite.prepare('SELECT * FROM sync_outbox').all();
    await mobileSyncDatabase(bank.db).run(
      receivePage(
        binding,
        '0',
        '1',
        '1',
        [{ envelope, logPosition: '1', acceptedRegistryVersion: '1' }],
        false,
      ),
    );
    await new ManualSync(
      mobileSyncDatabase(bank.db),
      client,
      sodium,
      'android',
      'https://fixture.invalid',
    ).applyInbox();
    expect(await bank.repo.list({ month: '2026-10' })).toHaveLength(1);
    expect(listener).not.toHaveBeenCalled();
    expect(bank.sqlite.prepare('SELECT * FROM sync_outbox').all()).toEqual(
      before,
    );
  });
});
