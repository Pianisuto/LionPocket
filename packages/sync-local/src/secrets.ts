import { assertUuid, canonicalStringify } from '@lionpocket/sync-protocol';
export interface SecretScope {
  installationId: string;
  deviceId: string;
  serverId: string;
  serverEpoch: string;
  vaultId: string;
  purpose: 'authoritySeed' | 'signingSeed' | 'boxSeed' | 'dataKey' | 'recoveryMaster';
  keyVersion: number;
}
/** Authenticated local wrapping scope; independent of the durable network envelope. */
export function secretContext(scope: SecretScope): string {
  for (const field of [
    'installationId',
    'deviceId',
    'serverId',
    'serverEpoch',
    'vaultId',
  ] as const)
    assertUuid(scope[field], '4');
  if (
    !['authoritySeed', 'signingSeed', 'boxSeed', 'dataKey', 'recoveryMaster'].includes(
      scope.purpose,
    ) ||
    !Number.isSafeInteger(scope.keyVersion) ||
    scope.keyVersion < 1
  )
    throw new Error('Invalid secret scope.');
  return canonicalStringify({
    context: 'LionPocket/local-wrap/v1',
    installationId: scope.installationId,
    deviceId: scope.deviceId,
    serverId: scope.serverId,
    serverEpoch: scope.serverEpoch,
    vaultId: scope.vaultId,
    purpose: scope.purpose,
    keyVersion: scope.keyVersion,
  });
}
export interface SecretStore {
  store(scope: SecretScope, secret: Uint8Array): Promise<void>;
  load(scope: SecretScope): Promise<Uint8Array | null>;
  remove(scope: SecretScope): Promise<void>;
}
/** UUIDv4 bits over exactly 16 CSPRNG bytes. Never derive global IDs from local PKs. */
export function uuidFromRandom(bytes: Uint8Array): string {
  if (bytes.length !== 16) throw new Error('UUID requires 16 random bytes.');
  const b = bytes.slice();
  b[6] = (b[6] & 15) | 64;
  b[8] = (b[8] & 63) | 128;
  const hex = Array.from(b, (n) => n.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
