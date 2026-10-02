import {
  assertUuid,
  canonicalStringify,
  exactObject,
} from "@lionpocket/sync-protocol";
export interface SecretScope {
  installationId: string;
  deviceId: string;
  serverId: string;
  serverEpoch: string;
  vaultId: string;
  purpose:
    "authoritySeed" | "signingSeed" | "boxSeed" | "dataKey" | "recoveryMaster";
  keyVersion: number;
}
/** Located before B has a device ID. This namespace never aliases operational secrets. */
export interface EpochPreparationSecretScope {
  formatVersion: 1;
  purpose: "epochPreparation";
  installationId: string;
  anchorDeviceId: string;
  serverId: string;
  vaultId: string;
  fromEpoch: string;
  toEpoch: string;
  restoreId: string;
}
export type StoredSecretScope = SecretScope | EpochPreparationSecretScope;
export const preparationSecretMaxBytes = 131072;

export function assertSecretBytes(
  scope: StoredSecretScope,
  secret: Uint8Array,
): void {
  secretContext(scope);
  if (scope.purpose === "epochPreparation") {
    if (secret.length < 1 || secret.length > preparationSecretMaxBytes)
      throw new Error("Invalid preparation secret size.");
  } else if (secret.length !== 32)
    throw new Error("Expected a 32-byte seed or data key.");
}
/** Authenticated local wrapping scope; independent of the durable network envelope. */
export function secretContext(scope: StoredSecretScope): string {
  if (scope.purpose === "epochPreparation") {
    exactObject(scope, [
      "formatVersion",
      "purpose",
      "installationId",
      "anchorDeviceId",
      "serverId",
      "vaultId",
      "fromEpoch",
      "toEpoch",
      "restoreId",
    ]);
    if (scope.formatVersion !== 1 || scope.fromEpoch === scope.toEpoch)
      throw new Error("Invalid preparation secret scope.");
    for (const field of [
      "installationId",
      "anchorDeviceId",
      "serverId",
      "vaultId",
      "fromEpoch",
      "toEpoch",
      "restoreId",
    ] as const)
      assertUuid(scope[field], "4");
    return canonicalStringify({
      context: "LionPocket/epoch-preparation-wrap/v1",
      ...scope,
    });
  }
  for (const field of [
    "installationId",
    "deviceId",
    "serverId",
    "serverEpoch",
    "vaultId",
  ] as const)
    assertUuid(scope[field], "4");
  if (
    ![
      "authoritySeed",
      "signingSeed",
      "boxSeed",
      "dataKey",
      "recoveryMaster",
    ].includes(scope.purpose) ||
    !Number.isSafeInteger(scope.keyVersion) ||
    scope.keyVersion < 1
  )
    throw new Error("Invalid secret scope.");
  return canonicalStringify({
    context: "LionPocket/local-wrap/v1",
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
  /** Preparation writes are immutable: existing different bytes must be refused. */
  store(scope: StoredSecretScope, secret: Uint8Array): Promise<void>;
  load(scope: StoredSecretScope): Promise<Uint8Array | null>;
  remove(scope: StoredSecretScope): Promise<void>;
}
/** UUIDv4 bits over exactly 16 CSPRNG bytes. Never derive global IDs from local PKs. */
export function uuidFromRandom(bytes: Uint8Array): string {
  if (bytes.length !== 16) throw new Error("UUID requires 16 random bytes.");
  const b = bytes.slice();
  b[6] = (b[6] & 15) | 64;
  b[8] = (b[8] & 63) | 128;
  const hex = Array.from(b, (n) => n.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
