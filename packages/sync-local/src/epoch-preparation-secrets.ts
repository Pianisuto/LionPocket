import {
  assertBase64Url,
  assertDecimal64,
  assertKeyVersion,
  assertUuid,
  canonicalStringify,
  decodeCanonical,
  encodeUtf8,
  exactObject,
} from "@lionpocket/sync-protocol";
import { DeviceProvisioning, type ProvisionedProfile } from "./provisioning";
import {
  openRecovery,
  validateKeyCheckpoints,
  verifySignedRecovery,
  type SignedRecovery,
} from "./security";
import {
  preparationSecretMaxBytes,
  secretContext,
  type EpochPreparationSecretScope,
  type SecretScope,
} from "./secrets";
import type { TransportSodium } from "./transport";

export const preparationSecretPurposes = [
  "signingSeed",
  "boxSeed",
  "dataKey",
  "authoritySeed",
  "recoveryMaster",
] as const;
/** Private bytes only. Never include this object in a public profile, journal, request or report. */
export interface EpochPreparationSecretBundle {
  formatVersion: 1;
  scope: EpochPreparationSecretScope;
  deviceId: string;
  signingSeed: string;
  boxSeed: string;
  dataKey: string;
  authoritySeed: string;
  recoveryMaster: string;
  recoveryNonce: string;
  signingPublicKey: string;
  boxPublicKey: string;
  authorityPublicKey: string;
  baseKeyVersion: number;
  recoverySource: "reused" | "new";
  previousRecovery: SignedRecovery | null;
  profileASha256: string;
  authorizationSha256: string;
  commitments: {
    archiveSha256: string;
    mappingSha256: string;
    operationCount: string;
    headsSha256: string;
  };
}
export interface PreparationSecretOptions {
  deviceA: DeviceProvisioning;
  sodium: TransportSodium;
  scope: EpochPreparationSecretScope;
  authorizationSha256: string;
  commitments: EpochPreparationSecretBundle["commitments"];
}
export function epochPreparationSecretScope(
  profile: ProvisionedProfile,
  restoreId: string,
  toEpoch: string,
): EpochPreparationSecretScope {
  const scope: EpochPreparationSecretScope = {
    formatVersion: 1,
    purpose: "epochPreparation",
    installationId: profile.installationId,
    anchorDeviceId: profile.deviceId,
    serverId: profile.pin.serverId,
    vaultId: profile.pin.vaultId,
    fromEpoch: profile.pin.serverEpoch,
    toEpoch,
    restoreId,
  };
  secretContext(scope);
  return scope;
}
function keyBase(o: PreparationSecretOptions) {
  const a = o.deviceA,
    active = validateKeyCheckpoints(
      a.profile.keyCheckpoints ?? [],
      a.profile.pin,
      a.profile.grants,
      a,
    );
  if (active !== (a.profile.activeKeyVersion ?? a.profile.pin.keyVersion))
    throw new Error("key_version_mismatch");
  assertKeyVersion(active + 1);
  return active + 1;
}
function publicKey(o: PreparationSecretOptions, encoded: string, box = false) {
  const seed = o.deviceA.crypto.decode(encoded);
  try {
    const pair = box
      ? o.sodium.crypto_box_seed_keypair(seed)
      : o.sodium.crypto_sign_seed_keypair(seed);
    o.deviceA.crypto.erase(pair.privateKey);
    return o.deviceA.crypto.encode(pair.publicKey);
  } finally {
    o.deviceA.crypto.erase(seed);
  }
}
async function verifyPreviousRecovery(
  o: PreparationSecretOptions,
  bundle: EpochPreparationSecretBundle,
) {
  const a = o.deviceA,
    previous = bundle.previousRecovery;
  if (previous) verifySignedRecovery(previous, a.profile.pin, a.crypto);
  if (bundle.recoverySource !== "reused") return;
  if (!previous) throw new Error("recovery_unavailable");
  const confirmed = await a.secrets.load(a.scope("recoveryMaster"));
  try {
    if (!confirmed || a.crypto.encode(confirmed) !== bundle.recoveryMaster)
      throw new Error("invalid_recovery_code");
  } finally {
    if (confirmed) a.crypto.erase(confirmed);
  }
  const old = openRecovery(
    a,
    o.sodium,
    previous,
    "LP1." + bundle.recoveryMaster,
  );
  if (
    old.activeKeyVersion >= bundle.baseKeyVersion ||
    BigInt(old.registryVersion) > BigInt(a.profile.checkpoint!.version) ||
    old.authoritySignSeed !== bundle.authoritySeed
  )
    throw new Error("invalid_recovery_bundle");
  for (const k of old.dataKeys) {
    const key = await a.secrets.load(a.scope("dataKey", k.keyVersion));
    try {
      if (!key || a.crypto.encode(key) !== k.vaultKey)
        throw new Error("key_mismatch");
    } finally {
      if (key) a.crypto.erase(key);
    }
  }
}
export async function decodeEpochPreparationSecretBundle(
  bytes: Uint8Array,
  o: PreparationSecretOptions,
): Promise<EpochPreparationSecretBundle> {
  // Parsing failures must never quote private JSON, field names supplied by an attacker, or key bytes.
  try {
    const b = exactObject(decodeCanonical(bytes, preparationSecretMaxBytes), [
      "formatVersion",
      "scope",
      "deviceId",
      ...preparationSecretPurposes,
      "recoveryNonce",
      "signingPublicKey",
      "boxPublicKey",
      "authorityPublicKey",
      "baseKeyVersion",
      "recoverySource",
      "previousRecovery",
      "profileASha256",
      "authorizationSha256",
      "commitments",
    ]) as unknown as EpochPreparationSecretBundle;
    if (
      b.formatVersion !== 1 ||
      secretContext(b.scope) !== secretContext(o.scope)
    )
      throw new Error();
    assertUuid(b.deviceId, "4");
    if (b.deviceId === o.deviceA.profile.deviceId) throw new Error();
    for (const kind of preparationSecretPurposes) assertBase64Url(b[kind], 32);
    assertBase64Url(b.recoveryNonce, 24);
    for (const field of [
      "signingPublicKey",
      "boxPublicKey",
      "authorityPublicKey",
      "profileASha256",
      "authorizationSha256",
    ] as const)
      assertBase64Url(b[field], 32);
    exactObject(b.commitments, [
      "archiveSha256",
      "mappingSha256",
      "operationCount",
      "headsSha256",
    ]);
    for (const field of [
      "archiveSha256",
      "mappingSha256",
      "headsSha256",
    ] as const)
      assertBase64Url(b.commitments[field], 32);
    assertDecimal64(b.commitments.operationCount);
    if (
      b.baseKeyVersion !== keyBase(o) ||
      !["new", "reused"].includes(b.recoverySource) ||
      b.profileASha256 !==
        o.deviceA.crypto.hash(canonicalStringify(o.deviceA.profile)) ||
      b.authorizationSha256 !== o.authorizationSha256 ||
      canonicalStringify(b.commitments) !== canonicalStringify(o.commitments) ||
      b.signingPublicKey !== publicKey(o, b.signingSeed) ||
      b.boxPublicKey !== publicKey(o, b.boxSeed, true) ||
      b.authorityPublicKey !== publicKey(o, b.authoritySeed) ||
      b.authorityPublicKey !== o.deviceA.profile.pin.authorityPublicKey ||
      b.signingPublicKey === o.deviceA.profile.signingPublicKey ||
      b.boxPublicKey === o.deviceA.profile.boxPublicKey
    )
      throw new Error();
    await verifyPreviousRecovery(o, b);
    return b;
  } catch {
    throw new Error("invalid_preparation_secret_bundle");
  }
}
export async function createEpochPreparationSecretBundle(
  o: PreparationSecretOptions,
  previousRecovery: SignedRecovery | null,
) {
  const a = o.deviceA,
    authority = await a.secrets.load(a.scope("authoritySeed"));
  if (!authority) throw new Error("authority_secret_unavailable");
  const material = new Map<SecretScope["purpose"], Uint8Array>([
    ["authoritySeed", authority],
  ]);
  try {
    const base = keyBase(o),
      existingMaster = await a.secrets.load(a.scope("recoveryMaster"));
    material.set(
      "recoveryMaster",
      existingMaster ?? o.sodium.randombytes_buf(32),
    );
    for (const kind of ["signingSeed", "boxSeed", "dataKey"] as const)
      material.set(kind, o.sodium.randombytes_buf(32));
    const privateFields = Object.fromEntries(
      [...material].map(([kind, value]) => [kind, a.crypto.encode(value)]),
    );
    const bundle = {
      formatVersion: 1 as const,
      scope: o.scope,
      deviceId: a.crypto.uuid(),
      ...privateFields,
      recoveryNonce: a.crypto.encode(o.sodium.randombytes_buf(24)),
      signingPublicKey: publicKey(o, privateFields.signingSeed),
      boxPublicKey: publicKey(o, privateFields.boxSeed, true),
      authorityPublicKey: publicKey(o, privateFields.authoritySeed),
      baseKeyVersion: base,
      recoverySource: existingMaster ? ("reused" as const) : ("new" as const),
      previousRecovery,
      profileASha256: a.crypto.hash(canonicalStringify(a.profile)),
      authorizationSha256: o.authorizationSha256,
      commitments: o.commitments,
    } as EpochPreparationSecretBundle;
    const bytes = encodeUtf8(canonicalStringify(bundle));
    try {
      await decodeEpochPreparationSecretBundle(bytes, o);
      return bytes;
    } catch (error) {
      a.crypto.erase(bytes);
      throw error;
    }
  } finally {
    for (const value of material.values()) a.crypto.erase(value);
  }
}
export function preparationSecretDigest(
  device: DeviceProvisioning,
  bytes: Uint8Array,
) {
  return device.crypto.hash(
    "LionPocket/epoch-preparation-bundle-digest/v1\n" +
      device.crypto.encode(bytes),
  );
}
