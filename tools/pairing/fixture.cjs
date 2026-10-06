const sodium = require('libsodium-wrappers-sumo');
const { DeviceProvisioning, ProvisioningCrypto, secretContext } = require('@lionpocket/sync-local');
const { inviteSigningInput, pairingLink } = require('@lionpocket/sync-protocol');
async function fixture(expiresAt = Date.now() + 900000) {
  await sodium.ready;
  const crypto = new ProvisioningCrypto(sodium), values = new Map();
  const secrets = { load: async scope => values.get(secretContext(scope))?.slice() || null,
    store: async (scope, value) => { values.set(secretContext(scope), value.slice()); }, remove: async scope => { values.delete(secretContext(scope)); } };
  const d = await DeviceProvisioning.prepare({ serverId: crypto.uuid(), serverEpoch: crypto.uuid(), vaultId: crypto.uuid(), founderDeviceId: crypto.uuid(), authorityPublicKey: crypto.nonce(), keyVersion: 1 }, secrets, crypto, true);
  const seed = sodium.randombytes_buf(32), keys = sodium.crypto_sign_seed_keypair(seed), authority = await secrets.load(d.scope('authoritySeed'));
  const capability = crypto.encode(seed);
  const invite = { version: 2, purpose: 'device-pairing', id: crypto.uuid(), endpoint: 'https://sync.pairing-fixture.invalid', pin: d.profile.pin, expiresAt, capabilityHash: crypto.hash(capability), capabilityPublicKey: crypto.encode(keys.publicKey) };
  const link = pairingLink({ invite: { ...invite, signature: crypto.sign(inviteSigningInput(invite), authority) }, capability }, crypto);
  crypto.erase(seed); crypto.erase(keys.privateKey); crypto.erase(authority);
  return { link, capability };
}
module.exports = { fixture };
