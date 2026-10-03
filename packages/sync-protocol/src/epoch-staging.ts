import { canonicalStringify } from "./canonical";
import { assertBase64Url, assertDecimal64, assertUuid } from "./validation";
import {
  assertKeyVersion,
  exactObject,
  sameScope,
  type ControlCrypto,
  type TrustPin,
} from "./provisioning";
import type { EpochRecoveryAuthorization } from "./epoch-recovery";
import type { DeviceGrant, RecoveryEnvelope } from "./types";

/** A generation's key genesis is distinct from a rotation checkpoint. No DEK is public. */
export interface EpochKeyBase {
  formatVersion: 1;
  serverId: string;
  serverEpoch: string;
  vaultId: string;
  restoreId: string;
  fromEpoch: string;
  baseKeyVersion: number;
  previousActiveKeyVersion: number;
  previousKeyCheckpointsSha256: string;
  signature: string;
}
export function assertEpochKeyBase(
  value: unknown,
): asserts value is EpochKeyBase {
  const r = exactObject(value, [
    "formatVersion",
    "serverId",
    "serverEpoch",
    "vaultId",
    "restoreId",
    "fromEpoch",
    "baseKeyVersion",
    "previousActiveKeyVersion",
    "previousKeyCheckpointsSha256",
    "signature",
  ]);
  if (r.formatVersion !== 1 || r.serverEpoch === r.fromEpoch)
    throw new Error("invalid_key_base");
  for (const k of [
    "serverId",
    "serverEpoch",
    "vaultId",
    "restoreId",
    "fromEpoch",
  ])
    assertUuid(r[k], "4");
  assertKeyVersion(r.baseKeyVersion);
  assertKeyVersion(r.previousActiveKeyVersion);
  if (r.baseKeyVersion !== r.previousActiveKeyVersion + 1)
    throw new Error("key_version_mismatch");
  assertBase64Url(r.previousKeyCheckpointsSha256, 32);
  assertBase64Url(r.signature, 64);
}
export function epochKeyBaseSigningInput(
  value: Omit<EpochKeyBase, "signature">,
): string {
  if ("signature" in value) throw new Error("Expected unsigned key base.");
  assertEpochKeyBase({ ...value, signature: "A".repeat(86) });
  return canonicalStringify({
    context: "LionPocket/epoch-key-base/v1",
    keyBase: value,
  });
}
export function verifyEpochKeyBase(
  value: EpochKeyBase,
  pin: TrustPin,
  crypto: ControlCrypto,
) {
  assertEpochKeyBase(value);
  sameScope(value, pin);
  if (value.baseKeyVersion !== pin.keyVersion)
    throw new Error("key_version_mismatch");
  const { signature, ...unsigned } = value;
  if (
    !crypto.verify(
      signature,
      epochKeyBaseSigningInput(unsigned),
      pin.authorityPublicKey,
    )
  )
    throw new Error("invalid_signature");
}
export interface StagingBegin {
  recoveryConfirmed: true;
  authorization: EpochRecoveryAuthorization;
  pin: TrustPin;
  registry: DeviceGrant[];
  keyBase: EpochKeyBase;
  knownKeyCheckpoints: unknown[];
  previousRecovery: { envelope: RecoveryEnvelope; signature: string } | null;
  recovery: { envelope: RecoveryEnvelope; signature: string };
  archiveSha256: string;
  mappingSha256: string;
  operationCount: string;
  headsSha256: string;
}
export const stagingLimits = Object.freeze({
  commitsPerBatch: 100,
  operationsPerBatch: 1000,
  requestBytes: 4194304,
  maxBatches: 100000,
});
export interface StagingBatch {
  batchOrdinal: string;
  firstOrdinal: string;
  lastOrdinal: string;
  envelopes: string[];
}
export type StagingAction =
  "begin" | "batch" | "validate" | "prepare" | "status";
export interface EpochStagingRequest {
  formatVersion: 1;
  vaultId: string;
  restoreId: string;
  action: StagingAction;
  payload: unknown;
  signature: string;
}
export function epochStagingSigningInput(
  value: Omit<EpochStagingRequest, "signature">,
) {
  if ("signature" in value)
    throw new Error("Expected unsigned staging request.");
  exactObject(value, [
    "formatVersion",
    "vaultId",
    "restoreId",
    "action",
    "payload",
  ]);
  assertUuid(value.vaultId, "4");
  assertUuid(value.restoreId, "4");
  if (
    value.formatVersion !== 1 ||
    !["begin", "batch", "validate", "prepare", "status"].includes(value.action)
  )
    throw new Error("invalid_staging");
  return canonicalStringify({
    context: "LionPocket/epoch-staging-request/v1",
    request: value,
  });
}
export function verifyEpochStagingRequest(
  value: unknown,
  publicKey: string,
  crypto: ControlCrypto,
): asserts value is EpochStagingRequest {
  const r = exactObject(value, [
    "formatVersion",
    "vaultId",
    "restoreId",
    "action",
    "payload",
    "signature",
  ]) as unknown as EpochStagingRequest;
  assertBase64Url(r.signature, 64);
  const { signature, ...unsigned } = r;
  if (!crypto.verify(signature, epochStagingSigningInput(unsigned), publicKey))
    throw new Error("invalid_signature");
}
export interface StagingScope {
  restoreId: string;
  vaultId: string;
  fromEpoch: string;
  toEpoch: string;
}
export function initialEnvelopesSha256(
  scope: StagingScope,
  crypto: ControlCrypto,
) {
  return crypto.hash(
    canonicalStringify({
      context: "LionPocket/epoch-staging-envelopes/v1",
      ...scope,
    }),
  );
}
export function accumulateStagingEnvelope(
  previousSha256: string,
  ordinal: string,
  batchOrdinal: string,
  commitId: string,
  envelopeText: string,
  crypto: ControlCrypto,
) {
  assertDecimal64(ordinal, true);
  assertDecimal64(batchOrdinal, true);
  assertUuid(commitId, "4");
  return crypto.hash(
    canonicalStringify({
      context: "LionPocket/epoch-staging-envelope-entry/v1",
      previousSha256,
      ordinal,
      batchOrdinal,
      commitId,
      envelopeText,
    }),
  );
}
export function initialStagingHeadsSha256(
  scope: StagingScope,
  crypto: ControlCrypto,
) {
  return crypto.hash(
    canonicalStringify({
      context: "LionPocket/epoch-baseline-heads/v1",
      ...scope,
    }),
  );
}
export function accumulateStagingHead(
  previousSha256: string,
  objectId: string,
  revisionId: string,
  crypto: ControlCrypto,
) {
  return crypto.hash(
    canonicalStringify({
      context: "LionPocket/epoch-baseline-head-entry/v1",
      previousSha256,
      objectId,
      revisionId,
    }),
  );
}
