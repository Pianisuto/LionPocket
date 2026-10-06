import { beforeAll, describe, expect, it } from 'vitest';
import sodium from 'libsodium-wrappers-sumo';
import {
  canonicalStringify,
  decodeCanonical,
  decodeCommit,
  decodeUtf8,
  deviceGrantSigningInput,
  httpProofSigningInput,
  keyDeliverySigningInput,
  nextRegistryVersion,
  pairingSigningInput,
  validateGrantChain,
  verifyHttpProof,
  verifyPairing,
} from '@lionpocket/sync-protocol';
import { DeviceProvisioning, ProvisioningCrypto } from '@lionpocket/sync-local';
import { founder, TestSecrets } from './testSupport';
let crypto: ProvisioningCrypto;
beforeAll(async () => {
  await sodium.ready;
  crypto = new ProvisioningCrypto(sodium);
});
const bytes = (text: string) => new TextEncoder().encode(text);
describe('bounded canonical decoder', () => {
  it('preserves Unicode and distinguishes zero/NULL', () => {
    const value = { '😀': 'é', n: null, z: 0 };
    expect(decodeCanonical(bytes(canonicalStringify(value)))).toEqual(value);
  });
  it.each([
    '{"a":0,"a":1}',
    '{"a":0,"\\u0061":1}',
    '{"b":1,"a":0}',
    '{ "a":1}',
    '{"a":-0}',
    '{"a":1.0}',
    '{"a":9007199254740992}',
    '{"a":"\\ud800"}',
    '[1,]',
    'true false',
    '\ufeff{}',
  ])('rejects hostile or noncanonical input %s', (text) => {
    expect(() => decodeCanonical(bytes(text))).toThrow();
  });
  it.each(
    [
      [0xc0, 0xaf],
      [0xed, 0xa0, 0x80],
      [0xf4, 0x90, 0x80, 0x80],
      [0xe2, 0x82],
      [0x80],
    ].map((value) => ({ value })),
  )('rejects invalid UTF-8 $value', ({ value }) => {
    expect(() => decodeUtf8(new Uint8Array(value))).toThrow();
  });
  it('limits bytes, nesting and nodes before materialization', () => {
    expect(() => decodeCanonical(bytes('[]'), 1)).toThrow('payload_too_large');
    expect(() =>
      decodeCanonical(bytes('['.repeat(33) + '0' + ']'.repeat(33))),
    ).toThrow();
    expect(() => decodeCanonical(bytes('[1,2,3]'), 100, 3)).toThrow();
  });
  it('applies commit operation and parent quotas', async () => {
    const id = crypto.uuid();
    const op = {
      opId: id,
      objectId: crypto.uuid(),
      parents: [],
      nonce: crypto.encode(sodium.randombytes_buf(24)),
      ciphertext: crypto.encode(sodium.randombytes_buf(16)),
    };
    const commit = {
      protocolVersion: 1,
      serverId: crypto.uuid(),
      serverEpoch: crypto.uuid(),
      vaultId: crypto.uuid(),
      deviceId: crypto.uuid(),
      deviceSeq: '1',
      commitId: crypto.uuid(),
      keyVersion: 1,
      deviceRegistryVersion: '1',
      cryptoSuite: 'lp-sodium-v1',
      operations: [op],
      signature: crypto.encode(sodium.randombytes_buf(64)),
    };
    expect(decodeCommit(bytes(canonicalStringify(commit)))).toEqual(commit);
    expect(() =>
      decodeCommit(
        bytes(
          canonicalStringify({
            ...commit,
            operations: Array.from({ length: 101 }, () => ({
              ...op,
              opId: crypto.uuid(),
            })),
          }),
        ),
      ),
    ).toThrow('payload_too_large');
    const parents = Array.from({ length: 33 }, () => crypto.uuid()).sort();
    expect(() =>
      decodeCommit(
        bytes(
          canonicalStringify({ ...commit, operations: [{ ...op, parents }] }),
        ),
      ),
    ).toThrow('payload_too_large');
  });
});
describe('provisioning trust', () => {
  it('pairs with independent keys and delivers only the DEK', async () => {
    const { client: a } = await founder(crypto),
      store = new TestSecrets();
    const b = await DeviceProvisioning.prepare(a.profile.pin, store, crypto);
    const request = await b.request(),
      grant = await a.grant(request);
    const response = {
      pin: a.profile.pin,
      grants: [...a.profile.grants, grant],
      delivery: null,
    };
    a.acceptRegistry(response);
    await b.receive({
      ...response,
      delivery: await a.delivery(b.profile.deviceId),
    });
    expect(await store.load(b.scope('authoritySeed'))).toBeNull();
    expect(await store.load(b.scope('dataKey'))).toEqual(
      await a.secrets.load(a.scope('dataKey')),
    );
    expect(b.profile.checkpoint?.version).toBe('2');
  });
  it('verifies the signed request fingerprint and proof of possession', async () => {
    const { client: a } = await founder(crypto),
      b = await DeviceProvisioning.prepare(
        a.profile.pin,
        new TestSecrets(),
        crypto,
      ),
      request = await b.request();
    await expect(a.grant({...request,fingerprint:crypto.nonce()})).rejects.toThrow(
      'invalid_signature',
    );
    expect(() =>
      verifyPairing({ ...request, boxPublicKey: crypto.nonce() }, crypto),
    ).toThrow('invalid_signature');
    expect(() =>
      verifyPairing(
        { ...request, signature: crypto.encode(sodium.randombytes_buf(64)) },
        crypto,
      ),
    ).toThrow('invalid_signature');
  });
  it('rejects scope, authority substitution, chain order, forks and rollback', async () => {
    const { client: a } = await founder(crypto),
      b = await DeviceProvisioning.prepare(
        a.profile.pin,
        new TestSecrets(),
        crypto,
      ),
      request = await b.request();
    const grant = await a.grant(request),
      chain = [...a.profile.grants, grant];
    const result = validateGrantChain(chain, a.profile.pin, crypto);
    expect(() =>
      validateGrantChain([grant, chain[0]], a.profile.pin, crypto),
    ).toThrow('registry_order');
    expect(() =>
      validateGrantChain(
        chain,
        { ...a.profile.pin, vaultId: crypto.uuid() },
        crypto,
      ),
    ).toThrow('scope_mismatch');
    expect(() =>
      validateGrantChain(
        chain,
        { ...a.profile.pin, authorityPublicKey: crypto.nonce() },
        crypto,
      ),
    ).toThrow('invalid_signature');
    expect(() =>
      validateGrantChain([chain[0]], a.profile.pin, crypto, result.checkpoint),
    ).toThrow('registry_rollback');
    expect(() =>
      validateGrantChain(chain, a.profile.pin, crypto, {
        ...result.checkpoint,
        sha256: crypto.nonce(),
      }),
    ).toThrow('registry_fork');
    expect(() =>
      validateGrantChain(
        [chain[0], { ...grant, previousRegistrySha256: crypto.nonce() }],
        a.profile.pin,
        crypto,
      ),
    ).toThrow('registry_order');
  });
  it('refuses device-signing key as authority and validates key/status transitions', async () => {
    const { client: a } = await founder(crypto),
      b = await DeviceProvisioning.prepare(
        a.profile.pin,
        new TestSecrets(),
        crypto,
      ),
      request = await b.request();
    const grant = await a.grant(request);
    const { signature: unused, ...unsigned } = grant;
    void unused;
    const seed = await a.secrets.load(a.scope('signingSeed'));
    expect(() =>
      validateGrantChain(
        [
          ...a.profile.grants,
          {
            ...unsigned,
            signature: crypto.sign(
              deviceGrantSigningInput(unsigned),
              seed as Uint8Array,
            ),
          },
        ],
        a.profile.pin,
        crypto,
      ),
    ).toThrow('invalid_signature');
    a.acceptRegistry({
      pin: a.profile.pin,
      grants: [...a.profile.grants, grant],
      delivery: null,
    });
    const revoked = await a.grant(request, 'revoked');
    const response = {
      pin: a.profile.pin,
      grants: [...a.profile.grants, revoked],
      delivery: null,
    };
    a.acceptRegistry(response);
    expect(() => b.acceptRegistry(response)).toThrow('device_revoked');
    await expect(a.delivery(b.profile.deviceId)).rejects.toThrow(
      'device_revoked',
    );
    await expect(a.grant(request)).rejects.toThrow(
      'invalid_device_transition',
    );
    await expect(b.grant(request)).rejects.toThrow(
      'founder_required',
    );
  });
  it('fails closed if the cofre disappears or a local signing seed changes', async () => {
    const unavailable = new TestSecrets();
    unavailable.unavailable = true;
    const { client: a } = await founder(crypto);
    await expect(
      DeviceProvisioning.prepare(a.profile.pin, unavailable, crypto),
    ).rejects.toThrow('cofre_unavailable');
    const store = new TestSecrets(),
      b = await DeviceProvisioning.prepare(a.profile.pin, store, crypto);
    await store.remove(b.scope('signingSeed'));
    await expect(b.request()).rejects.toThrow('secret_unavailable');
    await store.store(b.scope('signingSeed'), sodium.randombytes_buf(32));
    await expect(b.request()).rejects.toThrow('key_mismatch');
  });
  it('rejects tampered, wrong-key, wrong-vault and incompatible-key delivery without publishing trust', async () => {
    const { client: a } = await founder(crypto),
      store = new TestSecrets(),
      b = await DeviceProvisioning.prepare(a.profile.pin, store, crypto),
      request = await b.request();
    const grant = await a.grant(request),
      response = {
        pin: a.profile.pin,
        grants: [...a.profile.grants, grant],
        delivery: null,
      };
    a.acceptRegistry(response);
    const delivery = await a.delivery(b.profile.deviceId);
    await expect(
      b.receive({
        ...response,
        pin: { ...response.pin, authorityPublicKey: crypto.nonce() },
        delivery,
      }),
    ).rejects.toThrow('trust_pin_mismatch');
    await expect(
      b.receive({
        ...response,
        delivery: { ...delivery, vaultId: crypto.uuid() },
      }),
    ).rejects.toThrow('scope_mismatch');
    await expect(
      b.receive({ ...response, delivery: { ...delivery, keyVersion: 2 } }),
    ).rejects.toThrow('key_version_mismatch');
    await expect(
      b.receive({
        ...response,
        delivery: {
          ...delivery,
          sealedBox: delivery.sealedBox.slice(0, -2) + 'AA',
        },
      }),
    ).rejects.toThrow('invalid_signature');
    const bundle = {
      formatVersion: 1,
      serverId: delivery.serverId,
      serverEpoch: delivery.serverEpoch,
      vaultId: crypto.uuid(),
      recipientDeviceId: b.profile.deviceId,
      registryVersion: '2',
      keyVersion: 1,
      vaultKey: crypto.nonce(),
    };
    const { signature: unused, ...unsigned } = delivery;
    void unused;
    unsigned.sealedBox = crypto.encode(
      sodium.crypto_box_seal(
        bytes(canonicalStringify(bundle)),
        crypto.decode(b.profile.boxPublicKey),
      ),
    );
    const seed = await a.secrets.load(a.scope('signingSeed'));
    await expect(
      b.receive({
        ...response,
        delivery: {
          ...unsigned,
          signature: crypto.sign(
            keyDeliverySigningInput(unsigned),
            seed as Uint8Array,
          ),
        },
      }),
    ).rejects.toThrow('scope_mismatch');
    await store.store(b.scope('dataKey'), sodium.randombytes_buf(32));
    await expect(b.receive({ ...response, delivery })).rejects.toThrow(
      'key_mismatch',
    );
    await store.remove(b.scope('dataKey'));
    store.unavailable = true;
    await expect(b.receive({ ...response, delivery })).rejects.toThrow(
      'cofre_unavailable',
    );
    expect(b.profile.grants).toEqual([]);
  });
  it('uses exact decimal int64 versions', () => {
    expect(nextRegistryVersion('9007199254740992')).toBe('9007199254740993');
    expect(() => nextRegistryVersion('9223372036854775807')).toThrow();
  });
  it('limits active devices, even with valid authority signatures', async () => {
    const { client: a } = await founder(crypto);
    for (let i = 0; i < 9; i++) {
      const b = await DeviceProvisioning.prepare(
          a.profile.pin,
          new TestSecrets(),
          crypto,
        ),
        r = await b.request(),
        grant = await a.grant(r);
      a.acceptRegistry({
        pin: a.profile.pin,
        grants: [...a.profile.grants, grant],
        delivery: null,
      });
    }
    const b = await DeviceProvisioning.prepare(
        a.profile.pin,
        new TestSecrets(),
        crypto,
      ),
      r = await b.request();
    await expect(a.grant(r)).rejects.toThrow('device_limit');
  });
});
describe('HTTP request signature', () => {
  it('binds method, target, origin, token, bytes, epoch and freshness', async () => {
    const { client } = await founder(crypto),
      target = `/v2/devices/vaults/${client.profile.pin.vaultId}/registry`;
    const proof = await client.proof(
      'POST',
      target,
      'http://127.0.0.1:8787',
      '',
      'synthetic-token',
    );
    const expected = {
      scope: client.profile.pin,
      method: 'POST',
      target,
      origin: proof.origin,
      body: '',
      token: 'synthetic-token',
      now: Date.now(),
      publicKey: client.profile.signingPublicKey,
    };
    expect(() => verifyHttpProof(proof, expected, crypto)).not.toThrow();
    for (const change of [
      { method: 'GET' },
      { target: target + '/other' },
      { origin: 'http://other' },
      { token: 'different' },
      { body: '{}' },
      { now: proof.issuedAt + 60001 },
      { publicKey: crypto.nonce() },
      { scope: { ...client.profile.pin, serverEpoch: crypto.uuid() } },
    ])
      expect(() =>
        verifyHttpProof(proof, { ...expected, ...change }, crypto),
      ).toThrow();
    const { signature, ...unsigned } = proof;
    expect(httpProofSigningInput(unsigned)).not.toContain(signature);
    expect(() =>
      pairingSigningInput({ ...unsigned, signature } as never),
    ).toThrow();
  });
});
