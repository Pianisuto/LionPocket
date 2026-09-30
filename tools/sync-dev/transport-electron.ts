import { app } from 'electron';
import { createServer, type ServerResponse } from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import {
  DeviceProvisioning,
  ProvisioningCrypto,
  ManualSync,
  bindSynthetic,
  DevelopmentSyncActions,
  type RegistryResponse,
} from '@lionpocket/sync-local';
import { canonicalStringify, encodeUtf8 } from '@lionpocket/sync-protocol';
import { desktopCrypto } from '../../apps/desktop/src/main/sync/crypto';
import { DesktopSecretStore } from '../../apps/desktop/src/main/sync/secretStore';
import { loginDevelopmentOidc } from '../../apps/desktop/src/main/sync/oidc';
import { LionPocketDatabase } from '../../apps/desktop/src/main/database';
import { controlServer, initialize } from '../../apps/sync-server/src/server';
import {
  controlSchema,
  commitSchema,
  bindingSchema,
} from '../../apps/sync-server/src/schema';
import { keycloakIdentity } from '../../apps/sync-server/src/identity';
import {
  founder,
  syntheticBrowserLogin,
} from '../../apps/sync-server/src/testSupport';
const directory = mkdtempSync('/tmp/lion-sync-dev-native-');
app.setPath('userData', join(directory, 'electron'));
mkdirSync(join(directory, 'electron'));
const adb =
    process.env.ANDROID_ADB ?? '/home/lvulczak/Android/Sdk/platform-tools/adb',
  serial = process.env.ANDROID_SERIAL ?? 'emulator-5580';
const deviceCommand = (...args: string[]) =>
  execFileSync(adb, ['-s', serial, ...args], { encoding: 'utf8' });
const packageId = 'com.lionpocketmobile.cryptospike',
  endpoint = 'http://127.0.0.1:18774',
  issuer = 'http://127.0.0.1:18080/realms/lionpocket-dev';
app
  .whenReady()
  .then(async () => {
    const sodium = await desktopCrypto(),
      crypto = new ProvisioningCrypto(sodium),
      database = 'lion_native_' + randomUUID().replaceAll('-', '');
    let admin = new pg.Pool({
      connectionString: 'postgres://liondev:liondev@127.0.0.1:55432/postgres',
    });
    await admin.query(`CREATE DATABASE ${database}`);
    let pool = new pg.Pool({
      connectionString: `postgres://liondev:liondev@127.0.0.1:55432/${database}`,
    });
    await pool.query(controlSchema + commitSchema + bindingSchema);
    let environment = await initialize(pool);
    let api = controlServer({
      pool,
      crypto,
      environment,
      origin: endpoint,
      identity: keycloakIdentity(issuer),
      financialEnabled: true,
    });
    await new Promise<void>((r) => api.listen(18774, '127.0.0.1', r));
    const sessionA = await loginDevelopmentOidc(
        'lionpocket-desktop-dev',
        syntheticBrowserLogin,
      ),
      sessionB = await loginDevelopmentOidc(
        'lionpocket-android-dev',
        syntheticBrowserLogin,
      );
    const initial = await founder(
        crypto,
        environment,
        new DesktopSecretStore(join(directory, 'secret-wrappers')),
      ),
      a = initial.client;
    const send = async (action: string, value: unknown) => {
      const target =
          action === 'create'
            ? '/v1/vaults'
            : `/v1/vaults/${a.profile.pin.vaultId}/${action}`,
        body = canonicalStringify(value),
        proof = await a.proof(
          'POST',
          target,
          endpoint,
          body,
          sessionA.accessToken,
        ),
        response = await fetch(endpoint + target, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: 'Bearer ' + sessionA.accessToken,
            'x-lionpocket-proof': crypto.encode(
              encodeUtf8(canonicalStringify(proof)),
            ),
            connection: 'close',
          },
          body,
        });
      const result = (await response.json()) as RegistryResponse & {
        error?: string;
      };
      if (!response.ok) throw new Error(result.error);
      return result;
    };
    await send('create', {
      pin: a.profile.pin,
      request: initial.request,
      grant: initial.grant,
    });
    let bank = new LionPocketDatabase(join(directory, 'manual.sqlite'));
    bank.enableSyntheticManualSyncPilot();
    await bank
      .syncDatabase()
      .run(bindSynthetic(a.profile, endpoint, randomUUID()));
    let desktop = new ManualSync(
      bank.syncDatabase(),
      a,
      sodium,
      'desktop',
      endpoint,
    );
    let id = 0,
      pending:
        { id: number; action: string; [key: string]: unknown } | undefined,
      waiter: ServerResponse | undefined,
      readyResolve: () => void;
    let resultResolve: (v: unknown) => void, resultReject: (e: Error) => void;
    const ready = new Promise<void>((r) => (readyResolve = r));
    const reply = (res: ServerResponse, data: unknown) => {
      res.writeHead(200, {
        'content-type': 'application/json',
        'cache-control': 'no-store',
      });
      res.end(JSON.stringify(data));
    };
    const broker = createServer(async (req, res) => {
      if (req.url === '/bootstrap') {
        reply(res, { pin: a.profile.pin, endpoint, session: sessionB });
        return;
      }
      if (req.url?.startsWith('/command')) {
        if (pending) reply(res, pending);
        else waiter = res;
        return;
      }
      if (
        req.method !== 'POST' ||
        !['/ready', '/result'].includes(req.url ?? '')
      ) {
        reply(res, { error: 'unknown' });
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const value = JSON.parse(Buffer.concat(chunks).toString()) as {
        id: number;
        error?: string;
        result: unknown;
      };
      if (req.url === '/ready') {
        readyResolve();
        reply(res, { ok: true });
        return;
      }
      if (req.url === '/result' && value.id === pending?.id) {
        pending = undefined;
        if (value.error) resultReject(new Error(value.error));
        else resultResolve(value.result);
        reply(res, { ok: true });
        return;
      }
      reply(res, { error: 'unknown' });
    });
    await new Promise<void>((r) => broker.listen(18773, '127.0.0.1', r));
    const command = async <T = any>(
      action: string,
      data: Record<string, unknown> = {},
    ): Promise<T> => {
      if (pending) throw new Error('Command already pending');
      return new Promise<T>((r, j) => {
        const commandId = ++id;
        const timeout = setTimeout(() => {
          if (pending?.id === commandId)
            j(new Error('Native command timeout ' + action));
        }, 30000);
        resultResolve = (value) => {
          clearTimeout(timeout);
          r(value as T);
        };
        resultReject = (error) => {
          clearTimeout(timeout);
          j(error);
        };
        pending = { id: commandId, action, ...data };
        if (waiter) {
          reply(waiter, pending);
          waiter = undefined;
        }
      });
    };
    const checks: string[] = [],
      check = (condition: unknown, name: string) => {
        if (!condition) throw new Error(name);
        checks.push(name);
      };
    deviceCommand('reverse', 'tcp:18773', 'tcp:18773');
    deviceCommand('reverse', 'tcp:18774', 'tcp:18774');
    deviceCommand('reverse', 'tcp:18080', 'tcp:18080');
    // This is exclusively the isolated test application, never the installed personal app.
    deviceCommand('shell', 'pm', 'clear', packageId);
    deviceCommand(
      'shell',
      'am',
      'start',
      '-n',
      packageId + '/com.lionpocketmobile.MainActivity',
    );
    await ready;
    const request = await command('pair'),
      grant = await a.grant(request, request.fingerprint);
    a.acceptRegistry(await send('grants', grant));
    await send('deliveries', await a.delivery(request.deviceId));
    await command('receive');
    check(true, 'native pairing / sealed delivery / real cofres');
    const input = {
        kind: 'expense' as const,
        description: 'SYNTHETIC native exchange',
        notes: '🍋'.repeat(20000),
        plannedAmount: 12.34,
        dueDate: '2026-09-30',
        status: 'planned' as const,
      },
      t = bank.saveTransaction(input);
    await desktop.sync(sessionA.accessToken);
    let native = await command('sync');
    console.log(
      'native first pull',
      JSON.stringify({ quarantined: native.quarantined, inbox: native.inbox }),
    );
    check(
      native.transactions[0]?.description === input.description,
      'desktop -> Android create',
    );
    check(
      native.transactions[0]?.notes === input.notes,
      'native Unicode payload above control quota',
    );
    check(native.outbox.length === 0, 'own incoming commit has no echo');
    const localId = native.transactions[0].id;
    await command('save', {
      input: {
        ...input,
        id: localId,
        actualAmount: 0,
        status: 'paid',
        settledDate: '2026-09-30',
      },
    });
    native = await command('lost_response');
    const immutable = native.outbox[0].envelope_json;
    check(
      native.outbox[0].state === 'retry',
      'native lost response preserved retry',
    );
    native = await command('sync');
    check(
      native.outbox[0].envelope_json === immutable &&
        native.outbox[0].state === 'acknowledged',
      'native byte-identical retry',
    );
    await desktop.sync(sessionA.accessToken);
    check(
      bank.db
        .prepare('SELECT actual_cents FROM transactions WHERE id=?')
        .get(t.id)?.actual_cents === 0,
      'Android -> desktop settlement zero',
    );
    bank.saveTransaction({
      ...input,
      id: t.id,
      description: 'SYNTHETIC desktop edit',
    });
    await command('save', {
      input: { ...input, id: localId, description: 'SYNTHETIC Android edit' },
    });
    await Promise.all([desktop.sync(sessionA.accessToken), command('sync')]);
    await desktop.sync(sessionA.accessToken);
    native = await command('sync');
    check(
      native.conflicts.length === 1 && native.conflicts[0].heads.length === 2,
      'native concurrent edit retains branches',
    );
    const c = native.conflicts[0];
    await command('resolve', {
      objectId: c.objectId,
      heads: c.heads,
      revisionId: c.branches[0].revisionId,
    });
    await command('sync');
    await desktop.sync(sessionA.accessToken);
    check(
      (await new DevelopmentSyncActions(desktop).status()).conflicts.length ===
        0,
      'reviewed heads resolution converges',
    );
    bank.deleteTransaction(t.id);
    await command('save', {
      input: {
        ...input,
        id: localId,
        description: 'SYNTHETIC edit beside delete',
      },
    });
    await Promise.all([desktop.sync(sessionA.accessToken), command('sync')]);
    await desktop.sync(sessionA.accessToken);
    native = await command('sync');
    check(
      native.transactions.length === 0 && native.conflicts[0].deleted,
      'delete/edit keeps deleted original hidden',
    );
    const deleted = native.conflicts[0];
    const branch = deleted.branches.find(
      (b: any) => b.revision.action === 'put',
    );
    await command('resolve', {
      objectId: deleted.objectId,
      heads: deleted.heads,
      revisionId: branch.revisionId,
      recover: true,
    });
    native = await command('sync');
    await desktop.sync(sessionA.accessToken);
    check(
      native.transactions.length === 1 && native.transactions[0].id !== localId,
      'recovery uses new global/local identity',
    );
    const tombstone = deleted.branches.find(
      (b: any) => b.revision.action === 'delete',
    );
    await command('resolve', {
      objectId: deleted.objectId,
      heads: deleted.heads,
      revisionId: tombstone.revisionId,
    });
    await command('sync');
    await desktop.sync(sessionA.accessToken);
    check(
      (await new DevelopmentSyncActions(desktop).status()).conflicts.length ===
        0,
      'explicit delete resolution',
    );
    const before = await command('status');
    bank.db.close();
    writeFileSync(
      join(directory, 'crash-public-profile.json'),
      canonicalStringify(a.profile),
      { mode: 0o600 },
    );
    let killed = false;
    try {
      execFileSync(
        process.execPath,
        [join(process.cwd(), '.vite/sync-dev/reopen.cjs'), directory],
        { stdio: 'pipe' },
      );
    } catch (error) {
      killed = (error as { signal?: string }).signal === 'SIGKILL';
    }
    check(
      killed,
      'Electron SIGKILL after durable prepare / system cofre reopened in child',
    );
    bank = new LionPocketDatabase(join(directory, 'manual.sqlite'));
    desktop = new ManualSync(
      bank.syncDatabase(),
      a,
      sodium,
      'desktop',
      endpoint,
    );
    await new Promise<void>((r) => api.close(() => r()));
    await pool.end();
    if (process.env.LIONPOCKET_SYNC_CRASH_POSTGRES === 'synthetic-only') {
      await admin.end();
      execFileSync(
        'docker',
        [
          'compose',
          '-f',
          'tools/sync-dev/compose.yml',
          'kill',
          '-s',
          'SIGKILL',
          'postgres',
        ],
        { stdio: 'pipe' },
      );
      execFileSync(
        'docker',
        [
          'compose',
          '-f',
          'tools/sync-dev/compose.yml',
          'up',
          '-d',
          '--wait',
          'postgres',
        ],
        { stdio: 'pipe' },
      );
      admin = new pg.Pool({
        connectionString: 'postgres://liondev:liondev@127.0.0.1:55432/postgres',
      });
      check(
        true,
        'PostgreSQL SIGKILL / WAL recovery in isolated synthetic compose',
      );
    }
    pool = new pg.Pool({
      connectionString: `postgres://liondev:liondev@127.0.0.1:55432/${database}`,
    });
    environment = await initialize(pool);
    api = controlServer({
      pool,
      crypto,
      environment,
      origin: endpoint,
      identity: keycloakIdentity(issuer),
      financialEnabled: true,
    });
    await new Promise<void>((r) => api.listen(18774, '127.0.0.1', r));
    const [preparedCrash] = await bank
      .syncDatabase()
      .read(
        "SELECT envelope_json FROM sync_outbox WHERE state='prepared' AND commit_id=(SELECT commit_id FROM sync_revisions ORDER BY length(local_seq) DESC,local_seq DESC LIMIT 1)",
      );
    check(
      !!preparedCrash && typeof preparedCrash.envelope_json === 'string',
      'Electron crash retained exact prepared envelope',
    );
    deviceCommand('shell', 'am', 'force-stop', packageId);
    deviceCommand(
      'shell',
      'am',
      'start',
      '-n',
      packageId + '/com.lionpocketmobile.MainActivity',
    );
    native = await command('status');
    check(
      JSON.stringify(before.outbox) === JSON.stringify(native.outbox) &&
        JSON.stringify(before.inbox) === JSON.stringify(native.inbox),
      'native process crash/reopen durable inbox/outbox',
    );
    await command('sync');
    await desktop.sync(sessionA.accessToken);
    native = await command('sync');
    check(true, 'server and Electron bank reopened');
    const backup = await command('backup');
    check(
      backup.staging === 'PASS' && backup.restore === 'PASS',
      'native transport backup/staging/restore',
    );
    const ciphertexts = (
      await pool.query('SELECT envelope_text FROM sync_commits')
    ).rows;
    check(
      !JSON.stringify(ciphertexts).includes('SYNTHETIC'),
      'PostgreSQL contains ciphertext only',
    );
    a.acceptRegistry(
      await send(
        'grants',
        await a.grant(request, request.fingerprint, 'revoked'),
      ),
    );
    let revoked = false;
    try {
      await command('sync');
    } catch (e) {
      revoked = String(e).includes('device_revoked');
    }
    check(revoked, 'native revocation stops HTTP access');
    await new Promise<void>((r) => api.close(() => r()));
    bank.saveTransaction({
      ...input,
      description: 'SYNTHETIC offline desktop',
    });
    await command('save', {
      input: { ...input, description: 'SYNTHETIC offline Android' },
    });
    native = await command('status');
    check(native.transactions.length === 3, 'native remains usable offline');
    const result = {
      result: 'PASS',
      checks: checks.length,
      scenarios: checks,
      runtime: 'Electron main + Android Hermes/JSI + Keycloak + PostgreSQL',
      keyStorage: 'gnome_libsecret + Android Keystore',
      synthetic: true,
      remoteCommitCount: ciphertexts.length,
    };
    writeFileSync(
      process.argv[2] ?? join(directory, 'result.json'),
      JSON.stringify(result, null, 2),
    );
    console.log(JSON.stringify(result));
    deviceCommand('shell', 'am', 'force-stop', packageId);
    waiter?.end('{}');
    broker.closeAllConnections();
    await new Promise<void>((r) => broker.close(() => r()));
    bank.db.close();
    await pool.end();
    await admin.query(`DROP DATABASE ${database} WITH (FORCE)`);
    await admin.end();
    app.exit(0);
  })
  .catch((error) => {
    console.error(error);
    app.exit(1);
  });
