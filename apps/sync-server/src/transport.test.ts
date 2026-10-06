import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import pg from 'pg';
import sodium from 'libsodium-wrappers-sumo';
import {
  canonicalStringify,
  type CommitEnvelope,
  type RevisionPlaintext,
} from '@lionpocket/sync-protocol';
import {
  ManualSync,
  bindSynthetic,
  fetchSyncHttp,
  resolveConflict,
  validateSyncBackup,
  type DeviceProvisioning,
  type RegistryResponse,
  type SyncHttp,
} from '@lionpocket/sync-local';
import { LionPocketDatabase } from '../../desktop/src/main/database';
import { sqliteTestConnection } from '../../mobile/src/db/sqliteTestConnection';
import { migrate } from '../../mobile/src/db/migrations';
import { MobileRepository } from '../../mobile/src/db/repository';
import {
  captureBackup,
  loadBackupData,
  restoreBackup,
} from '../../mobile/src/db/backupRepository';
import { mobileSyncDatabase } from '../../mobile/src/sync/database';
import { loginDevelopmentOidc } from '../../desktop/src/main/sync/oidc';
import { controlServer, initialize } from './server';
import { commitSchema, controlSchema, bindingSchema } from './schema';
import { keycloakIdentity } from './identity';
import { founder, syntheticBrowserLogin, submitTestPairing } from './testSupport';
import {
  DeviceProvisioning as Provisioning,
  ProvisioningCrypto,
} from '@lionpocket/sync-local';

// Import the portable database adapter without loading native JSI modules in Node.
const enabled = process.env.LIONPOCKET_SYNC_INTEGRATION === '1';
describe.skipIf(!enabled)(
  'synthetic manualTransaction vertical: real PostgreSQL/Keycloak + both SQLite app repositories',
  () => {
    const dir = mkdtempSync(join(tmpdir(), 'lion-sync-transport-')),
      database = 'lion_sync_transport_' + randomUUID().replaceAll('-', '');
    const endpoint = 'http://127.0.0.1:18772',
      issuer = 'http://127.0.0.1:18080/realms/lionpocket-dev';
    let pool: pg.Pool,
      admin: pg.Pool,
      server: Server,
      crypto: ProvisioningCrypto,
      a: DeviceProvisioning,
      b: DeviceProvisioning,
      token: string;
    let desktop: LionPocketDatabase,
      mobile: ReturnType<typeof sqliteTestConnection>,
      repo: MobileRepository,
      da: ManualSync,
      mb: ManualSync;
    const path = join(dir, 'desktop.sqlite'),
      mobilePath = join(dir, 'android.sqlite');
    let env: Awaited<ReturnType<typeof initialize>>;
    const input = {
      kind: 'expense' as const,
      description: 'SYNTHETIC transport 🍋',
      plannedAmount: 12.34,
      dueDate: '2026-09-30',
      status: 'planned' as const,
    };
    const http = () => fetchSyncHttp(endpoint);
    async function control(
      client: DeviceProvisioning,
      action: string,
      value: unknown,
    ) {
      const target =
          action === 'create'
            ? '/v1/vaults'
            : `/v2/devices/vaults/${a.profile.pin.vaultId}/${action}`,
        body = canonicalStringify(value),
        accountToken = action === 'create' ? token : '',
        proof = await client.proof('POST', target, endpoint, body, accountToken);
      return http().request(
        target,
        body,
        crypto.encode(new TextEncoder().encode(canonicalStringify(proof))),
        accountToken,
      ) as Promise<RegistryResponse>;
    }
    async function start() {
      server = controlServer({
        pool,
        crypto,
        environment: env,
        origin: endpoint,
        identity: keycloakIdentity(issuer),
        financialEnabled: true,
        financialScope: 'manual',
      });
      await new Promise<void>((r) => server.listen(18772, '127.0.0.1', r));
    }
    async function closeServer() {
      await new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r())));
    }
    const localId = async () =>
      String(
        (await mb.db.read('SELECT local_id FROM sync_identity LIMIT 1'))[0]
          .local_id,
      );
    beforeAll(async () => {
      await sodium.ready;
      crypto = new ProvisioningCrypto(sodium);
      admin = new pg.Pool({
        connectionString: 'postgres://liondev:liondev@127.0.0.1:55432/postgres',
      });
      await admin.query(`CREATE DATABASE ${database}`);
      pool = new pg.Pool({
        connectionString: `postgres://liondev:liondev@127.0.0.1:55432/${database}`,
      });
      await pool.query(controlSchema + commitSchema + bindingSchema);
      env = await initialize(pool);
      await start();
      token = (
        await loginDevelopmentOidc(
          'lionpocket-desktop-dev',
          syntheticBrowserLogin,
        )
      ).accessToken;
      const initial = await founder(crypto, env);
      a = initial.client;
      await control(a, 'create', {
        pin: a.profile.pin,
        request: initial.request,
        grant: initial.grant,
      });
      b = await Provisioning.prepare(
        a.profile.pin,
        new (await import('./testSupport')).TestSecrets(),
        crypto,
      );
      const request = await submitTestPairing(a,b,endpoint);
      const grant = await a.grant(request);
      a.acceptRegistry(await control(a, 'grants', grant));
      const delivery = await a.delivery(b.profile.deviceId);
      await control(a, 'deliveries', delivery);
      await b.receive(await control(b, 'registry', {}));
      desktop = new LionPocketDatabase(path);
      desktop.enableSyntheticManualSyncPilot();
      mobile = sqliteTestConnection(mobilePath);
      await migrate(mobile.db);
      repo = new MobileRepository(mobile.db, randomUUID);
      await repo.enableSyntheticManualSyncPilot();
      await desktop
        .syncDatabase()
        .run(bindSynthetic(a.profile, endpoint, randomUUID()));
      await mobileSyncDatabase(mobile.db).run(
        bindSynthetic(b.profile, endpoint, randomUUID()),
      );
      da = new ManualSync(
        desktop.syncDatabase(),
        a,
        sodium,
        'desktop',
        endpoint,
      );
      mb = new ManualSync(
        mobileSyncDatabase(mobile.db),
        b,
        sodium,
        'android',
        endpoint,
      );
    }, 30000);
    afterAll(async () => {
      desktop?.db.close();
      mobile?.sqlite.close();
      if (server) await closeServer();
      if (pool) await pool.end();
      if (admin) {
        await admin.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
        await admin.end();
      }
      rmSync(dir, { recursive: true, force: true });
    });
    it('create, immutable preparation, response loss, identical retry, cursor own echo and zero settlement', async () => {
      const t = desktop.saveTransaction(input);
      const [pending] = await da.db.read('SELECT * FROM sync_outbox');
      const first = await da.prepare(String(pending.commit_id));
      expect(await da.prepare(String(pending.commit_id))).toBe(first);
      expect(() =>
        desktop.db.prepare('UPDATE sync_outbox SET envelope_json=?').run('{}'),
      ).toThrow('immutable');
      let lost = false;
      const flaky: SyncHttp = {
        request: async (target, body, proof, session) => {
          const result = await http().request(target, body, proof, session);
          if (target.endsWith('/commits') && !lost) {
            lost = true;
            throw new Error('lost_response');
          }
          return result;
        },
      };
      await expect(
        new ManualSync(da.db, a, sodium, 'desktop', endpoint, flaky).sync(),
      ).rejects.toThrow('lost_response');
      expect(
        (await da.db.read('SELECT state,envelope_json FROM sync_outbox'))[0],
      ).toMatchObject({ state: 'retry', envelope_json: first });
      await da.sync();
      await mb.sync();
      expect(
        (await pool.query('SELECT count(*)::int n FROM sync_commits')).rows[0]
          .n,
      ).toBe(1);
      expect(await mb.db.read('SELECT * FROM sync_outbox')).toHaveLength(0);
      expect(
        (
          await mb.db.read(
            'SELECT description,planned_amount_cents FROM transactions',
          )
        )[0],
      ).toMatchObject({
        description: input.description,
        planned_amount_cents: 1234,
      });
      await repo.save({
        ...input,
        id: await localId(),
        actualAmount: 0,
        status: 'paid',
        settledDate: '2026-09-30',
      });
      await mb.sync();
      await da.sync();
      expect(
        desktop.db
          .prepare('SELECT actual_cents,status FROM transactions WHERE id=?')
          .get(t.id),
      ).toMatchObject({ actual_cents: 0, status: 'paid' });
      expect(
        (
          await da.db.read(
            'SELECT received_cursor,applied_cursor FROM sync_local_state',
          )
        )[0],
      ).toMatchObject({ received_cursor: '2', applied_cursor: '2' });
    });
    it('crash/reopen client banks and server preserve exact envelopes, inbox, grants and projection', async () => {
      const before = await da.db.read(
        'SELECT envelope_json,envelope_sha256,receipt_json FROM sync_outbox',
      );
      desktop.db.close();
      mobile.sqlite.close();
      await closeServer();
      await start();
      desktop = new LionPocketDatabase(path);
      mobile = sqliteTestConnection(mobilePath);
      await migrate(mobile.db);
      repo = new MobileRepository(mobile.db, randomUUID);
      da = new ManualSync(
        desktop.syncDatabase(),
        a,
        sodium,
        'desktop',
        endpoint,
      );
      mb = new ManualSync(
        mobileSyncDatabase(mobile.db),
        b,
        sodium,
        'android',
        endpoint,
      );
      expect(
        await da.db.read(
          'SELECT envelope_json,envelope_sha256,receipt_json FROM sync_outbox',
        ),
      ).toEqual(before);
      await mb.sync().catch(() => mb.sync());
      await da.sync();
      expect(
        (await pool.query('SELECT count(*)::int n FROM sync_commits')).rows[0]
          .n,
      ).toBe(2);
    });
    it('concurrent edit retains both branches, projects common base and resolves only reviewed heads', async () => {
      const d = desktop.db
        .prepare('SELECT id FROM transactions LIMIT 1')
        .get()!;
      desktop.saveTransaction({
        ...input,
        id: String(d.id),
        description: 'SYNTHETIC desktop branch',
      });
      await repo.save({
        ...input,
        id: await localId(),
        description: 'SYNTHETIC Android branch',
      });
      await Promise.all([da.sync(), mb.sync()]);
      await da.sync();
      await mb.sync();
      const [conflict] = await da.db.read(
        'SELECT * FROM sync_conflicts WHERE resolution_id IS NULL',
      );
      expect(conflict).toBeDefined();
      const heads = JSON.parse(String(conflict.heads_json)) as string[];
      expect(heads).toHaveLength(2);
      expect(
        (await da.db.read('SELECT actual_cents,status FROM transactions'))[0],
      ).toMatchObject({ actual_cents: 0, status: 'paid' });
      const [row] = await da.db.read(
        'SELECT payload_json FROM sync_revisions WHERE revision_id=?',
        [heads[0]],
      );
      const choice = JSON.parse(String(row.payload_json)) as RevisionPlaintext;
      choice.authoredAt = new Date().toISOString();
      await expect(
        da.db.run(
          resolveConflict(
            String(conflict.object_id),
            heads.slice(0, 1),
            choice,
            'desktop',
            randomUUID,
          ),
        ),
      ).rejects.toThrow('heads_changed');
      await da.db.run(
        resolveConflict(
          String(conflict.object_id),
          heads,
          choice,
          'desktop',
          randomUUID,
        ),
      );
      await da.sync();
      await mb.sync();
      expect(
        await mb.db.read(
          'SELECT * FROM sync_conflicts WHERE resolution_id IS NULL',
        ),
      ).toHaveLength(0);
      expect(await da.db.read('SELECT * FROM sync_revisions')).toHaveLength(5);
    });
    it('delete versus edit retains tombstone and branch, never resurrects original object', async () => {
      const d = desktop.db
        .prepare('SELECT id FROM transactions LIMIT 1')
        .get()!;
      desktop.deleteTransaction(String(d.id));
      await repo.save({
        ...input,
        id: await localId(),
        description: 'SYNTHETIC edit beside deletion',
      });
      await Promise.all([da.sync(), mb.sync()]);
      await da.sync();
      await mb.sync();
      expect(await da.db.read('SELECT * FROM transactions')).toHaveLength(0);
      expect(await mb.db.read('SELECT * FROM transactions')).toHaveLength(0);
      const [conflict] = await mb.db.read(
          'SELECT * FROM sync_conflicts WHERE resolution_id IS NULL',
        ),
        heads = JSON.parse(String(conflict.heads_json)) as string[];
      const rows = await mb.db.read(
        'SELECT payload_json FROM sync_revisions WHERE object_id=?',
        [String(conflict.object_id)],
      );
      const put = rows
          .map((r) => JSON.parse(String(r.payload_json)) as RevisionPlaintext)
          .find((r) => r.action === 'put')!,
        del = rows
          .map((r) => JSON.parse(String(r.payload_json)) as RevisionPlaintext)
          .find((r) => r.action === 'delete')!;
      await expect(
        mb.db.run(
          resolveConflict(
            String(conflict.object_id),
            heads,
            put,
            'android',
            randomUUID,
          ),
        ),
      ).rejects.toThrow('deleted_object_requires_recovery');
      del.authoredAt = new Date().toISOString();
      del.action === 'delete' && (del.deletedAt = del.authoredAt);
      await mb.db.run(
        resolveConflict(
          String(conflict.object_id),
          heads,
          del,
          'android',
          randomUUID,
        ),
      );
      await mb.sync();
      await da.sync();
      expect(await da.db.read('SELECT * FROM transactions')).toHaveLength(0);
      expect(await mb.db.read('SELECT * FROM sync_heads')).toHaveLength(1);
      expect(await mb.db.read('SELECT * FROM sync_revisions')).toHaveLength(8);
    });
    it('stale reviewed heads keep the rejected draft and permit a new explicit resolution', async () => {
      const transaction = desktop.saveTransaction({
        ...input,
        description: 'SYNTHETIC stale heads base',
      });
      await da.sync();
      await mb.sync();
      const [identity] = await da.db.read(
        'SELECT object_id FROM sync_identity WHERE local_id=?',
        [transaction.id],
      );
      const objectId = String(identity.object_id);
      const [mobileIdentity] = await mb.db.read(
        'SELECT local_id FROM sync_identity WHERE object_id=?',
        [objectId],
      );
      const mobileId = String(mobileIdentity.local_id);
      desktop.saveTransaction({
        ...input,
        id: transaction.id,
        description: 'SYNTHETIC stale A',
      });
      await repo.save({
        ...input,
        id: mobileId,
        description: 'SYNTHETIC stale B',
      });
      await Promise.all([da.sync(), mb.sync()]);
      await da.sync();
      await mb.sync();
      const [conflict] = await da.db.read(
        'SELECT * FROM sync_conflicts WHERE object_id=? AND resolution_id IS NULL',
        [objectId],
      );
      const reviewed = JSON.parse(String(conflict.heads_json)) as string[];
      const [source] = await mb.db.read(
        'SELECT envelope_json FROM sync_outbox WHERE commit_id=(SELECT commit_id FROM sync_revisions WHERE revision_id=?)',
        [
          reviewed.find(
            (id) =>
              JSON.parse(
                String(
                  desktop.db
                    .prepare(
                      'SELECT payload_json FROM sync_revisions WHERE revision_id=?',
                    )
                    .get(id)!.payload_json,
                ),
              ).snapshot.description === 'SYNTHETIC stale B',
          )!,
        ],
      );
      const third = JSON.parse(String(source.envelope_json)) as CommitEnvelope;
      third.commitId = randomUUID();
      third.deviceSeq = '100';
      third.operations[0].opId = randomUUID();
      third.operations[0].nonce = crypto.encode(sodium.randombytes_buf(24));
      const { signature, ...unsigned } = third;
      void signature;
      const [row] = await mb.db.read(
        'SELECT payload_json FROM sync_revisions WHERE object_id=? ORDER BY length(local_seq) DESC,local_seq DESC LIMIT 1',
        [objectId],
      );
      const revision = JSON.parse(
        String(row.payload_json),
      ) as RevisionPlaintext;
      if (revision.entityType !== 'transaction' || revision.action !== 'put')
        throw new Error('Expected manual transaction branch.');
      revision.snapshot.description = 'SYNTHETIC third branch';
      const key = await b.secrets.load(b.scope('dataKey'));
      if (!key) throw new Error('key missing');
      try {
        third.operations[0].ciphertext = crypto.encode(
          sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
            new TextEncoder().encode(canonicalStringify(revision)),
            (await import('@lionpocket/sync-protocol')).operationAssociatedData(
              unsigned,
              0,
            ),
            null,
            crypto.decode(third.operations[0].nonce),
            key,
          ),
        );
      } finally {
        crypto.erase(key);
      }
      const seed = await b.secrets.load(b.scope('signingSeed'));
      if (!seed) throw new Error('seed missing');
      try {
        third.signature = crypto.sign(
          (await import('@lionpocket/sync-protocol')).commitSigningInput(
            unsigned,
          ),
          seed,
        );
      } finally {
        crypto.erase(seed);
      }
      await control(b, 'commits', third);
      revision.authoredAt = new Date().toISOString();
      await da.db.run(
        resolveConflict(objectId, reviewed, revision, 'desktop', randomUUID),
      );
      desktop.db.exec(
        "CREATE TEMP TRIGGER fail_rejection AFTER INSERT ON sync_rejected BEGIN SELECT RAISE(ABORT,'rejection crash'); END",
      );
      await expect(da.sync()).rejects.toThrow('rejection crash');
      expect(
        await da.db.read("SELECT * FROM sync_outbox WHERE state='blocked'"),
      ).toHaveLength(0);
      expect(await da.db.read('SELECT * FROM sync_rejected')).toHaveLength(0);
      desktop.db.exec('DROP TRIGGER fail_rejection');
      await expect(da.sync()).rejects.toThrow('heads_changed');
      expect(await da.db.read('SELECT * FROM sync_rejected')).toHaveLength(1);
      const [updated] = await da.db.read(
        'SELECT * FROM sync_conflicts WHERE object_id=? AND resolution_id IS NULL',
        [objectId],
      );
      const heads = JSON.parse(String(updated.heads_json)) as string[];
      expect(heads).toHaveLength(3);
      expect(
        await da.db.read("SELECT * FROM sync_outbox WHERE state='blocked'"),
      ).toHaveLength(1);
      await da.db.run(
        resolveConflict(objectId, heads, revision, 'desktop', randomUUID),
      );
      await da.sync();
      await mb.sync();
      expect(
        await da.db.read('SELECT * FROM sync_heads WHERE object_id=?', [
          objectId,
        ]),
      ).toHaveLength(1);
      expect(
        await da.db.read('SELECT * FROM sync_revisions WHERE object_id=?', [
          objectId,
        ]),
      ).toHaveLength(6);
    });
    it('atomic rollback protects log position and a fixed pull horizon excludes later commits', async () => {
      const before = (
        await pool.query('SELECT log_position::text FROM sync_vaults')
      ).rows[0].log_position;
      desktop.saveTransaction({
        ...input,
        description: 'SYNTHETIC transaction fault',
      });
      await pool.query(`CREATE FUNCTION fail_transport() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic injected failure'; END $$;
        CREATE TRIGGER fail_transport AFTER INSERT ON sync_operations FOR EACH ROW EXECUTE FUNCTION fail_transport()`);
      await expect(da.sync()).rejects.toThrow('temporary_failure');
      expect(
        (await pool.query('SELECT log_position::text FROM sync_vaults')).rows[0]
          .log_position,
      ).toBe(before);
      const [failed] = await da.db.read(
        "SELECT envelope_json FROM sync_outbox WHERE state='retry'",
      );
      await pool.query(
        'DROP TRIGGER fail_transport ON sync_operations; DROP FUNCTION fail_transport()',
      );
      await da.sync();
      expect(
        (
          await da.db.read(
            'SELECT envelope_json FROM sync_outbox WHERE envelope_json=?',
            [String(failed.envelope_json)],
          )
        )[0].envelope_json,
      ).toBe(failed.envelope_json);
      const pin = a.profile.pin,
        bindingId = randomUUID();
      const page = (await control(a, 'changes', {
        formatVersion: 1,
        bindingId,
        serverId: pin.serverId,
        serverEpoch: pin.serverEpoch,
        vaultId: pin.vaultId,
        cursor: '0',
        upperBound: null,
        limit: 1,
      })) as unknown as import('@lionpocket/sync-protocol').ChangesPage;
      expect(page.commits).toHaveLength(1);
      expect(page.nextCursor).toBe('1');
      expect(page.hasMore).toBe(true);
      desktop.saveTransaction({
        ...input,
        description: 'SYNTHETIC beyond horizon',
      });
      await da.sync();
      const rest = (await control(a, 'changes', {
        formatVersion: 1,
        bindingId,
        serverId: pin.serverId,
        serverEpoch: pin.serverEpoch,
        vaultId: pin.vaultId,
        cursor: page.nextCursor,
        upperBound: page.upperBound,
        limit: 100,
      })) as unknown as import('@lionpocket/sync-protocol').ChangesPage;
      expect(rest.upperBound).toBe(page.upperBound);
      expect(rest.nextCursor).toBe(page.upperBound);
      expect(rest.hasMore).toBe(false);
      const [original] = await da.db.read(
        'SELECT envelope_json,receipt_json FROM sync_outbox ORDER BY length(local_seq),local_seq LIMIT 1',
      );
      expect(
        await control(a, 'commits', JSON.parse(String(original.envelope_json))),
      ).toEqual(JSON.parse(String(original.receipt_json)));
      await mb.sync();
    });
    it('backup/staging preserves transport and conflict history; restore keeps state but disables session', async () => {
      validateSyncBackup(
        desktop.exportData(true) as import('@lionpocket/core').BackupData,
      );
      const backup = await captureBackup(mobile.db);
      validateSyncBackup(backup.data);
      const staging = sqliteTestConnection();
      try {
        await loadBackupData(staging.db, backup.data, backup.schemaVersion);
        expect((await captureBackup(staging.db)).data).toEqual(backup.data);
        await restoreBackup(staging.db, backup, async () => {
          /* Disposable staging bank has no user data to protect. */
        });
        const restored = await captureBackup(staging.db);
        expect(restored.data.sync_local_state[0].mode).toBe('disabled');
        expect(restored.data.sync_outbox).toEqual(backup.data.sync_outbox);
        expect(restored.data.sync_inbox).toEqual(backup.data.sync_inbox);
      } finally {
        staging.sqlite.close();
      }
    });
    it('remote financial text remains encrypted, reused IDs differ rejected, revocation prevents writes, offline writers work', async () => {
      const rows = (await pool.query('SELECT envelope_text FROM sync_commits'))
        .rows;
      expect(JSON.stringify(rows)).not.toContain('SYNTHETIC');
      const envlp = JSON.parse(rows[0].envelope_text) as CommitEnvelope;
      envlp.operations[0].ciphertext = crypto.nonce();
      const { signature, ...unsigned } = envlp;
      void signature;
      const seed = await a.secrets.load(a.scope('signingSeed'));
      envlp.signature = crypto.sign(
        (await import('@lionpocket/sync-protocol')).commitSigningInput(
          unsigned,
        ),
        seed!,
      );
      crypto.erase(seed!);
      await expect(control(a, 'commits', envlp)).rejects.toThrow(
        'idempotency_mismatch',
      );
      const request = await b.request(),
        grant = await a.grant(request, 'revoked');
      a.acceptRegistry(await control(a, 'grants', grant));
      await expect(mb.sync()).rejects.toThrow('device_revoked');
      await closeServer();
      desktop.saveTransaction({
        ...input,
        description: 'SYNTHETIC offline desktop',
      });
      await repo.save({ ...input, description: 'SYNTHETIC offline Android' });
      expect(
        await da.db.read("SELECT * FROM sync_outbox WHERE state='pending'"),
      ).toHaveLength(1);
      expect(
        await mb.db.read("SELECT * FROM sync_outbox WHERE state='pending'"),
      ).toHaveLength(1);
      await start();
    });
  },
);
