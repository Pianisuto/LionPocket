// Public fixture seeds only. This generator is never imported by an app or development client.
const { readFileSync, writeFileSync } = require('node:fs');
const {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
  verify,
} = require('node:crypto');
const p = require('../../packages/sync-protocol/dist');
const v = JSON.parse(
  readFileSync('packages/sync-protocol/fixtures/crypto.json'),
);
const seed = Buffer.from(v.signSeedHex, 'hex');
const sk = createPrivateKey({
  key: Buffer.concat([
    Buffer.from('302e020100300506032b657004220420', 'hex'),
    seed,
  ]),
  type: 'pkcs8',
  format: 'der',
});
const pk = createPublicKey(sk);
const hash = (text) => createHash('sha256').update(text).digest('base64url');
const signature = (text) =>
  sign(null, Buffer.from(text), sk).toString('base64url');
const fields = {
  formatVersion: 1,
  serverId: v.envelope.serverId,
  serverEpoch: v.envelope.serverEpoch,
  vaultId: v.envelope.vaultId,
  deviceId: v.envelope.deviceId,
  signingPublicKey: Buffer.from(v.signPublicKeyHex, 'hex').toString(
    'base64url',
  ),
  boxPublicKey: Buffer.from(v.boxPublicKeyHex, 'hex').toString('base64url'),
  nonce: Buffer.from(Array.from({ length: 32 }, (_, i) => i)).toString(
    'base64url',
  ),
};
const fingerprintCanonical = p.pairingFingerprintInput(fields);
const unsignedRequest = { ...fields, fingerprint: hash(fingerprintCanonical) };
const pairingCanonical = p.pairingSigningInput(unsignedRequest),
  request = { ...unsignedRequest, signature: signature(pairingCanonical) };
const unsignedProof = {
  formatVersion: 1,
  serverId: fields.serverId,
  serverEpoch: fields.serverEpoch,
  vaultId: fields.vaultId,
  deviceId: fields.deviceId,
  method: 'POST',
  target: `/v1/vaults/${fields.vaultId}/pairings`,
  origin: 'http://127.0.0.1:8787',
  issuedAt: 1790769600000,
  nonce: fields.nonce,
  bodySha256: hash(p.canonicalStringify(request)),
  accessTokenSha256: hash('PUBLIC-SYNTHETIC-TOKEN-NOT-A-JWT'),
};
const proofCanonical = p.httpProofSigningInput(unsignedProof),
  proof = { ...unsignedProof, signature: signature(proofCanonical) };
for (const [text, sig] of [
  [pairingCanonical, request.signature],
  [proofCanonical, proof.signature],
])
  if (!verify(null, Buffer.from(text), pk, Buffer.from(sig, 'base64url')))
    throw Error('OpenSSL verification failed');
writeFileSync(
  'packages/sync-protocol/fixtures/provisioning.json',
  JSON.stringify(
    {
      warning:
        'PUBLIC FIXTURE SEED/NONCE/TOKEN ONLY; NEVER USE IN AN APPLICATION',
      signSeedHex: v.signSeedHex,
      reference: 'Node crypto/OpenSSL Ed25519 + SHA-256',
      fingerprintCanonical,
      pairingCanonical,
      proofCanonical,
      request,
      proof,
    },
    null,
    2,
  ) + '\n',
);
// Separate, public RSA fixture for the native identity verifier. Not a Keycloak signing key.
const { generateKeyPairSync } = require('node:crypto');
const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = rsa.publicKey.export({ format: 'jwk' });
jwk.kid = 'synthetic-native-verifier';
jwk.use = 'sig';
jwk.alg = 'RS256';
const jwt = (claims) => {
  const input =
    Buffer.from(JSON.stringify({ alg: 'RS256', kid: jwk.kid })).toString(
      'base64url',
    ) +
    '.' +
    Buffer.from(JSON.stringify(claims)).toString('base64url');
  return (
    input +
    '.' +
    sign('RSA-SHA256', Buffer.from(input), rsa.privateKey).toString('base64url')
  );
};
const claims = {
  iss: 'http://127.0.0.1:18080/realms/lionpocket-dev',
  sub: 'PUBLIC-SYNTHETIC-SUBJECT',
  iat: 1700000000,
  exp: 4102444800,
  nonce: 'PUBLIC-NATIVE-NONCE',
  azp: 'lionpocket-android-dev',
};
const identity = {
  warning:
    'PUBLIC SYNTHETIC JWTs; KEYCLOAK NEVER TRUSTS THIS KEY; NO PRIVATE KEY STORED',
  jwks: { keys: [jwk] },
  issuer: claims.iss,
  clientId: claims.azp,
  nonce: claims.nonce,
  idToken: jwt({ ...claims, aud: claims.azp }),
  accessToken: jwt({ ...claims, aud: 'lionpocket-sync-api', typ: 'Bearer' }),
  expiredToken: jwt({
    ...claims,
    aud: 'lionpocket-sync-api',
    typ: 'Bearer',
    exp: 1,
  }),
  wrongTypeToken: jwt({ ...claims, aud: 'lionpocket-sync-api', typ: 'ID' }),
};
writeFileSync(
  'packages/sync-protocol/fixtures/oidc-public.json',
  JSON.stringify(identity, null, 2) + '\n',
);
