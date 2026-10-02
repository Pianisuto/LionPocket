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
    grant = await client.grant(request, request.fingerprint);
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
