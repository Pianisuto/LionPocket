import { beforeAll, describe, expect, it } from 'vitest';
import sodium from 'libsodium-wrappers-sumo';
import {
  acceptKeyCheckpoints,
  DeviceProvisioning,
  makeKeyCheckpoint,
  makeRecovery,
  openRecovery,
  ProvisioningCrypto,
  validateKeyCheckpoints,
} from '@lionpocket/sync-local';
import { founder, TestSecrets } from '../../../../sync-server/src/testSupport';
beforeAll(() => sodium.ready);
describe('beta recovery and key lifecycle', () => {
  it('confirms an independent recovery code and rejects wrong codes, scope, cipher and signature tampering', async () => {
    const { client } = await founder(new ProvisioningCrypto(sodium)),
      r = await makeRecovery(client, sodium, '1');
    expect(r.code).toMatch(/^LP1\.[A-Za-z0-9_-]{43}$/);
    const bundle = openRecovery(client, sodium, r.recovery, r.code);
    expect(bundle.authorityPublicKey).toBe(
      client.profile.pin.authorityPublicKey,
    );
    expect(bundle.dataKeys).toHaveLength(1);
    expect(() =>
      openRecovery(client, sodium, r.recovery, 'LP1.' + client.crypto.nonce()),
    ).toThrow();
    expect(() =>
      openRecovery(
        client,
        sodium,
        {
          ...r.recovery,
          envelope: { ...r.recovery.envelope, vaultId: client.crypto.uuid() },
        },
        r.code,
      ),
    ).toThrow('scope_mismatch');
    expect(() =>
      openRecovery(
        client,
        sodium,
        { ...r.recovery, signature: client.crypto.encode(new Uint8Array(64)) },
        r.code,
      ),
    ).toThrow('invalid_recovery_envelope');
  });
  it('delivers old and fresh DEKs only to active devices and detects checkpoint rollback', async () => {
    const { client: a } = await founder(new ProvisioningCrypto(sodium)),
      b = await DeviceProvisioning.prepare(
        a.profile.pin,
        new TestSecrets(),
        a.crypto,
      ),
      request = await b.request(),
      grant = await a.grant(request);
    a.acceptRegistry({
      pin: a.profile.pin,
      grants: [...a.profile.grants, grant],
      delivery: null,
    });
    await b.receive({
      pin: a.profile.pin,
      grants: a.profile.grants,
      delivery: await a.delivery(b.profile.deviceId),
    });
    const entry = await makeKeyCheckpoint(a),
      response = {
        pin: a.profile.pin,
        grants: a.profile.grants,
        delivery: null,
        keyCheckpoints: [entry],
      };
    await acceptKeyCheckpoints(a, response);
    await acceptKeyCheckpoints(b, response);
    expect(a.profile.activeKeyVersion).toBe(2);
    expect(await a.secrets.load(a.scope('dataKey', 2))).toEqual(
      await b.secrets.load(b.scope('dataKey', 2)),
    );
    expect(await a.secrets.load(a.scope('dataKey', 1))).not.toEqual(
      await a.secrets.load(a.scope('dataKey', 2)),
    );
    await expect(
      acceptKeyCheckpoints(b, { ...response, keyCheckpoints: [] }),
    ).rejects.toThrow('key_checkpoint_rollback');
    expect(() =>
      validateKeyCheckpoints(
        [{ ...entry, deliveries: entry.deliveries.slice(1) }],
        a.profile.pin,
        a.profile.grants,
        a,
      ),
    ).toThrow('invalid_key_recipients');
    const revoke = await a.grant(request, 'revoked');
    a.acceptRegistry({
      pin: a.profile.pin,
      grants: [...a.profile.grants, revoke],
      delivery: null,
    });
    const next = await makeKeyCheckpoint(a);
    expect(next.deliveries.map((d) => d.deviceId)).toEqual([
      a.profile.deviceId,
    ]);
    await acceptKeyCheckpoints(a, {
      pin: a.profile.pin,
      grants: a.profile.grants,
      delivery: null,
      keyCheckpoints: [entry, next],
    });
    await expect(
      acceptKeyCheckpoints(b, {
        pin: a.profile.pin,
        grants: a.profile.grants,
        delivery: null,
        keyCheckpoints: [entry, next],
      }),
    ).rejects.toThrow('device_revoked');
    const recovered = await makeRecovery(a, sodium, '2');
    expect(
      openRecovery(a, sodium, recovered.recovery, recovered.code).dataKeys,
    ).toHaveLength(3);
  });
});
