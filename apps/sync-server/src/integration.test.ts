import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import pg from 'pg';
import sodium from 'libsodium-wrappers-sumo';
import { canonicalStringify, type HttpProof } from '@lionpocket/sync-protocol';
import {
  DeviceProvisioning,
  ProvisioningCrypto,
  type RegistryResponse,
} from '@lionpocket/sync-local';
import { loginDevelopmentOidc } from '../../desktop/src/main/sync/oidc';
import { controlServer, initialize } from './server';
import { controlSchema } from './schema';
import { keycloakIdentity } from './identity';
import { founder, syntheticBrowserLogin, TestSecrets } from './testSupport';

const enabled = process.env.LIONPOCKET_SYNC_INTEGRATION === '1';
describe.skipIf(!enabled)(
  'real PostgreSQL + Keycloak authorization_code/PKCE (synthetic realm)',
  () => {
    let pool: pg.Pool,
      admin: pg.Pool,
      server: Server,
      crypto: ProvisioningCrypto;
    let a: DeviceProvisioning,
      b: DeviceProvisioning,
      request: Awaited<ReturnType<DeviceProvisioning['request']>>;
    let initial: Awaited<ReturnType<typeof founder>>;
    let tokenA: string, tokenB: string, tokenOther: string;
    const origin = 'http://127.0.0.1:18770',
      database = 'lion_sync_test_' + randomUUID().replaceAll('-', '');
    const issuer = 'http://127.0.0.1:18080/realms/lionpocket-dev';
    let environment: Awaited<ReturnType<typeof initialize>>;
    const headers = (token: string, proof: HttpProof) => ({
      connection: 'close',
      'x-lionpocket-control-version': '2',
      authorization: 'Bearer ' + token,
      'content-type': 'application/json',
      'x-lionpocket-proof': Buffer.from(canonicalStringify(proof)).toString(
        'base64url',
      ),
    });
    const path = (action: string) =>
      `/v1/vaults/${a.profile.pin.vaultId}/${action}`;
    async function send(
      client: DeviceProvisioning,
      token: string,
      method: string,
      target: string,
      value?: unknown,
      customProof?: HttpProof,
    ) {
      const body = value === undefined ? '' : canonicalStringify(value),
        proof =
          customProof ??
          (await client.proof(method, target, origin, body, token));
      const response = await fetch(origin + target, {
        method,
        headers: headers(token, proof),
        body: body || undefined,
      });
      return {
        status: response.status,
        body: (await response.json()) as RegistryResponse & { error?: string },
      };
    }
    async function start() {
      server = controlServer({
        pool,
        crypto,
        environment,
        origin,
        identity: keycloakIdentity(issuer),
        financialScope: 'manual',
      });
      await new Promise<void>((resolve) =>
        server.listen(18770, '127.0.0.1', resolve),
      );
    }
    beforeAll(async () => {
      await sodium.ready;
      crypto = new ProvisioningCrypto(sodium);
      admin = new pg.Pool({
        connectionString:
          'postgresql://liondev:liondev@127.0.0.1:55432/postgres',
      });
      await admin.query(`CREATE DATABASE ${database}`);
      pool = new pg.Pool({
        connectionString: `postgresql://liondev:liondev@127.0.0.1:55432/${database}`,
      });
      await pool.query(controlSchema);
      environment = await initialize(pool);
      await start();
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
      const sessionOther = await loginDevelopmentOidc(
        'lionpocket-desktop-dev',
        (url) => syntheticBrowserLogin(url, 'mallory'),
        20000,
      );
      expect(sessionA.subject).toBe(sessionB.subject);
      expect(sessionA.subject).not.toBe(sessionOther.subject);
      tokenA = sessionA.accessToken;
      tokenB = sessionB.accessToken;
      tokenOther = sessionOther.accessToken;
      initial = await founder(crypto, environment);
      a = initial.client;
      b = await DeviceProvisioning.prepare(
        a.profile.pin,
        new TestSecrets(),
        crypto,
      );
      request = await b.request();
    }, 60000);
    afterAll(async () => {
      if (server) {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
      await pool?.end();
      if (admin) {
        await admin.query(`DROP DATABASE IF EXISTS ${database}`);
        await admin.end();
      }
    });
    it('rejects missing, forged, ID, expired, wrong-audience and wrong-issuer tokens', async () => {
      const target = '/v1/vaults',
        value = {
          pin: a.profile.pin,
          grant: initial.grant,
          request: initial.request,
        };
      for (const token of ['', 'forged', tokenA.slice(0, -10) + 'AAAAAAAAAA'])
        expect((await send(a, token, 'POST', target, value)).status).toBe(401);
      const { SignJWT, exportJWK, generateKeyPair } = await import('jose');
      const pair = await generateKeyPair('RS256'),
        key = await exportJWK(pair.publicKey);
      // Claim checks are tested separately with a real signature/JWKS, not merely a corrupted signature.
      const { createLocalJWKSet, jwtVerify } = await import('jose');
      const keys = createLocalJWKSet({ keys: [{ ...key, kid: 'test' }] });
      for (const payload of [
        { iss: issuer, aud: 'wrong', exp: Math.floor(Date.now() / 1000) + 100 },
        {
          iss: 'http://wrong',
          aud: 'lionpocket-sync-api',
          exp: Math.floor(Date.now() / 1000) + 100,
        },
        { iss: issuer, aud: 'lionpocket-sync-api', exp: 1 },
      ]) {
        const token = await new SignJWT({ sub: 'synthetic', ...payload })
          .setProtectedHeader({ alg: 'RS256', kid: 'test' })
          .sign(pair.privateKey);
        await expect(
          jwtVerify(token, keys, { issuer, audience: 'lionpocket-sync-api' }),
        ).rejects.toThrow();
      }
    });
    it('creates the founder vault and persists its signed root grant', async () => {
      const result = await send(a, tokenA, 'POST', '/v1/vaults', {
        pin: a.profile.pin,
        grant: initial.grant,
        request: initial.request,
      });
      expect(result.status).toBe(201);
      a.acceptRegistry(result.body);
      expect(
        (await pool.query('SELECT registry_version::text FROM sync_vaults'))
          .rows[0].registry_version,
      ).toBe('1');
    });
    it('denies another issuer/subject, even with the correct device proof', async () => {
      const result = await send(a, tokenOther, 'GET', path('registry'));
      expect(result.status).toBe(403);
      expect(result.body.error).toBe('forbidden');
    });
    it('rejects body mutation, wrong signature and stale proof', async () => {
      const proof = await b.proof(
        'POST',
        path('pairings'),
        origin,
        canonicalStringify(request),
        tokenB,
      );
      expect(
        (
          await send(
            b,
            tokenB,
            'POST',
            path('pairings'),
            { ...request, nonce: crypto.nonce() },
            proof,
          )
        ).status,
      ).toBe(403);
      expect(
        (
          await send(b, tokenB, 'POST', path('pairings'), request, {
            ...proof,
            signature: crypto.encode(sodium.randombytes_buf(64)),
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await send(b, tokenB, 'POST', path('pairings'), request, {
            ...proof,
            issuedAt: proof.issuedAt - 120000,
          })
        ).status,
      ).toBe(403);
      expect(
        (await pool.query('SELECT count(*)::int AS n FROM sync_pairings'))
          .rows[0].n,
      ).toBe(0);
    });
    it('persists the new signed pairing request without granting access', async () => {
      expect(
        (await send(b, tokenB, 'POST', path('pairings'), request)).status,
      ).toBe(200);
      expect((await send(b, tokenB, 'GET', path('registry'))).status).toBe(403);
    });
    it('rejects out-of-order grant and invalid authority signature without changing the registry', async () => {
      const grant = await a.grant(request, request.fingerprint);
      expect(
        (
          await send(a, tokenA, 'POST', path('grants'), {
            ...grant,
            registryVersion: '3',
          })
        ).body.error,
      ).toBe('registry_order');
      expect(
        (
          await send(a, tokenA, 'POST', path('grants'), {
            ...grant,
            signature: crypto.encode(sodium.randombytes_buf(64)),
          })
        ).body.error,
      ).toBe('invalid_signature');
      expect(
        (await pool.query('SELECT count(*)::int AS n FROM sync_grants')).rows[0]
          .n,
      ).toBe(1);
    });
    it('serializes concurrent append attempts and delivers the DEK to the approved recipient', async () => {
      const grant = await a.grant(request, request.fingerprint);
      const results = await Promise.all([
        send(a, tokenA, 'POST', path('grants'), grant),
        send(a, tokenA, 'POST', path('grants'), grant),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
      const success = results.find((r) => r.status === 200);
      if (!success) throw new Error('No successful append.');
      a.acceptRegistry(success.body);
      const delivery = await a.delivery(b.profile.deviceId);
      expect(
        (
          await send(a, tokenA, 'POST', path('deliveries'), {
            ...delivery,
            vaultId: crypto.uuid(),
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await send(a, tokenA, 'POST', path('deliveries'), {
            ...delivery,
            keyVersion: 2,
          })
        ).body.error,
      ).toBe('key_version_mismatch');
      expect(
        (await send(a, tokenA, 'POST', path('deliveries'), delivery)).status,
      ).toBe(200);
      const result = await send(b, tokenB, 'GET', path('registry'));
      expect(result.status).toBe(200);
      await b.receive(result.body);
      expect(await a.secrets.load(a.scope('dataKey'))).toEqual(
        await b.secrets.load(b.scope('dataKey')),
      );
      expect(await b.secrets.load(b.scope('authoritySeed'))).toBeNull();
    });
    it('rejects replay concurrently and after API restart', async () => {
      const proof = await b.proof('GET', path('registry'), origin, '', tokenB);
      const results = await Promise.all([
        send(b, tokenB, 'GET', path('registry'), undefined, proof),
        send(b, tokenB, 'GET', path('registry'), undefined, proof),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await start();
      expect(
        (await send(b, tokenB, 'GET', path('registry'), undefined, proof)).body
          .error,
      ).toBe('replay');
    });
    it('rejects a different vault or epoch and bounds/validates raw network bytes', async () => {
      const proof = await b.proof('GET', path('registry'), origin, '', tokenB);
      expect(
        (
          await send(b, tokenB, 'GET', path('registry'), undefined, {
            ...proof,
            vaultId: crypto.uuid(),
          })
        ).body.error,
      ).toBe('scope_mismatch');
      expect(
        (
          await send(b, tokenB, 'GET', path('registry'), undefined, {
            ...proof,
            serverEpoch: crypto.uuid(),
          })
        ).body.error,
      ).toBe('epoch_changed');
      for (const raw of ['{"a":0,"a":1}', '{ "a":0}', ' '.repeat(65537)]) {
        const response = await fetch(origin + path('grants'), {
          method: 'POST',
          headers: headers(tokenA, proof),
          body: raw,
        });
        expect(response.status).toBe(raw.length > 65536 ? 413 : 400);
      }
    });
    it('blocks a revoked device immediately and preserves grant history', async () => {
      const grant = await a.grant(request, request.fingerprint, 'revoked');
      const result = await send(a, tokenA, 'POST', path('grants'), grant);
      expect(result.status).toBe(200);
      a.acceptRegistry(result.body);
      expect((await send(b, tokenB, 'GET', path('registry'))).body.error).toBe(
        'device_revoked',
      );
      expect(
        (await send(b, tokenB, 'POST', path('pairings'), request)).body.error,
      ).toBe('device_revoked');
      expect(
        (await pool.query('SELECT count(*)::int AS n FROM sync_grants')).rows[0]
          .n,
      ).toBe(3);
    });
    it('exposes zero financial capabilities and has no financial commit endpoints or tables', async () => {
      const env = await (await fetch(origin + '/v1/environment')).json();
      expect(env.entityScopes).toEqual([]);
      expect(env.financialSyncEnabled).toBe(false);
      for (const target of ['/v1/commits', path('commits'), path('changes')])
        expect((await send(a, tokenA, 'POST', target, {})).status).toBe(404);
      const names = (
        await pool.query(
          "SELECT tablename FROM pg_tables WHERE schemaname='public'",
        )
      ).rows.map((r) => r.tablename);
      expect(names.sort()).toEqual([
        'sync_deliveries',
        'sync_disabled_accounts',
        'sync_environment',
        'sync_epoch_authorizations',
        'sync_epoch_challenges',
        'sync_grants',
        'sync_http_nonces',
        'sync_pairings',
        'sync_restore_vaults',
        'sync_restores',
        'sync_vaults',
      ]);
    });
  },
);
