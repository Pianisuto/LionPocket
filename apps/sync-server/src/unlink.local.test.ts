import { randomUUID } from 'node:crypto';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import sodium from 'libsodium-wrappers-sumo';
import {
  SyncController, ProvisioningCrypto, startFinancialBaseline,
  epochArchiveSchema, operationalBSchema, epochActivationSchema, epochPreparationSecretScope,
  validateSyncBackup, syncTables, type SyncSaved, type SyncOptions,
} from '@lionpocket/sync-local';
import { LionPocketDatabase } from '../../desktop/src/main/database';
import { sqliteTestConnection } from '../../mobile/src/db/sqliteTestConnection';
import { captureBackup, verifyDatabase, loadBackupData, restoreBackup } from '../../mobile/src/db/backupRepository';
import { migrate, migrations } from '../../mobile/src/db/migrations';
import { mobileSyncDatabase } from '../../mobile/src/sync/database';
import { MobileRepository } from '../../mobile/src/db/repository';
import { founder, TestSecrets } from './testSupport';

const cleanup: (() => void)[] = [];
beforeAll(() => sodium.ready);
afterEach(() => {
  cleanup.splice(0).reverse().forEach(f => f());
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
const input = { kind: 'expense' as const, description: 'Pendente 🦁', plannedAmount: 12.34, actualAmount: 0, dueDate: '2026-10-02', status: 'paid' as const, settledDate: '2026-10-02' };

describe.each(['desktop', 'android'] as const)('%s local server unlink', dialect => {
  async function setup() {
    const secrets = new TestSecrets();
    const { client } = await founder(new ProvisioningCrypto(sodium), undefined, secrets);
    const desktop = dialect === 'desktop' ? new LionPocketDatabase(':memory:') : undefined;
    const native = dialect === 'android' ? sqliteTestConnection() : undefined;
    if (native) await migrate(native.db);
    const sqlite = desktop?.db ?? native!.sqlite;
    cleanup.push(() => sqlite.close());
    const db = desktop?.syncDatabase() ?? mobileSyncDatabase(native!.db);
    const repo = native ? new MobileRepository(native.db, randomUUID) : undefined;
    const save = async (patch = {}) => {
      if (desktop) desktop.saveTransaction({ ...input, ...patch });
      else await repo!.save({ ...input, ...patch });
    };
    await save();
    const goal = { name: 'Reserva', itemModel: '', link: '', targetAmount: 1000, savedAmount: 12.34, priority: 'high' as const, status: 'planned' as const };
    const recurring = { kind: 'expense' as const, active: true, description: 'Mensal', plannedAmount: 80, startMonth: '2026-10', dueDay: 10 };
    const installment = { description: 'Compra', installmentAmount: 9.99, totalInstallments: 3, currentInstallment: 1, currentDueDate: '2026-10-10' };
    if (desktop) {
      desktop.saveGoal(goal); desktop.saveRecurringExpense(recurring); desktop.saveInstallmentPurchase(installment);
      desktop.listTransactions({ month: '2026-10' });
    } else {
      await repo!.saveGoal(goal); await repo!.saveRecurring(recurring); await repo!.saveInstallment(installment);
      await repo!.list({ month: '2026-10' });
    }
    if (desktop) desktop.saveMonthlyPlanning({ month: '2026-10', safetyMarginCents: 50000 });
    else await repo!.saveMonthlyPlanning({ month: '2026-10', safetyMarginCents: 50000 });
    const goalId = desktop ? desktop.listGoals()[0].id : (await repo!.listGoals())[0].id;
    const reinforce = async (month: string, amountCents: number) => {
      if (desktop) desktop.saveGoalReinforcement({ goalId, month, amountCents });
      else await repo!.saveGoalReinforcement({ goalId, month, amountCents });
    };
    await reinforce('2026-10', 50000);
    await reinforce('2026-11', 70000);
    await db.run(startFinancialBaseline(client.profile, 'https://old.invalid', '/fixture/before.sqlite', randomUUID));
    await save({ description: 'Ainda não sincronizada', plannedAmount: 98.76 });
    if (desktop) desktop.saveMonthlyPlanning({ month: '2026-10', safetyMarginCents: 50123 });
    else await repo!.saveMonthlyPlanning({ month: '2026-10', safetyMarginCents: 50123 });
    await reinforce('2026-10', 51000);
    let saved: SyncSaved = { endpoint: 'https://old.invalid', profile: client.profile, phase: 'bound', owner: true, identity: { issuer: 'https://identity.invalid', subject: 'alice' } };
    const options: SyncOptions = {
      db, secrets, sodium, dialect,
      storage: { load: async () => structuredClone(saved), save: async value => { saved = structuredClone(value); } },
      login: vi.fn(), backup: vi.fn(),
    };
    const controller = new SyncController(options);
    cleanup.push(() => controller.coordinator.dispose());
    const fetch = vi.fn(async () => { throw new Error('Network must not be used by unlink'); });
    vi.stubGlobal('fetch', fetch);
    const preserved = () => Object.fromEntries(sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'sync_%' AND name NOT LIKE 'recovery_%'").all().map(row => [row.name, sqlite.prepare(`SELECT * FROM ${row.name} ORDER BY rowid`).all()]));
    const history = (table: string) => sqlite.prepare("SELECT payload_json FROM sync_review WHERE reason='detached_history' ORDER BY rowid").all().map(row => JSON.parse(String(row.payload_json))).filter(item => item.sourceTable === table).map(item => item.row);
    return { db, sqlite, native, reinforce, history, client, secrets, saved: () => saved, options, controller, fetch, save, preserved };
  }
  it('requires explicit consent before touching credentials or data', async () => {
    const c = await setup(), before = c.preserved(), profile = c.saved();
    await expect(c.controller.unlinkServer(false)).rejects.toThrow('Confirme');
    expect(c.saved()).toEqual(profile);
    expect(c.secrets.values.size).toBeGreaterThan(0);
    expect(c.preserved()).toEqual(before);
    expect(c.fetch).not.toHaveBeenCalled();
  });
  it('keeps all financial rows, pending edits, stable identities and import provenance; works locally and can bind again', async () => {
    const c = await setup();
    c.sqlite.prepare('INSERT INTO sync_import_provenance VALUES(?,?,?)').run('local-import', 'import-key', 'legacy-key');
    c.sqlite.prepare("INSERT INTO sync_review VALUES(?,NULL,'import_receipt:fixture',?)").run(randomUUID(), '{}');
    for (const version of [2, 3, 4]) await c.secrets.store(c.client.scope('dataKey', version), new Uint8Array(32));
    await c.options.storage.save({ ...c.saved(), profile: { ...c.client.profile, activeKeyVersion: 3 } });
    const other = await founder(new ProvisioningCrypto(sodium), undefined, c.secrets);
    const before = c.preserved();
    const identity = c.sqlite.prepare('SELECT * FROM sync_identity ORDER BY rowid').all();
    const provenance = c.sqlite.prepare('SELECT * FROM sync_import_provenance').all();
    const revisions = c.sqlite.prepare('SELECT * FROM sync_revisions ORDER BY rowid').all();
    expect(c.sqlite.prepare('SELECT * FROM sync_outbox').all().length).toBeGreaterThan(0);
    const status = await c.controller.unlinkServer(true);
    expect(status).toMatchObject({ phase: 'local', activity: 'local', mode: 'disabled', paused: false, endpoint: '', owner: false, deviceId: '', lastCompletedAt: null, recoveryPhase: null });
    expect(c.saved()).toEqual({ endpoint: '' });
    expect(c.preserved()).toEqual(before);
    expect(c.sqlite.prepare('SELECT * FROM sync_identity ORDER BY rowid').all()).toEqual(identity);
    expect(c.sqlite.prepare('SELECT * FROM sync_import_provenance').all()).toEqual(provenance);
    expect(c.history('sync_revisions')).toEqual(revisions);
    for (const table of ['sync_outbox', 'sync_inbox', 'sync_bindings', 'sync_revisions', 'sync_dirty']) expect(c.sqlite.prepare(`SELECT * FROM ${table}`).all()).toEqual([]);
    expect(await c.secrets.load(c.client.scope('signingSeed'))).toBeNull();
    for (const version of [1, 2, 3, 4]) expect(await c.secrets.load(c.client.scope('dataKey', version))).toBeNull();
    expect(await c.secrets.load(other.client.scope('signingSeed'))).not.toBeNull();
    expect(c.fetch).not.toHaveBeenCalled();
    expect(c.options.login).not.toHaveBeenCalled();
    validateSyncBackup(Object.fromEntries(syncTables.map(table => [table, c.sqlite.prepare(`SELECT * FROM ${table}`).all() as never])));
    if (c.native) await verifyDatabase(c.native.db, migrations.length);
    await c.save({ description: 'Salva sem conta nem servidor' });
    expect(c.sqlite.prepare("SELECT * FROM transactions WHERE description='Salva sem conta nem servidor'").get()).toBeTruthy();
    // Goal planning survives detaching untouched, stays editable offline and queues nothing.
    const reinforcements = () => c.sqlite.prepare('SELECT month,amount_cents FROM goal_monthly_reinforcements ORDER BY month').all().map(row => ({ ...row }));
    expect(reinforcements()).toEqual([{ month: '2026-10', amount_cents: 51000 }, { month: '2026-11', amount_cents: 70000 }]);
    await c.reinforce('2026-11', 0);
    await c.reinforce('2026-12', 90000);
    expect(reinforcements()).toEqual([{ month: '2026-10', amount_cents: 51000 }, { month: '2026-11', amount_cents: 0 }, { month: '2026-12', amount_cents: 90000 }]);
    expect(c.sqlite.prepare('SELECT * FROM sync_outbox').all()).toEqual([]);
    const financial = c.preserved();
    await c.db.run(startFinancialBaseline(other.client.profile, 'https://new.invalid', '/fixture/new.sqlite', randomUUID));
    expect(c.preserved()).toEqual(financial);
    expect(c.sqlite.prepare('SELECT * FROM sync_outbox').all().length).toBeGreaterThan(0);
    expect(c.sqlite.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });
  it('keeps the detached financial history through the existing Mobile backup/restore format', async () => {
    const c = await setup();
    if (!c.native) return;
    await c.controller.unlinkServer(true);
    const original = await captureBackup(c.native.db);
    const stage = sqliteTestConnection(), target = sqliteTestConnection();
    cleanup.push(() => stage.sqlite.close(), () => target.sqlite.close());
    const hydrated = await loadBackupData(stage.db, original.data, original.schemaVersion);
    await migrate(target.db);
    await restoreBackup(target.db, hydrated, async () => { /* Isolated empty fixture. */ });
    expect((await captureBackup(target.db)).data).toEqual(original.data);
    await verifyDatabase(target.db, migrations.length);
  });
  it('retains conflict alternatives and pending reviews locally without requiring a remote server', async () => {
    const c = await setup();
    const revision = c.sqlite.prepare('SELECT * FROM sync_revisions LIMIT 1').get()!;
    c.sqlite.prepare('INSERT INTO sync_conflicts VALUES(?,?,?,?,NULL)').run(randomUUID(), revision.object_id, JSON.stringify([revision.revision_id]), revision.revision_id);
    c.sqlite.prepare("INSERT INTO sync_review VALUES(?,?,'restored_missing_record',?)").run(randomUUID(), revision.object_id, JSON.stringify({ financialChoice: 'keep local' }));
    const before = c.preserved(), conflicts = c.sqlite.prepare('SELECT * FROM sync_conflicts').all();
    await c.controller.unlinkServer(true);
    expect(c.preserved()).toEqual(before);
    expect(c.history('sync_conflicts')).toEqual(conflicts);
    expect(c.history('sync_review').some(row => String(row.payload_json).includes('keep local'))).toBe(true);
  });
  it('rolls back the entire SQL cleanup on failure and resumes the durable intent on startup', async () => {
    const c = await setup(), before = c.preserved();
    const outbox = c.sqlite.prepare('SELECT * FROM sync_outbox').all();
    c.sqlite.exec("CREATE TRIGGER unlink_disk_failure BEFORE DELETE ON sync_bindings BEGIN SELECT RAISE(ABORT,'disk-full'); END");
    await expect(c.controller.unlinkServer(true)).rejects.toThrow('disk-full');
    expect(c.preserved()).toEqual(before);
    expect(c.sqlite.prepare('SELECT * FROM sync_outbox').all()).toEqual(outbox);
    expect(c.saved().unlinkPending).toBe(true);
    await expect(c.controller.create()).rejects.toThrow('Conclua');
    c.sqlite.exec('DROP TRIGGER unlink_disk_failure');
    const restarted = new SyncController(c.options);
    cleanup.push(() => restarted.coordinator.dispose());
    await restarted.resumeRecoveryOnStartup();
    expect((await restarted.status()).activity).toBe('local');
    expect(c.preserved()).toEqual(before);
    expect(c.fetch).not.toHaveBeenCalled();
  });
  it('retries secret removal failures and a crash after SQL cleanup without reconnecting or duplicating history', async () => {
    const c = await setup(), before = c.preserved();
    const remove = vi.spyOn(c.secrets, 'remove').mockRejectedValueOnce(new Error('storage unavailable'));
    await expect(c.controller.unlinkServer(true)).rejects.toThrow('storage unavailable');
    expect(c.saved().unlinkPending).toBe(true);
    expect(c.preserved()).toEqual(before);
    remove.mockRestore();
    const save = c.options.storage.save;
    vi.spyOn(c.options.storage, 'save').mockImplementation(async value => {
      if (!value.unlinkPending) throw new Error('crash before final profile save');
      await save(value);
    });
    await expect(c.controller.unlinkServer(true)).rejects.toThrow('crash');
    const history = c.sqlite.prepare("SELECT * FROM sync_review WHERE reason='detached_history' ORDER BY rowid").all();
    c.options.storage.save = save;
    const restarted = new SyncController(c.options);
    cleanup.push(() => restarted.coordinator.dispose());
    await restarted.resumeRecoveryOnStartup();
    expect(c.sqlite.prepare("SELECT * FROM sync_review WHERE reason='detached_history' ORDER BY rowid").all()).toEqual(history);
    expect(c.preserved()).toEqual(before);
    expect(c.saved()).toEqual({ endpoint: '' });
  });
  it('cleans staged recovery profiles, preparation secrets and immutable sidecars while preserving archived financial versions', async () => {
    const c = await setup();
    c.sqlite.exec([...epochArchiveSchema, ...operationalBSchema, ...epochActivationSchema].join(';'));
    const profileA = c.client.profile, id = randomUUID(), toEpoch = randomUUID();
    c.sqlite.prepare('INSERT INTO recovery_generations VALUES(?,?,0,NULL)').run(profileA.pin.vaultId, profileA.pin.serverEpoch);
    c.sqlite.prepare("INSERT INTO recovery_journal(restore_id,vault_id,from_epoch,to_epoch,backup_path,backup_sha256,profile_a_json,authorization_json,phase) VALUES(?,?,?,?,?,?,?,?, 'archived')").run(id, profileA.pin.vaultId, profileA.pin.serverEpoch, toEpoch, '/fixture/backup', 'hash', JSON.stringify(profileA), '{}');
    const { client: b } = await founder(new ProvisioningCrypto(sodium), { serverId: profileA.pin.serverId, serverEpoch: toEpoch }, c.secrets);
    c.sqlite.prepare("INSERT INTO recovery_b_saga(restore_id,profile_b_json,begin_public_json,expected_secrets_json,recovery_source,phase) VALUES(?,?,?,?,'new','identity_reserved')").run(id, JSON.stringify(b.profile), '{}', '{}');
    c.sqlite.prepare('INSERT INTO recovery_b_envelopes VALUES(?,?,?,?,?)').run(id, 0, randomUUID(), 'encrypted', 'digest');
    c.sqlite.prepare('INSERT INTO recovery_b_batches VALUES(?,?,?,?)').run(id, 0, '{}', 'digest');
    c.sqlite.prepare("INSERT INTO recovery_activation_saga(restore_id,activation_id,request_text,request_sha256,manifest_sha256,transition_sha256,to_epoch,binding_id,financial_sha256,phase) VALUES(?,?,?,?,?,?,?,?,?,'activation_requested')").run(id, randomUUID(), '{}', 'hash', 'hash', 'hash', toEpoch, randomUUID(), 'hash');
    const preparation = epochPreparationSecretScope(profileA, id, toEpoch);
    await c.secrets.store(preparation, new Uint8Array([1, 2, 3]));
    const revision = c.sqlite.prepare('SELECT * FROM sync_revisions LIMIT 1').get()!;
    c.sqlite.prepare('INSERT INTO recovery_archive_sync_revisions SELECT ?,?,r.* FROM sync_revisions r WHERE revision_id=?').run(profileA.pin.vaultId, profileA.pin.serverEpoch, revision.revision_id);
    await c.controller.unlinkServer(true);
    expect(c.sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'recovery_%'").all()).toEqual([]);
    expect(await c.secrets.load(preparation)).toBeNull();
    expect(await c.secrets.load(b.scope('signingSeed'))).toBeNull();
    expect(c.history('recovery_archive_sync_revisions')).toHaveLength(1);
    expect(c.sqlite.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });
  it('aborts a foreground cycle and waits for its tail before deleting metadata', async () => {
    const c = await setup();
    let started!: () => void, finish!: () => void;
    const entered = new Promise<void>(resolve => { started = resolve; });
    const tail = new Promise<void>(resolve => { finish = resolve; });
    const cycle = vi.spyOn(c.controller as unknown as { syncCycle(interactive: boolean, signal: AbortSignal): Promise<void> }, 'syncCycle').mockImplementation(async (_interactive, signal) => {
      started();
      await tail;
      expect(signal.aborted).toBe(true);
      await c.options.storage.save(c.saved());
    });
    c.controller.coordinator.setForeground(true);
    await entered;
    const unlink = c.controller.unlinkServer(true);
    await Promise.resolve();
    expect(c.saved().phase).toBe('bound');
    finish();
    await unlink;
    expect(c.saved()).toEqual({ endpoint: '' });
    vi.useFakeTimers();
    c.controller.setForeground(true);
    c.controller.localWriteCommitted();
    await vi.advanceTimersByTimeAsync(5000);
    expect(cycle).toHaveBeenCalledOnce();
    expect((await c.controller.status()).activity).toBe('local');
  });
  it('aborts pairing and waits for its final profile write before unlinking', async () => {
    const c = await setup();
    const pairing = c.controller as unknown as { pairingRunning: boolean; pairingAbort: AbortController };
    pairing.pairingRunning = true;
    pairing.pairingAbort = new AbortController();
    const unlink = c.controller.unlinkServer(true);
    expect(pairing.pairingAbort.signal.aborted).toBe(true);
    await c.options.storage.save({ ...c.saved(), phase: 'pairing' });
    pairing.pairingRunning = false;
    await unlink;
    expect(c.saved()).toEqual({ endpoint: '' });
    expect((await c.controller.status()).pairingStep).toBeUndefined();
  });
  it('waits for an existing command and prevents another command from starting during unlink', async () => {
    const c = await setup();
    let finish!: () => void, started!: () => void;
    const entered = new Promise<void>(resolve => { started = resolve; });
    const release = new Promise<void>(resolve => { finish = resolve; });
    const storage = c.options.storage.load;
    vi.spyOn(c.options.storage, 'load').mockImplementationOnce(async () => { started(); await release; return storage(); });
    const pause = c.controller.pause(true);
    await entered;
    const unlink = c.controller.unlinkServer(true);
    await expect(c.controller.configure('https://new.invalid')).rejects.toThrow('Aguarde');
    finish();
    await Promise.all([pause, unlink]);
    expect(c.saved()).toEqual({ endpoint: '' });
    expect((await c.controller.status()).paused).toBe(false);
  });
  it('also supports locally configured or pairing devices and repeated unlink', async () => {
    const c = await setup();
    await c.options.storage.save({ ...c.saved(), phase: 'pairing' });
    await c.controller.unlinkServer(true);
    const before = c.preserved();
    await c.controller.unlinkServer(true);
    await c.options.storage.save({ endpoint: 'https://configured.invalid' });
    await c.controller.unlinkServer(true);
    expect(c.preserved()).toEqual(before);
    expect((await c.controller.status()).activity).toBe('local');
    expect(c.fetch).not.toHaveBeenCalled();
  });
});
