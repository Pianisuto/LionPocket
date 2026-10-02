import { canonicalStringify } from './canonical';
import { exactObject, assertTrustPin, type ControlCrypto, type RegistryCheckpoint, type TrustPin } from './provisioning';
import { assertBase64Url, assertDecimal64, assertUuid } from './validation';

/** Preparation permission only. This is NOT an activated generation or a new TrustPin. */
export interface EpochRecoveryChallenge {
  formatVersion: 1;
  serverId: string;
  vaultId: string;
  fromEpoch: string;
  toEpoch: string;
  authorityPublicKey: string;
  restoreId: string;
  challengeId: string;
  nonce: string;
  restoredRegistry: RegistryCheckpoint;
  restoredStateSha256: string;
  /** Server deadline, informative to clients; only the server decides expiration. */
  expiresAt: number;
}
export interface EpochRecoveryAuthorization extends EpochRecoveryChallenge {
  intent: 'prepare-recovery';
  knownRegistry: RegistryCheckpoint;
  signature: string;
}
const challengeKeys = ['formatVersion', 'serverId', 'vaultId', 'fromEpoch', 'toEpoch',
  'authorityPublicKey', 'restoreId', 'challengeId', 'nonce', 'restoredRegistry', 'restoredStateSha256', 'expiresAt'];

function checkpoint(value: unknown): void {
  const row = exactObject(value, ['version', 'sha256']);
  assertDecimal64(row.version, true);
  assertBase64Url(row.sha256, 32);
}
export function assertEpochRecoveryChallenge(value: unknown): asserts value is EpochRecoveryChallenge {
  const row = exactObject(value, challengeKeys);
  for (const key of ['serverId', 'vaultId', 'fromEpoch', 'toEpoch', 'restoreId', 'challengeId']) assertUuid(row[key], '4');
  if (row.formatVersion !== 1 || row.fromEpoch === row.toEpoch ||
      !Number.isSafeInteger(row.expiresAt) || Number(row.expiresAt) < 0) throw new Error('invalid_epoch_recovery');
  for (const key of ['authorityPublicKey', 'nonce', 'restoredStateSha256']) assertBase64Url(row[key], 32);
  checkpoint(row.restoredRegistry);
}
export function assertEpochRecoveryAuthorization(value: unknown): asserts value is EpochRecoveryAuthorization {
  const row = exactObject(value, [...challengeKeys, 'intent', 'knownRegistry', 'signature']);
  const { intent, knownRegistry, signature, ...challenge } = row;
  assertEpochRecoveryChallenge(challenge);
  if (intent !== 'prepare-recovery') throw new Error('invalid_epoch_recovery');
  checkpoint(knownRegistry);
  assertBase64Url(signature, 64);
}
/** Ed25519 detached over UTF-8, no prehash. Never uses an HTTP/grant/recovery signing domain. */
export function epochRecoverySigningInput(value: Omit<EpochRecoveryAuthorization, 'signature'>): string {
  if ('signature' in value) throw new Error('Expected unsigned epoch recovery authorization.');
  assertEpochRecoveryAuthorization({ ...value, signature: 'A'.repeat(86) });
  return canonicalStringify({ context: 'LionPocket/epoch-recovery-authorization/v1', authorization: value });
}
export function verifyEpochRecoveryAuthorization(
  value: EpochRecoveryAuthorization,
  expected: { pin: TrustPin; challenge: EpochRecoveryChallenge; knownRegistry: RegistryCheckpoint },
  crypto: ControlCrypto,
): void {
  assertEpochRecoveryAuthorization(value);
  assertEpochRecoveryChallenge(expected.challenge);
  assertTrustPin(expected.pin);
  const { signature, intent, knownRegistry, ...challenge } = value;
  if (intent !== 'prepare-recovery' ||
      challenge.serverId !== expected.pin.serverId || challenge.vaultId !== expected.pin.vaultId ||
      challenge.fromEpoch !== expected.pin.serverEpoch || challenge.authorityPublicKey !== expected.pin.authorityPublicKey ||
      canonicalStringify(challenge) !== canonicalStringify(expected.challenge) ||
      canonicalStringify(knownRegistry) !== canonicalStringify(expected.knownRegistry)) throw new Error('scope_mismatch');
  if (!crypto.verify(signature, epochRecoverySigningInput({ ...challenge, intent, knownRegistry }), expected.pin.authorityPublicKey))
    throw new Error('invalid_signature');
}
