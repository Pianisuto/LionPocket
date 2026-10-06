// Synthetic harness only. Uses real platform crypto/cofre through the shared client.
const p = require('@lionpocket/sync-protocol');
const {
  DeviceProvisioning,
  ProvisioningCrypto,
} = require('@lionpocket/sync-local');
async function runProvisioningChecks(sodium, makeStore, vector) {
  const crypto = new ProvisioningCrypto(sodium);
  let checks = 0;
  const check = (condition) => {
    if (!condition) throw new Error('Native provisioning check failed');
    checks++;
  };
  p.verifyPairing(vector.request, crypto);
  checks++;
  const { signature, ...proof } = vector.proof;
  check(p.httpProofSigningInput(proof) === vector.proofCanonical);
  check(
    crypto.verify(
      signature,
      vector.proofCanonical,
      vector.request.signingPublicKey,
    ),
  );
  const pin = {
    serverId: crypto.uuid(),
    serverEpoch: crypto.uuid(),
    vaultId: crypto.uuid(),
    founderDeviceId: crypto.uuid(),
    authorityPublicKey: crypto.nonce(),
    keyVersion: 1,
  };
  const a = await DeviceProvisioning.prepare(pin, makeStore(), crypto, true),
    b = await DeviceProvisioning.prepare(a.profile.pin, makeStore(), crypto);
  try {
    const root = await a.request(),
      rootGrant = await a.grant(root);
    a.acceptRegistry({
      pin: a.profile.pin,
      grants: [rootGrant],
      delivery: null,
    });
    checks++;
    const request = await b.request();
    p.verifyPairing(request, crypto);
    checks++;
    let denied = false;
    try {
      await a.grant({...request,fingerprint:crypto.nonce()});
    } catch {
      denied = true;
    }
    check(denied);
    const grant = await a.grant(request);
    const response = {
      pin: a.profile.pin,
      grants: [...a.profile.grants, grant],
      delivery: null,
    };
    a.acceptRegistry(response);
    checks++;
    const delivery = await a.delivery(b.profile.deviceId);
    await b.receive({ ...response, delivery });
    checks++;
    const reloaded = new DeviceProvisioning(
      JSON.parse(p.canonicalStringify(b.profile)),
      makeStore(),
      crypto,
    );
    const keyA = await a.secrets.load(a.scope('dataKey')),
      keyB = await reloaded.secrets.load(b.scope('dataKey'));
    check(crypto.encode(keyA) === crypto.encode(keyB));
    crypto.erase(keyA);
    crypto.erase(keyB);
    check((await reloaded.secrets.load(b.scope('authoritySeed'))) === null);
    check(a.profile.pin.authorityPublicKey !== a.profile.signingPublicKey);
    const http = await reloaded.proof(
      'POST',
      `/v2/devices/vaults/${pin.vaultId}/registry`,
      'http://127.0.0.1:8787',
      '{}',
      '',
    );
    p.verifyHttpProof(
      http,
      {
        scope: pin,
        method: 'POST',
        target: http.target,
        origin: http.origin,
        body: '{}',
        token: '',
        now: http.issuedAt,
        publicKey: b.profile.signingPublicKey,
      },
      crypto,
    );
    checks++;
    denied = false;
    try {
      p.validateGrantChain(
        [rootGrant],
        a.profile.pin,
        crypto,
        b.profile.checkpoint,
      );
    } catch {
      denied = true;
    }
    check(denied);
    const revoked = await a.grant(request, 'revoked');
    const final = {
      pin: a.profile.pin,
      grants: [...response.grants, revoked],
      delivery,
    };
    denied = false;
    try {
      await b.receive(final);
    } catch {
      denied = true;
    }
    check(denied);
    const decoder = p.decodeCanonical(
      p.encodeUtf8(p.canonicalStringify(request)),
    );
    check(decoder.signature === request.signature);
    denied = false;
    try {
      p.decodeCanonical(p.encodeUtf8('{"a":0,"a":1}'));
    } catch {
      denied = true;
    }
    check(denied);
    return {
      result: 'PASS',
      checks,
      runtime:
        'real platform sodium and secret store; synthetic offline control flow',
      oidc: 'not run by native offline harness',
      pin: a.profile.pin,
      grants: response.grants,
      delivery,
      recipient: b.profile.deviceId,
    };
  } finally {
    for (const client of [a, b])
      for (const purpose of [
        'signingSeed',
        'boxSeed',
        'authoritySeed',
        'dataKey',
      ])
        await client.secrets.remove(client.scope(purpose));
  }
}
module.exports = { runProvisioningChecks };
