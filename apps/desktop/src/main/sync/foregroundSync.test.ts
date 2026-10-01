import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import sodium from 'libsodium-wrappers-sumo';
import {
  BetaSync,
  ManualSync,
  ProvisioningCrypto,
  receivePage,
  startFinancialBaseline,
  type BetaSaved,
} from '@lionpocket/sync-local';
import {
  canonicalStringify,
  type CommitEnvelope,
} from '@lionpocket/sync-protocol';
import { LionPocketDatabase } from '../database';
import { founder, TestSecrets } from '../../../../sync-server/src/testSupport';
const cleanup: (() => void)[] = [];
beforeAll(() => sodium.ready);
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-01T12:00:00Z'));
});
afterEach(() => {
  cleanup
    .splice(0)
    .reverse()
    .forEach((f) => f());
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
const input = {
  kind: 'expense' as const,
  description: 'Saved locally',
  plannedAmount: 12.34,
  dueDate: '2026-10-02',
  status: 'planned' as const,
};
async function setup(path = ':memory:') {
  const secrets = new TestSecrets();
  const { client } = await founder(new ProvisioningCrypto(sodium), undefined, secrets);
  const bank = new LionPocketDatabase(path);
  const close = () => bank.db.close();
  cleanup.push(close);
  bank.db.exec('DELETE FROM categories; DELETE FROM payment_methods;');
  await bank
    .syncDatabase()
    .run(
      startFinancialBaseline(
        client.profile,
        'https://fixture.invalid',
        '/fixture/backup.sqlite',
        randomUUID,
      ),
    );
  let saved: BetaSaved = {
    endpoint: 'https://fixture.invalid',
    profile: client.profile,
    phase: 'bound',
    identity: { issuer: 'https://identity.invalid', subject: 'alice' },
  };
  const login = vi.fn(async () => ({
    accessToken: 'only-in-memory',
    issuer: saved.identity!.issuer,
    subject: 'alice',
    expiresAt: Date.now() + 300000,
  }));
  const options = {
    db: bank.syncDatabase(),
    secrets: client.secrets,
    sodium,
    dialect: 'desktop' as const,
    storage: {
      load: async () => structuredClone(saved),
      save: async (s: BetaSaved) => {
        saved = structuredClone(s);
      },
    },
    backup: async () => '/fixture/backup.sqlite',
    login,
  };
  const beta = new BetaSync(options);
  const remove = bank.onLocalSyncWrite(() => beta.localWriteCommitted());
  cleanup.push(() => {
    remove();
    beta.coordinator.dispose();
  });
  const log: CommitEnvelope[] = [];
  const posts: string[] = [];
  const environment = {
    ...client.profile.pin,
    financialSyncEnabled: true,
    entityScopes: ['transaction'],
    oidc: { issuer: 'https://identity.invalid' },
  };
  const fetch = vi.fn(
    async (url: string | URL | Request, init?: RequestInit) => {
      const action = String(url).split('/').at(-1)!;
      let result: unknown;
      if (action === 'environment') result = environment;
      else if (action === 'registry')
        result = {
          pin: client.profile.pin,
          grants: client.profile.grants,
          delivery: null,
        };
      else if (action === 'changes') {
        const request = JSON.parse(String(init?.body));
        const upper = request.upperBound ?? String(log.length);
        result = {
          serverId: client.profile.pin.serverId,
          serverEpoch: client.profile.pin.serverEpoch,
          vaultId: client.profile.pin.vaultId,
          bindingId: request.bindingId,
          upperBound: upper,
          nextCursor: upper,
          hasMore: false,
          commits: log
            .slice(Number(request.cursor), Number(upper))
            .map((envelope, index) => ({
              envelope,
              logPosition: String(Number(request.cursor) + index + 1),
              acceptedRegistryVersion: '1',
            })),
        };
      } else if (action === 'commits') {
        const envelope = JSON.parse(String(init?.body)) as CommitEnvelope;
        posts.push(String(init?.body));
        let position = log.findIndex((e) => e.commitId === envelope.commitId);
        if (position < 0) {
          position = log.length;
          log.push(envelope);
        }
        result = {
          serverId: envelope.serverId,
          serverEpoch: envelope.serverEpoch,
          vaultId: envelope.vaultId,
          commitId: envelope.commitId,
          deviceId: envelope.deviceId,
          deviceSeq: envelope.deviceSeq,
          result: 'accepted',
          logPosition: String(position + 1),
          acceptedRegistryVersion: '1',
          envelopeSha256: client.crypto.hash(canonicalStringify(envelope)),
          heads: envelope.operations
            .map((op) => ({ objectId: op.objectId, revisionIds: [op.opId] }))
            .sort((a, b) => a.objectId.localeCompare(b.objectId)),
        };
      } else throw new Error('unexpected request');
      return new Response(canonicalStringify(result));
    },
  );
  vi.stubGlobal('fetch', fetch);
  return {
    bank,
    secrets,
    beta,
    login,
    fetch,
    client,
    options,
    posts,
    environment,
    close,
  };
}
async function foreground(beta: BetaSync) {
  beta.setForeground(true);
  await vi.advanceTimersByTimeAsync(0);
}
async function manual(beta: BetaSync) {
  const p = beta.sync();
  await vi.advanceTimersByTimeAsync(0);
  return p;
}
describe('financial foreground sync boundaries', () => {
  it('never opens login automatically; manual authenticates and automatic reuses only a valid volatile session', async () => {
    const s = await setup();
    await foreground(s.beta);
    expect(s.login).not.toHaveBeenCalled();
    expect((await s.beta.status()).activity).toBe('action-required');
    await manual(s.beta);
    expect(s.login).toHaveBeenCalledTimes(1);
    s.bank.saveTransaction(input);
    await vi.advanceTimersByTimeAsync(2000);
    expect(s.login).toHaveBeenCalledTimes(1);
    expect((await s.beta.status()).activity).toBe('synced');
    await vi.advanceTimersByTimeAsync(300000);
    s.beta.setForeground(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(s.login).toHaveBeenCalledTimes(1);
    expect((await s.beta.status()).activity).toBe('action-required');
    expect(JSON.stringify(await s.options.storage.load())).not.toContain(
      'only-in-memory',
    );
  });
  it('four rapid financial commits remain immutable and share one debounced network pass', async () => {
    const s = await setup();
    await foreground(s.beta);
    await manual(s.beta);
    s.fetch.mockClear();
    const tx = s.bank.saveTransaction(input);
    s.bank.saveTransaction({
      ...input,
      id: tx.id,
      description: 'Edited locally',
    });
    s.bank.setTransactionPriority({
      month: '2026-10',
      transactionId: tx.id,
      pinned: true,
    });
    s.bank.settleTransaction(tx.id);
    const before = s.bank.db
      .prepare(
        'SELECT commit_id,payload_json FROM sync_outbox ORDER BY local_seq',
      )
      .all();
    expect(before).toHaveLength(4);
    expect(s.fetch).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1999);
    expect(s.fetch).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(
      s.fetch.mock.calls.filter(([url]) => String(url).endsWith('/registry')),
    ).toHaveLength(1);
    expect(
      s.bank.db
        .prepare(
          'SELECT commit_id,payload_json FROM sync_outbox ORDER BY local_seq',
        )
        .all(),
    ).toEqual(before);
    expect(s.beta.coordinator.error).toBeUndefined();
    expect((await s.beta.status()).sync?.pending).toBe(0);
  });
  it('offline failure leaves the save, pending payloads and local reads available; reopening retries foreground without spontaneous login', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'lion-foreground-'));
    cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
    const path = join(directory, 'bank.sqlite');
    const s = await setup(path);
    await foreground(s.beta);
    await manual(s.beta);
    s.fetch.mockRejectedValue(new TypeError('Failed to fetch'));
    const tx = s.bank.saveTransaction(input);
    const pending = s.bank.db
      .prepare("SELECT * FROM sync_outbox WHERE state='pending'")
      .all();
    expect(pending).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2000);
    expect(s.bank.db.prepare('SELECT * FROM sync_outbox').all()).toEqual(
      pending,
    );
    expect(s.bank.listTransactions({ month: '2026-10' })[0].id).toBe(tx.id);
    expect((await s.beta.status()).activity).toBe('unavailable');
    s.beta.coordinator.dispose();
    s.bank.db.close();
    cleanup.splice(cleanup.indexOf(s.close), 1);
    // Open the same durable SQLite, with a fresh controller (sessions are not restored).
    const reopened = new LionPocketDatabase(path);
    cleanup.push(() => reopened.db.close());
    const next = new BetaSync({ ...s.options, db: reopened.syncDatabase() });
    cleanup.push(() => next.coordinator.dispose());
    expect(reopened.db.prepare('SELECT * FROM sync_outbox').all()).toEqual(
      pending,
    );
    const calls = s.fetch.mock.calls.length;
    await foreground(next);
    expect(s.fetch.mock.calls.length).toBe(calls + 1);
    expect(s.login).toHaveBeenCalledTimes(1);
    expect((await next.status()).sync?.pending).toBe(1);
  });
  it('a pending debounce stays local while paused or inactive, then resumes on an explicit foreground event', async () => {
    const s = await setup();
    await foreground(s.beta);
    await manual(s.beta);
    s.fetch.mockClear();
    await s.beta.pause(true);
    s.bank.saveTransaction(input);
    await vi.advanceTimersByTimeAsync(10000);
    expect(s.fetch).not.toHaveBeenCalled();
    expect((await s.beta.status()).activity).toBe('paused');
    s.beta.setForeground(false);
    await s.beta.pause(false);
    await vi.advanceTimersByTimeAsync(10000);
    expect(s.fetch).not.toHaveBeenCalled();
    s.beta.setForeground(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(s.beta.coordinator.error).toBeUndefined();
    expect((await s.beta.status()).sync?.pending).toBe(0);
  });
  it('applying a real encrypted remote inbox does not notify local-write listeners or generate a new outbox', async () => {
    const s = await setup();
    s.bank.saveTransaction(input);
    const engine = new ManualSync(
      s.bank.syncDatabase(),
      s.client,
      sodium,
      'desktop',
      'https://fixture.invalid',
    );
    const id = String(
      s.bank.db.prepare('SELECT commit_id FROM sync_outbox').get()!.commit_id,
    );
    const envelope = JSON.parse(await engine.prepare(id));
    const target = new LionPocketDatabase(':memory:');
    cleanup.push(() => target.db.close());
    target.db.exec('DELETE FROM categories; DELETE FROM payment_methods;');
    await target
      .syncDatabase()
      .run(
        startFinancialBaseline(
          s.client.profile,
          'https://fixture.invalid',
          '/fixture/backup.sqlite',
          randomUUID,
        ),
      );
    const notify = vi.fn();
    target.onLocalSyncWrite(notify);
    const binding = String(
      target.db.prepare('SELECT binding_id FROM sync_local_state').get()!
        .binding_id,
    );
    await target
      .syncDatabase()
      .run(
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
      target.syncDatabase(),
      s.client,
      sodium,
      'desktop',
      'https://fixture.invalid',
    ).applyInbox();
    expect(target.listTransactions({ month: '2026-10' })).toHaveLength(1);
    expect(target.db.prepare('SELECT * FROM sync_outbox').all()).toHaveLength(
      0,
    );
    expect(notify).not.toHaveBeenCalled();
  });
  it('a financial write while the push is awaiting network commits locally and schedules a later ordered pass', async () => {
    const s = await setup();
    await foreground(s.beta);
    await manual(s.beta);
    s.bank.saveTransaction(input);
    const original = s.fetch.getMockImplementation()!;
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let held = false;
    s.fetch.mockImplementation(async (...args) => {
      if (String(args[0]).endsWith('/commits') && !held) {
        held = true;
        await gate;
      }
      return original(...args);
    });
    s.fetch.mockClear();
    const first = s.beta.sync();
    await vi.advanceTimersByTimeAsync(0);
    expect(held).toBe(true);
    const second = s.bank.saveTransaction({
      ...input,
      description: 'Saved during network wait',
    });
    expect(
      s.bank
        .listTransactions({ month: '2026-10' })
        .some((t) => t.id === second.id),
    ).toBe(true);
    await vi.advanceTimersByTimeAsync(3000);
    expect(
      s.fetch.mock.calls.filter(([url]) => String(url).endsWith('/registry')),
    ).toHaveLength(1);
    release();
    await vi.advanceTimersByTimeAsync(0);
    await first;
    expect(
      s.fetch.mock.calls.filter(([url]) => String(url).endsWith('/registry')),
    ).toHaveLength(2);
    expect((await s.beta.status()).sync?.pending).toBe(0);
  });
  it('a failed push retains prepared bytes/pending, and the next foreground retries exactly the same envelope', async () => {
    const s = await setup();
    await foreground(s.beta);
    await manual(s.beta);
    const original = s.fetch.getMockImplementation()!;
    const attempted: string[] = [];
    s.fetch.mockImplementation(async (...args) => {
      if (String(args[0]).endsWith('/commits')) {
        attempted.push(String(args[1]?.body));
        return new Response(
          canonicalStringify({ error: 'temporary_failure' }),
          { status: 503 },
        );
      }
      return original(...args);
    });
    s.bank.saveTransaction(input);
    await vi.advanceTimersByTimeAsync(2000);
    const [pending] = s.bank.db.prepare('SELECT * FROM sync_outbox').all();
    expect(pending.state).toBe('retry');
    expect(pending.envelope_json).toBe(attempted[0]);
    expect((await s.beta.status()).sync?.pending).toBe(1);
    await vi.advanceTimersByTimeAsync(60000);
    expect(attempted).toHaveLength(1);
    s.fetch.mockImplementation(original);
    s.beta.setForeground(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(s.posts[0]).toBe(attempted[0]);
    expect((await s.beta.status()).sync?.pending).toBe(0);
  });
  it('preserves a manual request across the temporary lifecycle blur of an intentional system-browser login', async () => {
    const s = await setup();
    await foreground(s.beta);
    const login = s.login.getMockImplementation()!;
    s.login.mockImplementation(async () => {
      s.beta.setForeground(false);
      const session = await login();
      s.beta.setForeground(true);
      return session;
    });
    const result = s.beta.sync();
    await vi.advanceTimersByTimeAsync(1);
    await result;
    expect(s.login).toHaveBeenCalledTimes(1);
    expect((await s.beta.status()).activity).toBe('synced');
  });
  it('never labels pending reviews/quarantine as synced and cofre errors retain pending', async () => {
    const s = await setup();
    await foreground(s.beta);
    await manual(s.beta);
    s.bank.saveTransaction(input);
    s.secrets.unavailable = true;
    await vi.advanceTimersByTimeAsync(2000);
    expect((await s.beta.status()).activity).toBe('action-required');
    expect((await s.beta.status()).sync?.pending).toBe(1);
    s.secrets.unavailable = false;
    await manual(s.beta);
    s.bank.db
      .prepare('INSERT INTO sync_review VALUES(?,NULL,?,?)')
      .run(randomUUID(), 'identity_unresolved', '{}');
    expect((await s.beta.status()).activity).toBe('review');
  });
});
