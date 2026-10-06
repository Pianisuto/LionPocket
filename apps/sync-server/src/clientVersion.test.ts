import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import pg from 'pg';
import sodium from 'libsodium-wrappers-sumo';
import { ProvisioningCrypto } from '@lionpocket/sync-local';
import { controlServer } from './server';

// Runs without PostgreSQL: incompatible requests must never reach it, consume
// a proof, or mutate anything.
describe('control v2 client floor', () => {
  const pool = new pg.Pool();
  const query = vi.spyOn(pool, 'query').mockImplementation(() => {
    throw new Error('unexpected_database_access');
  });
  const identity = vi.fn(async () => ({
    issuer: 'https://identity.invalid',
    subject: 'fixture',
  }));
  const vault = randomUUID();
  let server: ReturnType<typeof controlServer>, endpoint: string;
  beforeAll(async () => {
    await sodium.ready;
    server = controlServer({
      pool,
      crypto: new ProvisioningCrypto(sodium),
      environment: { serverId: randomUUID(), serverEpoch: randomUUID() },
      origin: 'https://fixture.invalid',
      identity,
      financialEnabled: true,
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await pool.end();
  });
  it('advertises the floor without changing financial envelope/domain versions', async () => {
    const env = await (await fetch(endpoint + '/v1/environment')).json();
    expect(env).toMatchObject({
      controlVersion: 2,
      protocolVersion: 1,
      domainSchema: 1,
    });
  });
  it.each([undefined, '1', '3', '2, 1'])(
    'rejects incompatible requests before authentication, replay consumption and database access: %s',
    async (version) => {
      for (const [method, path] of [
        ['POST', '/v1/vaults'],
        ...[
          'commits',
          'changes',
          'registry',
          'grants',
          'recover',
          'recovery-store',
          'key-checkpoints',
          'epoch-recovery-authorize',
          'epoch-staging-batch',
          'epoch-activation',
        ].map((action) => ['POST', `${action==='recover' || action.startsWith('epoch-') ? '/v1/vaults' : '/v2/devices/vaults'}/${vault}/${action}`]),
      ]) {
        const res = await fetch(endpoint + path, {
          method,
          headers: {
            authorization: 'Bearer untrusted-session',
            'x-lionpocket-proof': 'previously-prepared-proof',
            ...(version === undefined
              ? {}
              : { 'x-lionpocket-control-version': version }),
          },
        });
        expect(res.status).toBe(426);
        expect(await res.json()).toEqual({
          error: 'client_upgrade_required',
          controlVersion: 2,
        });
      }
      expect(identity).not.toHaveBeenCalled();
      expect(query).not.toHaveBeenCalled();
    },
  );
  it('still requires authorization when the compatibility header is present', async () => {
    const res = await fetch(endpoint + '/v1/vaults', {
      method: 'POST',
      headers: { 'x-lionpocket-control-version': '2' },
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'unauthenticated' });
    expect(query).not.toHaveBeenCalled();
  });
});
