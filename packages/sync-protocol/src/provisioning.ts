import { canonicalStringify } from "./canonical";
import { assertBase64Url, assertDecimal64, assertUuid } from "./validation";
import { deviceGrantSigningInput, keyDeliverySigningInput } from "./control";
import type { CursorScope, DeviceGrant, VaultKeyDelivery } from "./types";

export interface TrustPin extends CursorScope {
  authorityPublicKey: string;
  founderDeviceId: string;
  /** Immutable initial/base key version of this generation; legacy generations start at 1. */
  keyVersion: number;
}
export function assertKeyVersion(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) < 1)
    throw new Error("key_version_mismatch");
}
export function baseKeyVersion(pin: TrustPin): number {
  assertKeyVersion(pin.keyVersion);
  return pin.keyVersion;
}
export interface PairingFields extends CursorScope {
  formatVersion: 1;
  deviceId: string;
  signingPublicKey: string;
  boxPublicKey: string;
  nonce: string;
}
export interface PairingRequest extends PairingFields {
  fingerprint: string;
  signature: string;
}
export interface KeyBundleV1 extends CursorScope {
  formatVersion: 1;
  recipientDeviceId: string;
  registryVersion: string;
  keyVersion: number;
  vaultKey: string;
}
export interface EpochDataKey {
  keyVersion: number;
  vaultKey: string;
}
export interface KeyBundleV2 extends CursorScope {
  formatVersion: 2;
  recipientDeviceId: string;
  registryVersion: string;
  baseKeyVersion: number;
  keyVersion: number;
  dataKeys: EpochDataKey[];
}
export type KeyBundle = KeyBundleV1 | KeyBundleV2;
/** Only the contiguous key range of this epoch, never keys from earlier epochs. */
export function validateEpochDataKeys(
  value: unknown,
  base: number,
  active: number,
): EpochDataKey[] {
  assertKeyVersion(base);
  assertKeyVersion(active);
  if (
    active < base ||
    active - base >= 1000 ||
    !Array.isArray(value) ||
    value.length !== active - base + 1
  )
    throw new Error("invalid_data_keys");
  return value.map((v, i) => {
    const row = exactObject(v, ["keyVersion", "vaultKey"]);
    if (row.keyVersion !== base + i) throw new Error("invalid_data_keys");
    assertBase64Url(row.vaultKey, 32);
    return row as unknown as EpochDataKey;
  });
}
export interface HttpProof extends CursorScope {
  formatVersion: 1;
  deviceId: string;
  method: string;
  target: string;
  origin: string;
  issuedAt: number;
  nonce: string;
  bodySha256: string;
  accessTokenSha256: string;
  signature: string;
}
export interface ControlCrypto {
  hash(text: string): string;
  verify(signature: string, text: string, publicKey: string): boolean;
}
export function exactObject(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  canonicalStringify(value);
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("invalid_envelope");
  const row = value as Record<string, unknown>;
  if (
    Object.keys(row).length !== keys.length ||
    keys.some((k) => !Object.prototype.hasOwnProperty.call(row, k))
  )
    throw new Error("invalid_envelope");
  return row;
}
const scopeKeys = ["serverId", "serverEpoch", "vaultId"];
export function assertScope(value: Record<string, unknown>): void {
  for (const key of scopeKeys) assertUuid(value[key], "4");
}
export function sameScope(a: CursorScope, b: CursorScope): void {
  if (
    a.serverId !== b.serverId ||
    a.serverEpoch !== b.serverEpoch ||
    a.vaultId !== b.vaultId
  )
    throw new Error("scope_mismatch");
}
export function assertTrustPin(value: unknown): asserts value is TrustPin {
  const row = exactObject(value, [
    ...scopeKeys,
    "authorityPublicKey",
    "founderDeviceId",
    "keyVersion",
  ]);
  assertScope(row);
  assertUuid(row.founderDeviceId, "4");
  assertBase64Url(row.authorityPublicKey, 32);
  assertKeyVersion(row.keyVersion);
}
export function pairingFingerprintInput(fields: PairingFields): string {
  return canonicalStringify({
    context: "LionPocket/pairing-fingerprint/v1",
    request: fields,
  });
}
export function pairingSigningInput(
  request: Omit<PairingRequest, "signature">,
): string {
  if ("signature" in request) throw new Error("Expected unsigned request.");
  return canonicalStringify({
    context: "LionPocket/pairing-request/v1",
    request,
  });
}
export function httpProofSigningInput(
  proof: Omit<HttpProof, "signature">,
): string {
  if ("signature" in proof) throw new Error("Expected unsigned proof.");
  return canonicalStringify({ context: "LionPocket/http-proof/v1", proof });
}
export function assertPairingRequest(
  value: unknown,
): asserts value is PairingRequest {
  const row = exactObject(value, [
    ...scopeKeys,
    "formatVersion",
    "deviceId",
    "signingPublicKey",
    "boxPublicKey",
    "nonce",
    "fingerprint",
    "signature",
  ]);
  assertScope(row);
  assertUuid(row.deviceId, "4");
  if (row.formatVersion !== 1) throw new Error("unsupported_version");
  for (const field of [
    "signingPublicKey",
    "boxPublicKey",
    "nonce",
    "fingerprint",
  ])
    assertBase64Url(row[field], 32);
  assertBase64Url(row.signature, 64);
}
export function verifyPairing(
  request: PairingRequest,
  crypto: ControlCrypto,
): void {
  assertPairingRequest(request);
  const { signature, fingerprint, ...fields } = request;
  if (
    crypto.hash(pairingFingerprintInput(fields)) !== fingerprint ||
    !crypto.verify(
      signature,
      pairingSigningInput({ ...fields, fingerprint }),
      fields.signingPublicKey,
    )
  )
    throw new Error("invalid_signature");
}
export function assertDeviceGrant(
  value: unknown,
): asserts value is DeviceGrant {
  const row = exactObject(value, [
    ...scopeKeys,
    "formatVersion",
    "registryVersion",
    "previousRegistrySha256",
    "deviceId",
    "signingPublicKey",
    "boxPublicKey",
    "status",
    "signature",
  ]);
  assertScope(row);
  assertUuid(row.deviceId, "4");
  assertDecimal64(row.registryVersion, true);
  if (
    row.formatVersion !== 1 ||
    !["approved", "revoked"].includes(String(row.status))
  )
    throw new Error("invalid_envelope");
  if (row.previousRegistrySha256 !== null)
    assertBase64Url(row.previousRegistrySha256, 32);
  assertBase64Url(row.signingPublicKey, 32);
  assertBase64Url(row.boxPublicKey, 32);
  assertBase64Url(row.signature, 64);
}
export function nextRegistryVersion(version: string): string {
  assertDecimal64(version);
  const digits = version.split("");
  let carry = 1;
  for (let i = digits.length - 1; i >= 0 && carry; i--) {
    const n = Number(digits[i]) + carry;
    digits[i] = String(n % 10);
    carry = n > 9 ? 1 : 0;
  }
  if (carry) digits.unshift("1");
  const next = digits.join("");
  assertDecimal64(next, true);
  return next;
}
export interface RegistryCheckpoint {
  version: string;
  sha256: string;
}
export function validateGrantChain(
  grants: readonly DeviceGrant[],
  pin: TrustPin,
  crypto: ControlCrypto,
  checkpoint?: RegistryCheckpoint,
) {
  assertTrustPin(pin);
  if (!grants.length || grants.length > 10000)
    throw new Error("invalid_registry");
  let version = "0",
    previous: string | null = null,
    checkpointFound = !checkpoint;
  const devices = new Map<string, DeviceGrant>();
  for (const grant of grants) {
    assertDeviceGrant(grant);
    sameScope(grant, pin);
    if (
      grant.registryVersion !== nextRegistryVersion(version) ||
      grant.previousRegistrySha256 !== previous
    )
      throw new Error("registry_order");
    const { signature, ...unsigned } = grant;
    if (
      !crypto.verify(
        signature,
        deviceGrantSigningInput(unsigned),
        pin.authorityPublicKey,
      )
    )
      throw new Error("invalid_signature");
    const existing = devices.get(grant.deviceId);
    if (
      version === "0" &&
      (grant.deviceId !== pin.founderDeviceId || grant.status !== "approved")
    )
      throw new Error("invalid_founder");
    if (
      existing &&
      (existing.status === "revoked" ||
        grant.status !== "revoked" ||
        existing.signingPublicKey !== grant.signingPublicKey ||
        existing.boxPublicKey !== grant.boxPublicKey)
    )
      throw new Error("invalid_device_transition");
    if (!existing && grant.status === "revoked")
      throw new Error("invalid_device_transition");
    if (
      !existing &&
      Array.from(devices.values()).some(
        (d) =>
          d.signingPublicKey === grant.signingPublicKey ||
          d.boxPublicKey === grant.boxPublicKey,
      )
    )
      throw new Error("duplicate_device_key");
    if (
      grant.deviceId === pin.founderDeviceId &&
      grant.status === "revoked" &&
      ![...devices.values()].some(
        (d) => d.deviceId !== grant.deviceId && d.status === "approved",
      )
    )
      throw new Error("founder_revocation_unavailable");
    devices.set(grant.deviceId, grant);
    if (
      Array.from(devices.values()).filter((d) => d.status === "approved")
        .length > 10
    )
      throw new Error("device_limit");
    version = grant.registryVersion;
    previous = crypto.hash(canonicalStringify(grant));
    if (checkpoint?.version === version) {
      if (checkpoint.sha256 !== previous) throw new Error("registry_fork");
      checkpointFound = true;
    }
  }
  if (!checkpointFound) throw new Error("registry_rollback");
  return { devices, checkpoint: { version, sha256: previous as string } };
}
export function activeDevice(
  devices: Map<string, DeviceGrant>,
  id: string,
): DeviceGrant {
  const device = devices.get(id);
  if (!device) throw new Error("forbidden");
  if (device.status !== "approved") throw new Error("device_revoked");
  return device;
}
export function assertKeyDelivery(
  value: unknown,
): asserts value is VaultKeyDelivery {
  const row = exactObject(value, [
    ...scopeKeys,
    "formatVersion",
    "recipientDeviceId",
    "registryVersion",
    "keyVersion",
    "sealedBox",
    "authorDeviceId",
    "signature",
  ]);
  assertScope(row);
  assertUuid(row.recipientDeviceId, "4");
  assertUuid(row.authorDeviceId, "4");
  assertDecimal64(row.registryVersion, true);
  if (row.formatVersion !== 1) throw new Error("unsupported_version");
  assertKeyVersion(row.keyVersion);
  assertBase64Url(row.sealedBox, undefined, 48);
  assertBase64Url(row.signature, 64);
}
export function validateDelivery(
  delivery: VaultKeyDelivery,
  grants: DeviceGrant[],
  pin: TrustPin,
  crypto: ControlCrypto,
  activeKeyVersion?: number,
) {
  assertKeyDelivery(delivery);
  sameScope(delivery, pin);
  if (
    delivery.keyVersion < baseKeyVersion(pin) ||
    (activeKeyVersion !== undefined && delivery.keyVersion !== activeKeyVersion)
  )
    throw new Error("key_version_mismatch");
  if (!grants.some((g) => g.registryVersion === delivery.registryVersion))
    throw new Error("registry_order");
  const historical = validateGrantChain(
    grants.filter(
      (g) =>
        g.registryVersion.length < delivery.registryVersion.length ||
        (g.registryVersion.length === delivery.registryVersion.length &&
          g.registryVersion <= delivery.registryVersion),
    ),
    pin,
    crypto,
  );
  activeDevice(historical.devices, delivery.recipientDeviceId);
  const author = activeDevice(historical.devices, delivery.authorDeviceId);
  const current = validateGrantChain(grants, pin, crypto);
  activeDevice(current.devices, delivery.recipientDeviceId);
  activeDevice(current.devices, delivery.authorDeviceId);
  const { signature, ...unsigned } = delivery;
  if (
    !crypto.verify(
      signature,
      keyDeliverySigningInput(unsigned),
      author.signingPublicKey,
    )
  )
    throw new Error("invalid_signature");
}
export function assertKeyBundle(value: unknown): asserts value is KeyBundle {
  const version = (value as { formatVersion?: unknown } | null)?.formatVersion;
  if (version !== 1 && version !== 2) throw new Error("unsupported_version");
  const row = exactObject(value, [
    ...scopeKeys,
    "formatVersion",
    "recipientDeviceId",
    "registryVersion",
    "keyVersion",
    ...(version === 1 ? ["vaultKey"] : ["baseKeyVersion", "dataKeys"]),
  ]);
  assertScope(row);
  assertUuid(row.recipientDeviceId, "4");
  assertDecimal64(row.registryVersion, true);
  assertKeyVersion(row.keyVersion);
  if (version === 1) assertBase64Url(row.vaultKey, 32);
  else {
    assertKeyVersion(row.baseKeyVersion);
    validateEpochDataKeys(row.dataKeys, row.baseKeyVersion, row.keyVersion);
  }
}

export function assertHttpProof(value: unknown): asserts value is HttpProof {
  const row = exactObject(value, [
    ...scopeKeys,
    "formatVersion",
    "deviceId",
    "method",
    "target",
    "origin",
    "issuedAt",
    "nonce",
    "bodySha256",
    "accessTokenSha256",
    "signature",
  ]);
  assertScope(row);
  assertUuid(row.deviceId, "4");
  if (
    row.formatVersion !== 1 ||
    !["GET", "POST"].includes(String(row.method)) ||
    typeof row.target !== "string" ||
    !/^\/(?:v1\/[a-zA-Z0-9/-]+|v2\/pair\/[0-9a-f-]{36}\/(?:request|status)|v2\/devices\/vaults\/[0-9a-f-]{36}\/(?:invite-create|invite-revoke|pairing-deny|pairing-list|grants|deliveries|key-checkpoints|recovery-store|registry|commits|changes))$/.test(row.target) ||
    typeof row.origin !== "string" ||
    !Number.isSafeInteger(row.issuedAt)
  )
    throw new Error("invalid_envelope");
  for (const field of ["nonce", "bodySha256", "accessTokenSha256"])
    assertBase64Url(row[field], 32);
  assertBase64Url(row.signature, 64);
}
export function verifyHttpProof(
  proof: HttpProof,
  expected: {
    scope: CursorScope;
    method: string;
    target: string;
    origin: string;
    body: string;
    token: string;
    now: number;
    publicKey: string;
  },
  crypto: ControlCrypto,
) {
  assertHttpProof(proof);
  sameScope(proof, expected.scope);
  if (
    Math.abs(expected.now - proof.issuedAt) > 60000 ||
    proof.method !== expected.method ||
    proof.target !== expected.target ||
    proof.origin !== expected.origin ||
    proof.bodySha256 !== crypto.hash(expected.body) ||
    proof.accessTokenSha256 !== crypto.hash(expected.token)
  )
    throw new Error("invalid_http_proof");
  const { signature, ...unsigned } = proof;
  if (
    !crypto.verify(
      signature,
      httpProofSigningInput(unsigned),
      expected.publicKey,
    )
  )
    throw new Error("invalid_signature");
}
