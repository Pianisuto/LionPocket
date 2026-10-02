import {
  assertEpochRecoveryChallenge, canonicalStringify, epochRecoverySigningInput, validateGrantChain,
  verifyEpochRecoveryAuthorization,
  type DeviceGrant, type EpochRecoveryAuthorization, type EpochRecoveryChallenge,
} from '@lionpocket/sync-protocol';
import { DeviceProvisioning } from './provisioning';
import { openRecovery, type SignedRecovery } from './security';
import type { TransportSodium } from './transport';

function prepare(
  device: DeviceProvisioning, challenge: EpochRecoveryChallenge, knownGrants: DeviceGrant[], confirmed: boolean,
) {
  if (confirmed !== true) throw new Error('epoch_recovery_confirmation_required');
  assertEpochRecoveryChallenge(challenge);
  const pin = device.profile.pin;
  if (challenge.serverId !== pin.serverId || challenge.vaultId !== pin.vaultId ||
      challenge.fromEpoch !== pin.serverEpoch || challenge.authorityPublicKey !== pin.authorityPublicKey)
    throw new Error('scope_mismatch');
  // Includes post-backup revocations known by this owner. Never adopt a server rollback.
  const known = validateGrantChain(knownGrants, pin, device.crypto, challenge.restoredRegistry);
  return { ...challenge, intent: 'prepare-recovery' as const, knownRegistry: known.checkpoint };
}
/** No profile, binding, secret, SQLite or outbox mutation. Native UX must not treat this as reconnection. */
export async function authorizeEpochRecovery(
  device: DeviceProvisioning, challenge: EpochRecoveryChallenge, confirmed: boolean,
): Promise<EpochRecoveryAuthorization> {
  const unsigned = prepare(device, challenge, device.profile.grants, confirmed);
  validateGrantChain(device.profile.grants, device.profile.pin, device.crypto, device.profile.checkpoint);
  const seed = await device.secrets.load(device.scope('authoritySeed'));
  if (!seed) throw new Error('authority_secret_unavailable');
  try {
    const result = { ...unsigned, signature: device.crypto.sign(epochRecoverySigningInput(unsigned), seed) };
    verifyEpochRecoveryAuthorization(result, { pin: device.profile.pin, challenge, knownRegistry: unsigned.knownRegistry }, device.crypto);
    return result;
  } finally { device.crypto.erase(seed); }
}
/** Recovery proves the old authority; login alone or a paired device's signing key cannot do this.
 * This intentionally does not store seeds or create an operational device in the new epoch. */
export function authorizeEpochRecoveryWithCode(
  device: DeviceProvisioning, sodium: TransportSodium, challenge: EpochRecoveryChallenge,
  restoredGrants: DeviceGrant[], recovery: SignedRecovery, code: string, confirmed: boolean,
): EpochRecoveryAuthorization {
  const unsigned = prepare(device, challenge, restoredGrants, confirmed);
  if (canonicalStringify(unsigned.knownRegistry) !== canonicalStringify(challenge.restoredRegistry)) throw new Error('registry_order');
  const bundle = openRecovery(device, sodium, recovery, code);
  const seed = device.crypto.decode(bundle.authoritySignSeed);
  try {
    const result = { ...unsigned, signature: device.crypto.sign(epochRecoverySigningInput(unsigned), seed) };
    verifyEpochRecoveryAuthorization(result, { pin: device.profile.pin, challenge, knownRegistry: unsigned.knownRegistry }, device.crypto);
    return result;
  } finally { device.crypto.erase(seed); }
}
