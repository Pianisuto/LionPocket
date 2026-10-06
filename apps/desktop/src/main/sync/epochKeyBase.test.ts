import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import sodium from "libsodium-wrappers-sumo";
import {
  DeviceProvisioning,
  ProvisioningCrypto,
  makeRecovery,
  openRecovery,
  makeKeyCheckpoint,
  acceptKeyCheckpoints,
  validateKeyCheckpoints,
} from "@lionpocket/sync-local";
import {
  assertKeyBundle,
  assertTrustPin,
  baseKeyVersion,
  canonicalStringify,
  encodeUtf8,
  recoveryAssociatedData,
  validateEpochDataKeys,
} from "@lionpocket/sync-protocol";
import { founder, TestSecrets } from "../../../../sync-server/src/testSupport";
beforeAll(() => sodium.ready);
describe("key base belongs to a generation", () => {
  it("opens the deterministic RecoveryBundle v2 vector independently with sodium AEAD", () => {
    const vector = JSON.parse(
      readFileSync(
        new URL(
          "../../../../../packages/sync-protocol/fixtures/epoch-staging.json",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    const clean = new DeviceProvisioning(
      {
        formatVersion: 1,
        installationId: vector.pin.founderDeviceId,
        pin: vector.pin,
        deviceId: vector.pin.founderDeviceId,
        signingPublicKey: vector.pin.authorityPublicKey,
        boxPublicKey: vector.pin.authorityPublicKey,
        grants: [],
      },
      new TestSecrets(),
      new ProvisioningCrypto(sodium),
    );
    expect(openRecovery(clean, sodium, vector.recovery, vector.code)).toEqual(
      vector.bundle,
    );
  });
  it.each([1, 4, 20])(
    "rotates and pairs at base %i without keys from earlier epochs",
    async (base) => {
      const { client: a } = await founder(new ProvisioningCrypto(sodium));
      // Isolated domain fixture: a new generation with a fresh founder, not a mutation of an active binding.
      a.profile.pin.keyVersion = base;
      if (base !== 1) {
        const fresh = sodium.randombytes_buf(32);
        await a.secrets.store(a.scope("dataKey", base), fresh);
        fresh.fill(0);
        await a.secrets.remove(a.scope("dataKey", 1));
      }
      a.profile.activeKeyVersion = base;
      expect(baseKeyVersion(a.profile.pin)).toBe(base);
      const checkpoints = [];
      for (let i = 1; i <= 2; i++) {
        const checkpoint = await makeKeyCheckpoint(a);
        expect(checkpoint.keyVersion).toBe(base + i);
        checkpoints.push(checkpoint);
        await acceptKeyCheckpoints(a, {
          pin: a.profile.pin,
          grants: a.profile.grants,
          delivery: null,
          keyCheckpoints: checkpoints,
        });
      }
      const b = await DeviceProvisioning.prepare(
          a.profile.pin,
          new TestSecrets(),
          a.crypto,
        ),
        request = await b.request();
      const grant = await a.grant(request);
      a.acceptRegistry({
        pin: a.profile.pin,
        grants: [...a.profile.grants, grant],
        delivery: null,
      });
      const delivery = await a.delivery(b.profile.deviceId);
      expect(delivery.keyVersion).toBe(base + 2);
      await b.receive({
        pin: a.profile.pin,
        grants: a.profile.grants,
        delivery,
        keyCheckpoints: checkpoints,
      });
      await acceptKeyCheckpoints(b, {
        pin: a.profile.pin,
        grants: a.profile.grants,
        delivery: null,
        keyCheckpoints: checkpoints,
      });
      const r = await makeRecovery(a, sodium, "9007199254740993"),
        bundle = openRecovery(a, sodium, r.recovery, r.code);
      expect(bundle.formatVersion).toBe(base === 1 ? 1 : 2);
      expect(bundle.dataKeys.map((k) => k.keyVersion)).toEqual([
        base,
        base + 1,
        base + 2,
      ]);
      for (const k of bundle.dataKeys)
        expect(await b.secrets.load(b.scope("dataKey", k.keyVersion))).toEqual(
          await a.secrets.load(a.scope("dataKey", k.keyVersion)),
        );
      if (base > 1)
        expect(await b.secrets.load(b.scope("dataKey", 1))).toBeNull();
      expect(
        validateKeyCheckpoints([], a.profile.pin, a.profile.grants, a),
      ).toBe(base);
    },
  );
  it("compares received keys to an authority checkpoint addressed to this device", async () => {
    const { client: a } = await founder(new ProvisioningCrypto(sodium));
    const b = await DeviceProvisioning.prepare(
        a.profile.pin,
        new TestSecrets(),
        a.crypto,
      ),
      request = await b.request();
    const grant = await a.grant(request);
    a.acceptRegistry({
      pin: a.profile.pin,
      grants: [...a.profile.grants, grant],
      delivery: null,
    });
    const checkpoint = await makeKeyCheckpoint(a);
    const response = {
      pin: a.profile.pin,
      grants: a.profile.grants,
      delivery: null,
      keyCheckpoints: [checkpoint],
    };
    await acceptKeyCheckpoints(a, response);
    await b.receive({
      ...response,
      delivery: await a.delivery(b.profile.deviceId),
    });
    const wrong = sodium.randombytes_buf(32);
    await b.secrets.store(b.scope("dataKey", 2), wrong);
    wrong.fill(0);
    await expect(acceptKeyCheckpoints(b, response)).rejects.toThrow(
      "key_mismatch",
    );
  });
  it("reads current recovery bundle formats and rejects mixed fields", async () => {
    const { client: a } = await founder(new ProvisioningCrypto(sodium));
    const r = await makeRecovery(a, sodium, "1");
    const bundle = openRecovery(a, sodium, r.recovery, r.code);
    if (bundle.formatVersion !== 1) throw new Error("fixture");
    const baseOne = bundle;
    const modern = { ...bundle, formatVersion: 2, baseKeyVersion: 1 };
    const master = a.crypto.decode(r.code.slice(4)),
      key = sodium.crypto_kdf_derive_from_key(32, 1, "LPRECOV1", master);
    const { ciphertext, ...header } = r.recovery.envelope;
    void ciphertext;
    const encrypt = (content: unknown) => {
      const envelope = {
        ...header,
        ciphertext: a.crypto.encode(
          sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
            encodeUtf8(canonicalStringify(content)),
            recoveryAssociatedData(header),
            null,
            a.crypto.decode(header.nonce),
            key,
          ),
        ),
      };
      return envelope;
    };
    const authority = await a.secrets.load(a.scope("authoritySeed"));
    if (!authority) throw new Error("fixture");
    const { recoveryInput } = await import("@lionpocket/sync-local");
    const signed = (content: unknown) => {
      const envelope = encrypt(content);
      return {
        envelope,
        signature: a.crypto.sign(recoveryInput(envelope), authority),
      };
    };
    try {
      expect(
        openRecovery(a, sodium, signed(baseOne), r.code).formatVersion,
      ).toBe(1);
      expect(() =>
        openRecovery(
          a,
          sodium,
          signed({ ...baseOne, baseKeyVersion: 1 }),
          r.code,
        ),
      ).toThrow();
      expect(() =>
        openRecovery(
          a,
          sodium,
          signed({ ...modern, baseKeyVersion: 2 }),
          r.code,
        ),
      ).toThrow();
    } finally {
      master.fill(0);
      key.fill(0);
      authority.fill(0);
    }
    expect(() => assertTrustPin({ ...a.profile.pin, keyVersion: 0 })).toThrow();
    expect(() =>
      assertKeyBundle({ formatVersion: 2, ...a.profile.pin }),
    ).toThrow();
    expect(() =>
      validateEpochDataKeys(
        [{ keyVersion: 4, vaultKey: a.crypto.nonce() }],
        1,
        4,
      ),
    ).toThrow("invalid_data_keys");
  });
});
