import { canonicalStringify } from "./canonical";
import { exactObject, type ControlCrypto } from "./provisioning";
import { assertBase64Url, assertDecimal64, assertUuid } from "./validation";

/** An explicit, durable owner intention, signed with the prepared anchor's new key. */
export interface EpochActivationRequest {
  formatVersion: 1;
  activationId: string;
  serverId: string;
  vaultId: string;
  restoreId: string;
  fromEpoch: string;
  toEpoch: string;
  anchorDeviceId: string;
  manifestSha256: string;
  transitionSha256: string;
  signature: string;
}
export interface EpochActivationRecord extends Omit<
  EpochActivationRequest,
  "signature"
> {
  requestSha256: string;
  trustPinSha256: string;
  logPosition: string;
  commitCount: string;
  operationCount: string;
}
export type EpochActivationStatus =
  | { state: "prepared" | "mismatch" }
  | { state: "active"; activation: EpochActivationRecord };
const keys = [
  "formatVersion",
  "activationId",
  "serverId",
  "vaultId",
  "restoreId",
  "fromEpoch",
  "toEpoch",
  "anchorDeviceId",
  "manifestSha256",
  "transitionSha256",
];
export function assertEpochActivationRequest(
  value: unknown,
): asserts value is EpochActivationRequest {
  const row = exactObject(value, [...keys, "signature"]);
  if (row.formatVersion !== 1 || row.fromEpoch === row.toEpoch)
    throw new Error("invalid_epoch_activation");
  for (const key of [
    "activationId",
    "serverId",
    "vaultId",
    "restoreId",
    "fromEpoch",
    "toEpoch",
    "anchorDeviceId",
  ])
    assertUuid(row[key], "4");
  for (const key of ["manifestSha256", "transitionSha256"])
    assertBase64Url(row[key], 32);
  assertBase64Url(row.signature, 64);
}
export function epochActivationSigningInput(
  value: Omit<EpochActivationRequest, "signature">,
): string {
  if ("signature" in value)
    throw new Error("Expected unsigned epoch activation.");
  assertEpochActivationRequest({ ...value, signature: "A".repeat(86) });
  return canonicalStringify({
    context: "LionPocket/epoch-activation-request/v1",
    request: value,
  });
}
export function verifyEpochActivationRequest(
  value: EpochActivationRequest,
  key: string,
  crypto: ControlCrypto,
): void {
  assertEpochActivationRequest(value);
  const { signature, ...unsigned } = value;
  if (!crypto.verify(signature, epochActivationSigningInput(unsigned), key))
    throw new Error("invalid_signature");
}
/** This commitment is evidence only alongside the independently verified local transition and pin. */
export function assertEpochActivationRecord(
  value: unknown,
): asserts value is EpochActivationRecord {
  const row = exactObject(value, [
    ...keys,
    "requestSha256",
    "trustPinSha256",
    "logPosition",
    "commitCount",
    "operationCount",
  ]);
  assertEpochActivationRequest({
    ...Object.fromEntries(keys.map((k) => [k, row[k]])),
    signature: "A".repeat(86),
  });
  for (const key of ["requestSha256", "trustPinSha256"])
    assertBase64Url(row[key], 32);
  for (const key of ["logPosition", "commitCount", "operationCount"])
    assertDecimal64(row[key]);
  if (
    row.logPosition !== row.commitCount ||
    BigInt(String(row.operationCount)) < BigInt(String(row.commitCount))
  )
    throw new Error("invalid_epoch_activation");
}
