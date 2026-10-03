import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
  verify,
} from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalStringify } from "./canonical";
import {
  assertEpochActivationRequest,
  epochActivationSigningInput,
  verifyEpochActivationRequest,
} from "./epoch-activation";
const privateKey = createPrivateKey({
  format: "der",
  type: "pkcs8",
  key: Buffer.concat([
    Buffer.from("302e020100300506032b657004220420", "hex"),
    Buffer.alloc(32, 7),
  ]),
});
const publicKey = createPublicKey(privateKey),
  raw = publicKey
    .export({ format: "der", type: "spki" })
    .subarray(-32)
    .toString("base64url");
const crypto = {
  hash: (text: string) => createHash("sha256").update(text).digest("base64url"),
  verify: (signature: string, text: string, key: string) =>
    verify(
      null,
      Buffer.from(text),
      createPublicKey({
        format: "der",
        type: "spki",
        key: Buffer.concat([
          Buffer.from("302a300506032b6570032100", "hex"),
          Buffer.from(key, "base64url"),
        ]),
      }),
      Buffer.from(signature, "base64url"),
    ),
};
describe("explicit activation domain and canonical intention", () => {
  it("verifies standard Ed25519 and rejects every changed commitment or extra identity", () => {
    const unsigned = {
      formatVersion: 1 as const,
      activationId: "11111111-1111-4111-8111-111111111111",
      serverId: "22222222-2222-4222-8222-222222222222",
      vaultId: "33333333-3333-4333-8333-333333333333",
      restoreId: "44444444-4444-4444-8444-444444444444",
      fromEpoch: "55555555-5555-4555-8555-555555555555",
      toEpoch: "66666666-6666-4666-8666-666666666666",
      anchorDeviceId: "77777777-7777-4777-8777-777777777777",
      manifestSha256: crypto.hash("manifest"),
      transitionSha256: crypto.hash("transition"),
    };
    const input = epochActivationSigningInput(unsigned);
    expect(JSON.parse(input).context).toBe(
      "LionPocket/epoch-activation-request/v1",
    );
    const request = {
      ...unsigned,
      signature: sign(null, Buffer.from(input), privateKey).toString(
        "base64url",
      ),
    };
    verifyEpochActivationRequest(request, raw, crypto);
    expect(() =>
      verifyEpochActivationRequest(
        { ...request, manifestSha256: crypto.hash("different") },
        raw,
        crypto,
      ),
    ).toThrow("invalid_signature");
    expect(() =>
      verifyEpochActivationRequest(
        { ...request, activationId: unsigned.restoreId },
        raw,
        crypto,
      ),
    ).toThrow("invalid_signature");
    expect(() =>
      assertEpochActivationRequest({ ...request, timestamp: 123 }),
    ).toThrow();
    expect(() =>
      assertEpochActivationRequest({ ...request, formatVersion: 2 }),
    ).toThrow();
    expect(() =>
      assertEpochActivationRequest({ ...request, toEpoch: unsigned.fromEpoch }),
    ).toThrow();
    expect(crypto.hash(canonicalStringify(request))).not.toBe(
      crypto.hash(input),
    );
  });
});
