import {
  createHash,
  createPrivateKey,
  createPublicKey,
  verify,
} from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { canonicalStringify } from "./canonical";
import {
  assertEpochKeyBase,
  epochKeyBaseSigningInput,
  verifyEpochKeyBase,
  initialEnvelopesSha256,
  accumulateStagingEnvelope,
  initialStagingHeadsSha256,
  accumulateStagingHead,
} from "./epoch-staging";
const f = JSON.parse(
  readFileSync(
    new URL("../fixtures/epoch-staging.json", import.meta.url),
    "utf8",
  ),
);
const publicKey = createPublicKey(
  createPrivateKey({
    format: "der",
    type: "pkcs8",
    key: Buffer.concat([
      Buffer.from("302e020100300506032b657004220420", "hex"),
      Buffer.from(f.authoritySeed, "base64url"),
    ]),
  }),
);
const crypto = {
  hash: (v: string) => createHash("sha256").update(v).digest("base64url"),
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
describe("independent operational B cryptographic vectors", () => {
  it("verifies a dedicated key-base domain with standard Ed25519", () => {
    const { signature, ...unsigned } = f.keyBase;
    expect(epochKeyBaseSigningInput(unsigned)).toBe(f.keyBaseSigningInput);
    expect(
      verify(
        null,
        Buffer.from(f.keyBaseSigningInput),
        publicKey,
        Buffer.from(signature, "base64url"),
      ),
    ).toBe(true);
    verifyEpochKeyBase(f.keyBase, f.pin, crypto);
    for (const change of [
      { baseKeyVersion: 1 },
      { previousActiveKeyVersion: 4 },
      { formatVersion: 2 },
      { unexpected: 1 },
    ])
      expect(() => assertEpochKeyBase({ ...f.keyBase, ...change })).toThrow();
    expect(() =>
      verifyEpochKeyBase(
        {
          ...f.keyBase,
          previousKeyCheckpointsSha256: crypto.hash("different"),
        },
        f.pin,
        crypto,
      ),
    ).toThrow("invalid_signature");
  });
  it("commits exact bytes, ordinal, batch and ordered heads under distinct domains", () => {
    expect(initialEnvelopesSha256(f.scope, crypto)).toBe(f.initialEnvelopes);
    expect(
      accumulateStagingEnvelope(
        f.initialEnvelopes,
        "1",
        "1",
        f.envelopeCommitId,
        f.envelopeText,
        crypto,
      ),
    ).toBe(f.envelopeDigest);
    for (const [ordinal, batch, text] of [
      ["2", "1", f.envelopeText],
      ["1", "2", f.envelopeText],
      ["1", "1", f.envelopeText + " "],
    ])
      expect(
        accumulateStagingEnvelope(
          f.initialEnvelopes,
          ordinal,
          batch,
          f.envelopeCommitId,
          text,
          crypto,
        ),
      ).not.toBe(f.envelopeDigest);
    expect(initialStagingHeadsSha256(f.scope, crypto)).toBe(f.initialHeads);
    expect(
      accumulateStagingHead(
        f.initialHeads,
        f.head.objectId,
        f.head.revisionId,
        crypto,
      ),
    ).toBe(f.headsDigest);
    expect(crypto.hash(canonicalStringify(f.keyBase))).not.toBe(
      crypto.hash(f.keyBaseSigningInput),
    );
  });
});
