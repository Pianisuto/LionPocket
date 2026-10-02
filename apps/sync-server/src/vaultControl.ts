import {
  assertBase64Url,
  assertDecimal64,
  assertDeviceGrant,
  canonicalStringify,
  exactObject,
  sameScope,
  validateGrantChain,
  verifyPairing,
  type PairingRequest,
  type TrustPin,
  type DeviceGrant,
} from "@lionpocket/sync-protocol";
import {
  validateKeyCheckpoints,
  recoveryInput,
  type KeyCheckpoint,
  type SignedRecovery,
  type ProvisioningCrypto,
} from "@lionpocket/sync-local";
import type { PoolClient } from "pg";
export async function vaultRecoveryRequest(
  tx: PoolClient,
  action: string,
  value: unknown,
  pin: TrustPin,
  grants: DeviceGrant[],
  deviceId: string,
  crypto: ProvisioningCrypto,
  checkProof: (publicKey: string) => Promise<void>,
) {
  const row = exactObject(
    value,
    action === "recover" ? ["request", "grant"] : ["request"],
  );
  const request = row.request as PairingRequest;
  verifyPairing(request, crypto);
  sameScope(request, pin);
  if (request.deviceId !== deviceId) throw new Error("forbidden");
  await checkProof(request.signingPublicKey);
  if (action === "recover") {
    assertDeviceGrant(row.grant);
    const grant = row.grant;
    if (
      grant.deviceId !== request.deviceId ||
      grant.signingPublicKey !== request.signingPublicKey ||
      grant.boxPublicKey !== request.boxPublicKey ||
      grant.status !== "approved"
    )
      throw new Error("invalid_pairing_grant");
    validateGrantChain([...grants, grant], pin, crypto);
    await tx.query(
      "INSERT INTO sync_grants(vault_id,registry_version,grant_envelope) VALUES($1,$2,$3)",
      [pin.vaultId, grant.registryVersion, grant],
    );
    await tx.query(
      "UPDATE sync_vaults SET registry_version=$2,rotation_required=true WHERE vault_id=$1",
      [pin.vaultId, grant.registryVersion],
    );
    grants.push(grant);
  }
  const vault = (
    await tx.query(
      "SELECT recovery,key_checkpoints FROM sync_vaults WHERE vault_id=$1",
      [pin.vaultId],
    )
  ).rows[0];
  return {
    pin,
    grants,
    delivery: null,
    keyCheckpoints: vault.key_checkpoints,
    recovery: vault.recovery,
  };
}
export async function vaultControl(
  tx: PoolClient,
  action: string,
  value: unknown,
  pin: TrustPin,
  grants: DeviceGrant[],
  crypto: ProvisioningCrypto,
) {
  const vault = (
    await tx.query(
      "SELECT key_checkpoints,recovery FROM sync_vaults WHERE vault_id=$1",
      [pin.vaultId],
    )
  ).rows[0];
  if (action === "key-checkpoints") {
    const checkpoint = value as KeyCheckpoint,
      current = vault.key_checkpoints as KeyCheckpoint[];
    if (
      current.length &&
      canonicalStringify(current[current.length - 1]) ===
        canonicalStringify(checkpoint)
    )
      return;
    validateKeyCheckpoints([...current, checkpoint], pin, grants, { crypto });
    const registry = validateGrantChain(grants, pin, crypto);
    if (checkpoint.registryVersion !== registry.checkpoint.version)
      throw new Error("registry_order");
    await tx.query(
      "UPDATE sync_vaults SET key_checkpoints=$2,active_key_version=$3,rotation_required=false WHERE vault_id=$1",
      [pin.vaultId, JSON.stringify([...current, checkpoint]), checkpoint.keyVersion],
    );
  } else if (action === "recovery-store") {
    const r = exactObject(value, [
        "envelope",
        "signature",
      ]) as unknown as SignedRecovery,
      e = exactObject(r.envelope, [
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
    sameScope(e as unknown as TrustPin, pin);
    assertDecimal64(e.recoveryVersion, true);
    assertBase64Url(e.nonce, 24);
    assertBase64Url(e.ciphertext, undefined, 16);
    assertBase64Url(r.signature, 64);
    if (
      e.formatVersion !== 1 ||
      e.cryptoSuite !== "lp-sodium-v1" ||
      e.kdf !== "sodium-kdf-blake2b-LPRECOV1-1" ||
      !crypto.verify(
        r.signature,
        recoveryInput(r.envelope),
        pin.authorityPublicKey,
      )
    )
      throw new Error("invalid_recovery_envelope");
    if (
      vault.recovery &&
      canonicalStringify(vault.recovery) === canonicalStringify(r)
    )
      return;
    if (
      BigInt(String(e.recoveryVersion)) !==
      BigInt(vault.recovery?.envelope.recoveryVersion ?? "0") + 1n
    )
      throw new Error("recovery_version_mismatch");
    await tx.query("UPDATE sync_vaults SET recovery=$2 WHERE vault_id=$1", [
      pin.vaultId,
      r,
    ]);
  }
}
