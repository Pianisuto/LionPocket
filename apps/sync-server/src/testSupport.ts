import { DeviceProvisioning, ProvisioningCrypto } from '@lionpocket/sync-local';
import { assertSecretBytes, secretContext, type StoredSecretScope, type SecretStore } from '@lionpocket/sync-local';
import type { TrustPin } from '@lionpocket/sync-protocol';
/** Test-only volatile cofre double. Never selected by server, apps or development client. */
export class TestSecrets implements SecretStore {
  constructor(readonly values = new Map<string, Uint8Array>()) {}
  unavailable = false;
  async load(scope: StoredSecretScope) {
    if (this.unavailable) throw new Error('cofre_unavailable');
    return this.values.get(secretContext(scope))?.slice() ?? null;
  }
  async store(scope: StoredSecretScope, bytes: Uint8Array) {
    if (this.unavailable) throw new Error('cofre_unavailable');
    assertSecretBytes(scope, bytes);
    const context = secretContext(scope), existing = this.values.get(context);
    if (scope.purpose === 'epochPreparation' && existing &&
      (existing.length !== bytes.length || !existing.every((b, i) => b === bytes[i])))
      throw new Error('Preparation secret is immutable.');
    this.values.set(context, bytes.slice());
  }
  async remove(scope: StoredSecretScope) {
    this.values.delete(secretContext(scope));
  }
}
export async function founder(
  crypto: ProvisioningCrypto,
  environment = { serverId: crypto.uuid(), serverEpoch: crypto.uuid() },
  secrets: SecretStore = new TestSecrets(),
) {
  const pin: TrustPin = {
    ...environment,
    vaultId: crypto.uuid(),
    founderDeviceId: crypto.uuid(),
    authorityPublicKey: crypto.nonce(),
    keyVersion: 1,
  };
  const client = await DeviceProvisioning.prepare(pin, secrets, crypto, true);
  const request = await client.request(),
    grant = await client.grant(request);
  client.acceptRegistry({
    pin: client.profile.pin,
    grants: [grant],
    delivery: null,
  });
  return { client, request, grant };
}
/** Drives the real Keycloak HTML login in tests, using only the synthetic realm's public passwords.
 * This is still authorization_code/PKCE. No direct/password grant or admin token exists here. */
export async function syntheticBrowserLogin(url: string, username = 'alice') {
  const page = await fetch(url, { redirect: 'manual' });
  const html = await page.text();
  const action = /<form[^>]+action="([^"]+)"/
    .exec(html)?.[1]
    ?.replaceAll('&amp;', '&');
  if (!action) throw new Error('Synthetic Keycloak login form missing.');
  const cookies = page.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ');
  const result = await fetch(action, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      cookie: cookies,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      username,
      password: 'synthetic-only-' + username,
      credentialId: '',
    }),
  });
  const redirect = result.headers.get('location');
  if (!redirect || !redirect.startsWith('http://127.0.0.1:1876'))
    throw new Error('Synthetic Keycloak login rejected.');
  await fetch(redirect);
}
/** Current capability onboarding for low-level transport fixtures; no account login on the new device. */
export async function submitTestPairing(authority: DeviceProvisioning, device: DeviceProvisioning, endpoint: string) {
  const {canonicalStringify,inviteSigningInput,pairingCapabilityInput} = await import('@lionpocket/sync-protocol');
  const crypto = authority.crypto, capability = crypto.sodium.randombytes_buf(32);
  const seed = await authority.secrets.load(authority.scope('authoritySeed'));
  if (!seed) throw new Error('authority_secret_unavailable');
  try {
    const keys = crypto.sodium.crypto_sign_seed_keypair(capability);
    crypto.erase(keys.privateKey);
    const unsigned = {version:2 as const,purpose:'device-pairing' as const,id:crypto.uuid(),endpoint,pin:authority.profile.pin,
      expiresAt:Date.now()+15*60000,capabilityHash:crypto.hash(crypto.encode(capability)),capabilityPublicKey:crypto.encode(keys.publicKey)};
    const invite = {...unsigned,signature:crypto.sign(inviteSigningInput(unsigned),seed)};
    const send = async (client: DeviceProvisioning,target: string,value: unknown) => {
      const body = canonicalStringify(value), proof = await client.proof('POST',target,endpoint,body,'');
      const response = await fetch(endpoint+target,{method:'POST',headers:{'content-type':'application/json','x-lionpocket-control-version':'2',
        'x-lionpocket-proof':crypto.encode(new TextEncoder().encode(canonicalStringify(proof)))},body});
      const result = await response.json();
      if (!response.ok) throw new Error(String(result.error));
      return result;
    };
    await send(authority,`/v2/devices/vaults/${invite.pin.vaultId}/invite-create`,invite);
    const request = await device.request(), deviceName = 'Test device';
    await send(device,`/v2/pair/${invite.id}/request`,{request,deviceName,capabilitySignature:crypto.sign(pairingCapabilityInput(invite,request,deviceName),capability)});
    return request;
  } finally {crypto.erase(seed);crypto.erase(capability);}
}
