import {
  activeDevice,
  baseKeyVersion,
  assertKeyVersion,
  validateEpochDataKeys,
  assertBase64Url,
  assertDecimal64,
  assertUuid,
  canonicalStringify,
  decodeCanonical,
  encodeUtf8,
  exactObject,
  recoveryAssociatedData,
  sameScope,
  validateGrantChain,
  type DeviceGrant,
  type RecoveryBundle,
  type RecoveryEnvelope,
  type TrustPin,
} from "@lionpocket/sync-protocol";
import { DeviceProvisioning, type RegistryResponse } from "./provisioning";
import type { TransportSodium } from "./transport";
export interface KeyCheckpoint {
  formatVersion: 1;
  serverId: string;
  serverEpoch: string;
  vaultId: string;
  keyVersion: number;
  registryVersion: string;
  previousSha256: string | null;
  deliveries: { deviceId: string; sealedBox: string }[];
  signature: string;
}
export interface SignedRecovery {
  envelope: RecoveryEnvelope;
  signature: string;
}
const keyInput = (v: Omit<KeyCheckpoint, "signature">) =>
  canonicalStringify({
    context: "LionPocket/beta-key-checkpoint/v1",
    checkpoint: v,
  });
export const recoveryInput = (envelope: RecoveryEnvelope) =>
  canonicalStringify({
    context: "LionPocket/beta-recovery-store/v1",
    envelope,
  });
interface RecoverySodium extends TransportSodium {
  crypto_kdf_derive_from_key(
    length: number,
    id: number,
    context: string,
    master: Uint8Array,
  ): Uint8Array;
}
export function validateKeyCheckpoints(
  checkpoints: KeyCheckpoint[],
  pin: TrustPin,
  grants: DeviceGrant[],
  device: Pick<DeviceProvisioning, "crypto">,
): number {
  let version = baseKeyVersion(pin),
    previous: string | null = null;
  for (const entry of checkpoints) {
    exactObject(entry, [
      "formatVersion",
      "serverId",
      "serverEpoch",
      "vaultId",
      "keyVersion",
      "registryVersion",
      "previousSha256",
      "deliveries",
      "signature",
    ]);
    sameScope(entry, pin);
    assertDecimal64(entry.registryVersion, true);
    assertBase64Url(entry.signature, 64);
    if (
      entry.formatVersion !== 1 ||
      entry.keyVersion !== version + 1 ||
      entry.previousSha256 !== previous ||
      !Array.isArray(entry.deliveries)
    )
      throw new Error("invalid_key_checkpoint");
    const history = grants.filter(
      (g) =>
        g.registryVersion.length < entry.registryVersion.length ||
        (g.registryVersion.length === entry.registryVersion.length &&
          g.registryVersion <= entry.registryVersion),
    );
    const registry = validateGrantChain(history, pin, device.crypto),
      active = [...registry.devices.values()]
        .filter((d) => d.status === "approved")
        .map((d) => d.deviceId)
        .sort();
    const recipients = entry.deliveries
      .map((d) => {
        exactObject(d, ["deviceId", "sealedBox"]);
        assertUuid(d.deviceId, "4");
        assertBase64Url(d.sealedBox, undefined, 48);
        return d.deviceId;
      })
      .sort();
    if (canonicalStringify(active) !== canonicalStringify(recipients))
      throw new Error("invalid_key_recipients");
    const { signature, ...unsigned } = entry;
    if (
      !device.crypto.verify(
        signature,
        keyInput(unsigned),
        pin.authorityPublicKey,
      )
    )
      throw new Error("invalid_signature");
    version = entry.keyVersion;
    previous = device.crypto.hash(canonicalStringify(entry));
  }
  return version;
}
async function authoritySign(device: DeviceProvisioning, text: string) {
  const seed = await device.secrets.load(device.scope("authoritySeed"));
  if (!seed) throw new Error("authority_secret_unavailable");
  try {
    return device.crypto.sign(text, seed);
  } finally {
    device.crypto.erase(seed);
  }
}
export async function dataKeys(device: DeviceProvisioning) {
  const result: RecoveryBundle["dataKeys"] = [];
  for (
    let keyVersion = baseKeyVersion(device.profile.pin);
    keyVersion <=
    (device.profile.activeKeyVersion ?? baseKeyVersion(device.profile.pin));
    keyVersion++
  ) {
    const key = await device.secrets.load(device.scope("dataKey", keyVersion));
    if (!key) throw new Error("secret_unavailable");
    try {
      result.push({ keyVersion, vaultKey: device.crypto.encode(key) });
    } finally {
      device.crypto.erase(key);
    }
  }
  return result;
}
export async function makeKeyCheckpoint(
  device: DeviceProvisioning,
): Promise<KeyCheckpoint> {
  const registry = validateGrantChain(
      device.profile.grants,
      device.profile.pin,
      device.crypto,
    ),
    previous = device.profile.keyCheckpoints ?? [],
    keyVersion =
      (device.profile.activeKeyVersion ?? baseKeyVersion(device.profile.pin)) +
      1;
  assertKeyVersion(keyVersion);
  const keys = await dataKeys(device),
    fresh = device.crypto.sodium.randombytes_buf(32);
  try {
    keys.push({ keyVersion, vaultKey: device.crypto.encode(fresh) });
  } finally {
    device.crypto.erase(fresh);
  }
  const { serverId, serverEpoch, vaultId } = device.profile.pin;
  const deliveries = [...registry.devices.values()]
    .filter((d) => d.status === "approved")
    .sort((a, b) => a.deviceId.localeCompare(b.deviceId))
    .map((d) => {
      const bytes = encodeUtf8(
        canonicalStringify({
          formatVersion: 1,
          serverId,
          serverEpoch,
          vaultId,
          recipientDeviceId: d.deviceId,
          keyVersion,
          dataKeys: keys,
        }),
      );
      try {
        return {
          deviceId: d.deviceId,
          sealedBox: device.crypto.encode(
            device.crypto.sodium.crypto_box_seal(
              bytes,
              device.crypto.decode(d.boxPublicKey),
            ),
          ),
        };
      } finally {
        device.crypto.erase(bytes);
      }
    });
  const unsigned = {
    formatVersion: 1 as const,
    serverId,
    serverEpoch,
    vaultId,
    keyVersion,
    registryVersion: registry.checkpoint.version,
    previousSha256: previous.length
      ? device.crypto.hash(canonicalStringify(previous[previous.length - 1]))
      : null,
    deliveries,
  };
  const result = {
    ...unsigned,
    signature: await authoritySign(device, keyInput(unsigned)),
  };
  validateKeyCheckpoints(
    [...previous, result],
    device.profile.pin,
    device.profile.grants,
    device,
  );
  return result;
}
export async function acceptKeyCheckpoints(
  device: DeviceProvisioning,
  response: RegistryResponse,
): Promise<void> {
  const entries = response.keyCheckpoints ?? [],
    version = validateKeyCheckpoints(
      entries,
      device.profile.pin,
      response.grants,
      device,
    );
  const known = device.profile.keyCheckpoints ?? [];
  if (
    entries.length < known.length ||
    known.some(
      (c, i) => canonicalStringify(c) !== canonicalStringify(entries[i]),
    )
  )
    throw new Error("key_checkpoint_rollback");
  const available = await device.secrets.load(device.scope("dataKey", version));
  const alreadyReceived =
    available !== null && device.profile.activeKeyVersion === version;
  if (available) device.crypto.erase(available);
  // A delivery already received from an approved device must still match the authority checkpoint
  // whenever that checkpoint includes this recipient. Only a newly joined recipient absent from
  // the historical checkpoint can rely on its complete, signed epoch-key delivery instead.
  const addressed =
    entries.length &&
    entries[entries.length - 1].deliveries.some(
      (d) => d.deviceId === device.profile.deviceId,
    );
  if (entries.length && (!alreadyReceived || addressed)) {
    const delivery = entries[entries.length - 1].deliveries.find(
      (d) => d.deviceId === device.profile.deviceId,
    );
    if (!delivery) throw new Error("device_revoked");
    const seed = await device.secrets.load(device.scope("boxSeed"));
    if (!seed) throw new Error("secret_unavailable");
    const pair = device.crypto.sodium.crypto_box_seed_keypair(seed);
    device.crypto.erase(seed);
    let bytes: Uint8Array | null = null;
    try {
      bytes = device.crypto.sodium.crypto_box_seal_open(
        device.crypto.decode(delivery.sealedBox),
        pair.publicKey,
        pair.privateKey,
      );
      if (!bytes) throw new Error("invalid_sealed_box");
      const bundle = exactObject(decodeCanonical(bytes, 65536), [
        "formatVersion",
        "serverId",
        "serverEpoch",
        "vaultId",
        "recipientDeviceId",
        "keyVersion",
        "dataKeys",
      ]);
      sameScope(bundle as unknown as TrustPin, device.profile.pin);
      if (
        bundle.formatVersion !== 1 ||
        bundle.recipientDeviceId !== device.profile.deviceId ||
        bundle.keyVersion !== version
      )
        throw new Error("key_bundle_mismatch");
      const keys = validateEpochDataKeys(
        bundle.dataKeys,
        baseKeyVersion(device.profile.pin),
        version,
      );
      for (const k of keys) {
        const key = device.crypto.decode(k.vaultKey),
          existing = await device.secrets.load(
            device.scope("dataKey", k.keyVersion),
          );
        try {
          if (existing && device.crypto.encode(existing) !== k.vaultKey)
            throw new Error("key_mismatch");
          await device.secrets.store(
            device.scope("dataKey", k.keyVersion),
            key,
          );
        } finally {
          device.crypto.erase(key);
          if (existing) device.crypto.erase(existing);
        }
      }
    } finally {
      device.crypto.erase(pair.privateKey);
      if (bytes) device.crypto.erase(bytes);
    }
  }
  device.profile.activeKeyVersion = version;
  device.profile.keyCheckpoints = entries;
}
export async function makeRecovery(
  device: DeviceProvisioning,
  sodium: TransportSodium,
  recoveryVersion: string,
  existingMaster?: Uint8Array,
  existingNonce?: Uint8Array,
) {
  const master = existingMaster?.slice() ?? sodium.randombytes_buf(32);
  let key: Uint8Array | null = null,
    authority: Uint8Array | null = null,
    bytes: Uint8Array | null = null;
  try {
    if (existingNonce && existingNonce.length !== 24) throw new Error('invalid_recovery_nonce');
    const code = "LP1." + device.crypto.encode(master);
    key = (sodium as RecoverySodium).crypto_kdf_derive_from_key(
      32,
      1,
      "LPRECOV1",
      master,
    );
    authority = await device.secrets.load(device.scope("authoritySeed"));
    if (!authority) throw new Error("authority_secret_unavailable");
    const { serverId, serverEpoch, vaultId } = device.profile.pin;
    const header = {
      formatVersion: 1 as const,
      cryptoSuite: "lp-sodium-v1" as const,
      serverId,
      serverEpoch,
      vaultId,
      recoveryVersion,
      kdf: "sodium-kdf-blake2b-LPRECOV1-1" as const,
      nonce: device.crypto.encode(existingNonce ?? sodium.randombytes_buf(24)),
    };
    const fields = {
      serverId,
      serverEpoch,
      vaultId,
      recoveryVersion,
      registryVersion: device.profile.checkpoint!.version,
      authoritySignSeed: device.crypto.encode(authority),
      authorityPublicKey: device.profile.pin.authorityPublicKey,
      activeKeyVersion:
        device.profile.activeKeyVersion ?? baseKeyVersion(device.profile.pin),
      dataKeys: await dataKeys(device),
    };
    const bundle: RecoveryBundle =
      baseKeyVersion(device.profile.pin) === 1
        ? { formatVersion: 1, ...fields }
        : {
            formatVersion: 2,
            baseKeyVersion: baseKeyVersion(device.profile.pin),
            ...fields,
          };
    bytes = encodeUtf8(canonicalStringify(bundle));
    const envelope = {
      ...header,
      ciphertext: device.crypto.encode(
        sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
          bytes,
          recoveryAssociatedData(header),
          null,
          device.crypto.decode(header.nonce),
          key,
        ),
      ),
    };
    return {
      code,
      recovery: {
        envelope,
        signature: await authoritySign(device, recoveryInput(envelope)),
      },
    };
  } finally {
    device.crypto.erase(master);
    if (authority) device.crypto.erase(authority);
    if (bytes) device.crypto.erase(bytes);
    if (key) device.crypto.erase(key);
  }
}
export function openRecovery(
  device: DeviceProvisioning,
  sodium: TransportSodium,
  recovery: SignedRecovery,
  code: string,
): RecoveryBundle {
  if (!/^LP1\.[A-Za-z0-9_-]{43}$/.test(code))
    throw new Error("invalid_recovery_code");
  assertBase64Url(code.slice(4), 32);
  verifySignedRecovery(recovery, device.profile.pin, device.crypto);
  const { envelope } = recovery;
  const master = device.crypto.decode(code.slice(4)),
    key = (sodium as RecoverySodium).crypto_kdf_derive_from_key(
      32,
      1,
      "LPRECOV1",
      master,
    );
  device.crypto.erase(master);
  const { ciphertext, ...header } = envelope;
  let bytes: Uint8Array | null = null;
  try {
    bytes = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
      null,
      device.crypto.decode(ciphertext),
      recoveryAssociatedData(header),
      device.crypto.decode(envelope.nonce),
      key,
    );
    if (!bytes) throw new Error("invalid_recovery_code");
    const decoded = decodeCanonical(bytes, 65536);
    const version = (decoded as { formatVersion?: unknown } | null)
      ?.formatVersion;
    if (version !== 1 && version !== 2) throw new Error("unsupported_version");
    const b = exactObject(decoded, [
      "formatVersion",
      "serverId",
      "serverEpoch",
      "vaultId",
      "recoveryVersion",
      "registryVersion",
      "authoritySignSeed",
      "authorityPublicKey",
      "activeKeyVersion",
      "dataKeys",
      ...(version === 2 ? ["baseKeyVersion"] : []),
    ]) as unknown as RecoveryBundle;
    sameScope(b, envelope);
    assertDecimal64(b.registryVersion, true);
    assertBase64Url(b.authoritySignSeed, 32);
    if (
      (b.formatVersion === 2 ? b.baseKeyVersion : 1) !==
        baseKeyVersion(device.profile.pin) ||
      b.recoveryVersion !== envelope.recoveryVersion ||
      b.authorityPublicKey !== device.profile.pin.authorityPublicKey
    )
      throw new Error("invalid_recovery_bundle");
    validateEpochDataKeys(
      b.dataKeys,
      b.formatVersion === 2 ? b.baseKeyVersion : 1,
      b.activeKeyVersion,
    );
    const seed = device.crypto.decode(b.authoritySignSeed);
    let pair;
    try {
      pair = sodium.crypto_sign_seed_keypair(seed);
    } finally {
      device.crypto.erase(seed);
    }
    device.crypto.erase(pair.privateKey);
    if (device.crypto.encode(pair.publicKey) !== b.authorityPublicKey)
      throw new Error("key_mismatch");
    return b;
  } finally {
    if (bytes) device.crypto.erase(bytes);
    device.crypto.erase(key);
  }
}

export function verifySignedRecovery(
  recovery: SignedRecovery,
  pin: TrustPin,
  crypto: DeviceProvisioning["crypto"],
) {
  exactObject(recovery, ["envelope", "signature"]);
  assertBase64Url(recovery.signature, 64);
  const { envelope, signature } = recovery;
  exactObject(envelope, [
    "formatVersion",
    "cryptoSuite",
    "serverId",
    "serverEpoch",
    "vaultId",
    "recoveryVersion",
    "kdf",
    "nonce",
    "ciphertext",
  ]);
  sameScope(envelope, pin);
  assertDecimal64(envelope.recoveryVersion, true);
  assertBase64Url(envelope.nonce, 24);
  assertBase64Url(envelope.ciphertext, undefined, 16);
  if (
    envelope.formatVersion !== 1 ||
    envelope.cryptoSuite !== "lp-sodium-v1" ||
    envelope.kdf !== "sodium-kdf-blake2b-LPRECOV1-1" ||
    !crypto.verify(signature, recoveryInput(envelope), pin.authorityPublicKey)
  )
    throw new Error("invalid_recovery_envelope");
}
