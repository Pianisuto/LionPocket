import { canonicalStringify } from './canonical';
import { assertEpochRecoveryAuthorization, verifyEpochRecoveryAuthorization, type EpochRecoveryAuthorization } from './epoch-recovery';
import { assertTrustPin, exactObject, type ControlCrypto, type TrustPin } from './provisioning';
import { assertBase64Url, assertDecimal64, assertUuid } from './validation';

/** Public commitments only. Financial snapshots, keys and recovery codes never belong here. */
export interface EpochBaselineManifest {
  formatVersion: 1;
  serverId: string;
  vaultId: string;
  serverEpoch: string;
  restoreId: string;
  anchorDeviceId: string;
  authorizationSha256: string;
  registrySha256: string;
  keyCheckpointSha256: string;
  recoverySha256: string;
  archiveSha256: string;
  mappingSha256: string;
  /** Decimal int64, including counts above the JS safe integer limit. */
  commitCount: string;
  operationCount: string;
  batchCount: string;
  envelopesSha256: string;
  headsSha256: string;
}
export interface EpochTransition {
  formatVersion: 1;
  serverId: string;
  vaultId: string;
  fromEpoch: string;
  toEpoch: string;
  restoreId: string;
  authorityPublicKey: string;
  authorizationSha256: string;
  restoredStateSha256: string;
  manifestSha256: string;
  trustPinSha256: string;
  registrySha256: string;
  keyCheckpointSha256: string;
  recoverySha256: string;
  archiveSha256: string;
  mappingSha256: string;
  previousTransitionSha256: string | null;
  signature: string;
}
const commitments = ['authorizationSha256', 'registrySha256', 'keyCheckpointSha256',
  'recoverySha256', 'archiveSha256', 'mappingSha256'] as const;
const manifestKeys = ['formatVersion', 'serverId', 'vaultId', 'serverEpoch', 'restoreId',
  'anchorDeviceId', ...commitments, 'commitCount', 'operationCount', 'batchCount', 'envelopesSha256', 'headsSha256'];
const transitionKeys = ['formatVersion', 'serverId', 'vaultId', 'fromEpoch', 'toEpoch', 'restoreId',
  'authorityPublicKey', ...commitments, 'restoredStateSha256', 'manifestSha256', 'trustPinSha256',
  'previousTransitionSha256', 'signature'];
export function assertEpochBaselineManifest(value: unknown): asserts value is EpochBaselineManifest {
  const row = exactObject(value, manifestKeys);
  if (row.formatVersion !== 1) throw new Error('invalid_epoch_manifest');
  for (const key of ['serverId', 'vaultId', 'serverEpoch', 'restoreId', 'anchorDeviceId']) assertUuid(row[key], '4');
  for (const key of [...commitments, 'envelopesSha256', 'headsSha256']) assertBase64Url(row[key], 32);
  for (const key of ['commitCount', 'operationCount', 'batchCount']) assertDecimal64(row[key]);
  if ((row.commitCount === '0') !== (row.operationCount === '0') ||
      (row.commitCount === '0') !== (row.batchCount === '0') ||
      BigInt(String(row.batchCount)) > BigInt(String(row.commitCount)) ||
      BigInt(String(row.commitCount)) > BigInt(String(row.operationCount))) throw new Error('invalid_epoch_manifest');
}
export function epochBaselineManifestInput(value: EpochBaselineManifest): string {
  assertEpochBaselineManifest(value);
  return canonicalStringify({ context: 'LionPocket/epoch-baseline-manifest/v1', manifest: value });
}
export function assertEpochTransition(value: unknown): asserts value is EpochTransition {
  const row = exactObject(value, transitionKeys);
  if (row.formatVersion !== 1 || row.fromEpoch === row.toEpoch) throw new Error('invalid_epoch_transition');
  for (const key of ['serverId', 'vaultId', 'fromEpoch', 'toEpoch', 'restoreId']) assertUuid(row[key], '4');
  for (const key of [...commitments, 'authorityPublicKey', 'restoredStateSha256', 'manifestSha256', 'trustPinSha256'])
    assertBase64Url(row[key], 32);
  if (row.previousTransitionSha256 !== null) assertBase64Url(row.previousTransitionSha256, 32);
  assertBase64Url(row.signature, 64);
}
/** Separate final authority proof. Preparation authorization cannot be substituted for this signature. */
export function epochTransitionSigningInput(value: Omit<EpochTransition, 'signature'>): string {
  if ('signature' in value) throw new Error('Expected unsigned epoch transition.');
  assertEpochTransition({ ...value, signature: 'A'.repeat(86) });
  return canonicalStringify({ context: 'LionPocket/epoch-transition/v1', transition: value });
}
export function epochTransitionDigest(value: EpochTransition, crypto: ControlCrypto): string {
  assertEpochTransition(value);
  return crypto.hash(canonicalStringify({ context: 'LionPocket/epoch-transition-chain/v1', transition: value }));
}
/** Verifies the final signature and artifact commitments, not artifact semantics or activation readiness.
 * Caller must independently validate registry/key/recovery envelopes, staging and graph completeness.
 * Caller supplies trusted A and the already-verified chain tip, never a server-selected authority. */
export function verifyEpochTransition(value: EpochTransition, expected: {
  fromPin: TrustPin;
  toPin: TrustPin;
  authorization: EpochRecoveryAuthorization;
  manifest: EpochBaselineManifest;
  registry: unknown;
  keyCheckpoint: unknown;
  recovery: unknown;
  previousTransition: EpochTransition | null;
}, crypto: ControlCrypto): void {
  assertEpochTransition(value);
  assertEpochBaselineManifest(expected.manifest);
  assertEpochRecoveryAuthorization(expected.authorization);
  assertTrustPin(expected.fromPin);
  assertTrustPin(expected.toPin);
  const a = expected.authorization, m = expected.manifest, pin = expected.fromPin, next = expected.toPin;
  const { signature: authorizationSignature, intent, knownRegistry, ...challenge } = a;
  void authorizationSignature; void intent;
  verifyEpochRecoveryAuthorization(a, { pin, challenge, knownRegistry }, crypto);
  const hash = (v: unknown) => crypto.hash(canonicalStringify(v));
  const previous = expected.previousTransition;
  if (previous) {
    assertEpochTransition(previous);
    const { signature, ...unsigned } = previous;
    if (previous.serverId !== pin.serverId || previous.vaultId !== pin.vaultId ||
        previous.toEpoch !== pin.serverEpoch || previous.authorityPublicKey !== pin.authorityPublicKey ||
        !crypto.verify(signature, epochTransitionSigningInput(unsigned), pin.authorityPublicKey))
      throw new Error('epoch_transition_chain_required');
  }
  if (value.serverId !== pin.serverId || value.vaultId !== pin.vaultId || value.fromEpoch !== pin.serverEpoch ||
      value.toEpoch !== a.toEpoch || value.restoreId !== a.restoreId || value.authorityPublicKey !== pin.authorityPublicKey ||
      next.serverId !== pin.serverId || next.vaultId !== pin.vaultId || next.serverEpoch !== value.toEpoch ||
      next.authorityPublicKey !== pin.authorityPublicKey || next.founderDeviceId === pin.founderDeviceId ||
      m.serverId !== next.serverId || m.vaultId !== next.vaultId || m.serverEpoch !== next.serverEpoch ||
      m.restoreId !== a.restoreId || m.anchorDeviceId !== next.founderDeviceId ||
      value.authorizationSha256 !== hash(a) || m.authorizationSha256 !== hash(a) ||
      value.restoredStateSha256 !== a.restoredStateSha256 || value.trustPinSha256 !== hash(next) ||
      value.manifestSha256 !== crypto.hash(epochBaselineManifestInput(m)) ||
      value.previousTransitionSha256 !== (previous ? epochTransitionDigest(previous, crypto) : null))
    throw new Error('epoch_transition_mismatch');
  for (const field of commitments) if (value[field] !== m[field]) throw new Error('epoch_transition_mismatch');
  if (m.registrySha256 !== hash(expected.registry) || m.keyCheckpointSha256 !== hash(expected.keyCheckpoint) ||
      m.recoverySha256 !== hash(expected.recovery)) throw new Error('epoch_transition_mismatch');
  const { signature, ...unsigned } = value;
  if (!crypto.verify(signature, epochTransitionSigningInput(unsigned), pin.authorityPublicKey)) throw new Error('invalid_signature');
}
