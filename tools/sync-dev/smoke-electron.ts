import { app, safeStorage } from 'electron';
import { writeFile, readdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { canonicalStringify, decodeCanonical } from '@lionpocket/sync-protocol';
import {
  DeviceProvisioning,
  ProvisioningCrypto,
  type RegistryResponse,
} from '@lionpocket/sync-local';
import { desktopCrypto } from '../../apps/desktop/src/main/sync/crypto';
import { DesktopSecretStore } from '../../apps/desktop/src/main/sync/secretStore';
import { loginDevelopmentOidc } from '../../apps/desktop/src/main/sync/oidc';
import {
  founder,
  syntheticBrowserLogin,
} from '../../apps/sync-server/src/testSupport';

import { mkdtempSync } from 'node:fs';
const directory = mkdtempSync(join(tmpdir(), 'lion-sync-dev-smoke-'));
app.setPath('userData', join(directory, 'electron'));
const origin = 'http://127.0.0.1:8787';
app
  .whenReady()
  .then(async () => {
    const crypto = new ProvisioningCrypto(await desktopCrypto());
    let checks = 0;
    const check = (ok: boolean) => {
      if (!ok) throw new Error('Smoke verification failed.');
      checks++;
    };
    const environment = (await (
      await fetch(origin + '/v1/environment')
    ).json()) as {
      serverId: string;
      serverEpoch: string;
      financialSyncEnabled: boolean;
      entityScopes: string[];
    };
    check(
      !environment.financialSyncEnabled &&
        environment.entityScopes.length === 0,
    );
    const sessionA = await loginDevelopmentOidc(
      'lionpocket-desktop-dev',
      syntheticBrowserLogin,
      20000,
    );
    const sessionB = await loginDevelopmentOidc(
      'lionpocket-android-dev',
      syntheticBrowserLogin,
      20000,
    );
    check(sessionA.subject === sessionB.subject);
    const storeA = new DesktopSecretStore(join(directory, 'a')),
      storeB = new DesktopSecretStore(join(directory, 'b'));
    const {
      client: a,
      request: rootRequest,
      grant,
    } = await founder(
      crypto,
      { serverId: environment.serverId, serverEpoch: environment.serverEpoch },
      storeA,
    );
    const send = async (
      client: DeviceProvisioning,
      token: string,
      method: string,
      path: string,
      value?: unknown,
    ) => {
      const body = value === undefined ? '' : canonicalStringify(value),
        proof = await client.proof(method, path, origin, body, token);
      const result = await fetch(origin + path, {
        method,
        headers: {
          authorization: 'Bearer ' + token,
          'content-type': 'application/json',
          'x-lionpocket-proof': Buffer.from(canonicalStringify(proof)).toString(
            'base64url',
          ),
        },
        body: body || undefined,
      });
      const response = decodeCanonical(
        new Uint8Array(await result.arrayBuffer()),
        4194304,
      ) as RegistryResponse & { error?: string };
      if (!result.ok) throw new Error(response.error ?? 'Control API failure.');
      checks++;
      return response;
    };
    const base = `/v1/vaults/${a.profile.pin.vaultId}`;
    a.acceptRegistry(
      await send(a, sessionA.accessToken, 'POST', '/v1/vaults', {
        pin: a.profile.pin,
        grant,
        request: rootRequest,
      }),
    );
    const b = await DeviceProvisioning.prepare(a.profile.pin, storeB, crypto),
      request = await b.request();
    await send(b, sessionB.accessToken, 'POST', base + '/pairings', request);
    let mismatch = false;
    try {
      await a.grant(request, crypto.nonce());
    } catch {
      mismatch = true;
    }
    check(mismatch);
    const approval = await a.grant(request, request.fingerprint);
    a.acceptRegistry(
      await send(a, sessionA.accessToken, 'POST', base + '/grants', approval),
    );
    const delivery = await a.delivery(b.profile.deviceId);
    await send(a, sessionA.accessToken, 'POST', base + '/deliveries', delivery);
    await b.receive(
      await send(b, sessionB.accessToken, 'GET', base + '/registry'),
    );
    const reloaded = new DeviceProvisioning(
      JSON.parse(canonicalStringify(b.profile)),
      new DesktopSecretStore(join(directory, 'b')),
      crypto,
    );
    const keyA = await storeA.load(a.scope('dataKey')),
      keyB = await reloaded.secrets.load(reloaded.scope('dataKey'));
    check(!!keyA && !!keyB && crypto.encode(keyA) === crypto.encode(keyB));
    if (keyA) crypto.erase(keyA);
    if (keyB) crypto.erase(keyB);
    check((await storeB.load(b.scope('authoritySeed'))) === null);
    check(
      (await readdir(join(directory, 'a'))).every((file) =>
        file.endsWith('.bin'),
      ),
    );
    check(
      (await readdir(join(directory, 'b'))).every((file) =>
        file.endsWith('.bin'),
      ),
    );
    check(a.profile.pin.authorityPublicKey !== a.profile.signingPublicKey);
    check(b.profile.checkpoint?.version === '2');
    await reloaded.receive(
      await send(reloaded, sessionB.accessToken, 'GET', base + '/registry'),
    );
    const revoke = await a.grant(request, request.fingerprint, 'revoked');
    a.acceptRegistry(
      await send(a, sessionA.accessToken, 'POST', base + '/grants', revoke),
    );
    let blocked = false;
    try {
      await send(b, sessionB.accessToken, 'GET', base + '/registry');
    } catch (error) {
      blocked = error instanceof Error && error.message === 'device_revoked';
    }
    check(blocked);
    const report = {
      status: 'PASS',
      checks,
      runtime: {
        electron: process.versions.electron,
        node: process.versions.node,
        secretBackend: safeStorage.getSelectedStorageBackend(),
      },
      oidc: {
        sessions: 2,
        flow: 'authorization_code',
        pkce: 'S256',
        driver: 'synthetic HTTP login form (not system-browser UI)',
      },
      devices:
        'two isolated Electron main profiles; second uses the Android public OIDC client, not Android runtime',
      financialSyncEnabled: false,
      registryVersion: a.profile.checkpoint?.version,
      authorityDeliveredToPeer: false,
      secrets:
        'existing DesktopSecretStore only; wrappers reopened; no seeds/tokens/DEKs in report',
      server: environment.serverId,
    };
    await writeFile(
      resolve(process.argv[2] ?? '/tmp/lion-sync-dev-smoke-results.json'),
      JSON.stringify(report, null, 2) + '\n',
    );
    console.log(
      'PASS',
      checks,
      'checks; real cofre:',
      safeStorage.getSelectedStorageBackend(),
    );
  })
  .then(async () => {
    await rm(directory, { recursive: true, force: true });
    app.quit();
  })
  .catch(async (error) => {
    console.error(error instanceof Error ? error.message : 'Smoke failed');
    await rm(directory, { recursive: true, force: true });
    app.exit(1);
  });
