import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import sodium from "libsodium-wrappers-sumo";
import {
  requestAnchorActivation,
  resumeAnchorActivation,
  type AnchorActivationOptions,
  DeviceProvisioning,
  ProvisioningCrypto,
  authorizeEpochRecovery,
  prepareAnchorArchive,
  planAnchorBaseline,
  startFinancialBaseline,
  syncTables,
  financialTableTypes,
  prepareOperationalB,
  confirmOperationalBRecovery,
  stageOperationalB,
  cancelOperationalB,
  resumeOperationalB,
  cancelAnchorPlan,
  epochPreparationSecretScope,
  secretContext,
  type SecretStore,
  operationalBSchema,
  makeRecovery,
  openRecovery,
  incrementDecimal64,
  projectObject,
  sql,
  type SqlWorkflow,
} from "@lionpocket/sync-local";
import {
  canonicalStringify,
  decodeCommit,
  decodeCanonical,
  encodeUtf8,
  operationAssociatedData,
  type EpochRecoveryChallenge,
  type EpochStagingRequest,
} from "@lionpocket/sync-protocol";
import { founder, TestSecrets } from "../../../../sync-server/src/testSupport";
import { DesktopSecretStore } from "./secretStore";
vi.mock("electron", async () => {
  const { createCipheriv, createDecipheriv, randomBytes } =
    await import("node:crypto");
  const key = randomBytes(32);
  return {
    safeStorage: {
      isEncryptionAvailable: () => true,
      getSelectedStorageBackend: () => "gnome_libsecret",
      encryptString: (text: string) => {
        const iv = randomBytes(12),
          cipher = createCipheriv("aes-256-gcm", key, iv);
        return Buffer.concat([
          iv,
          cipher.update(text),
          cipher.final(),
          cipher.getAuthTag(),
        ]);
      },
      decryptString: (bytes: Buffer) => {
        const cipher = createDecipheriv(
          "aes-256-gcm",
          key,
          bytes.subarray(0, 12),
        );
        cipher.setAuthTag(bytes.subarray(-16));
        return Buffer.concat([
          cipher.update(bytes.subarray(12, -16)),
          cipher.final(),
        ]).toString();
      },
    },
  };
});
import { LionPocketDatabase } from "../database";
import {
  inspectEpochActivationCheckpoint,
  createEpochAnchorBackup,
  inspectEpochAnchorBackup,
} from "./epochBackup";
import { sqliteTestConnection } from "../../../../mobile/src/db/sqliteTestConnection";
import { migrate } from "../../../../mobile/src/db/migrations";
import { mobileSyncDatabase } from "../../../../mobile/src/sync/database";
import { MobileRepository } from "../../../../mobile/src/db/repository";
import {
  verifyBaselineReplay,
  type BaselineOperation,
} from "../../../../../packages/sync-local/src/epoch-replay";
const dispose: Array<() => void> = [];
beforeAll(() => sodium.ready);
afterEach(() => {
  for (const close of dispose.splice(0).reverse()) close();
});
const input = {
  kind: "expense" as const,
  description: "C1_ARCHIVE_PRIVATE_CANARY",
  plannedAmount: 12.34,
  dueDate: "2026-10-02",
  status: "planned" as const,
};
async function fixture(
  dialect: "desktop" | "android" = "desktop",
  durableSecrets = false,
) {
  const directory = mkdtempSync(join(tmpdir(), "lp-anchor-archive-test-"));
  dispose.push(() => rmSync(directory, { force: true, recursive: true }));
  let crypto = new ProvisioningCrypto(sodium);
  const founded = await founder(
    crypto,
    undefined,
    durableSecrets
      ? new DesktopSecretStore(join(directory, "secret-wrappers"))
      : undefined,
  );
  let client = founded.client;
  let bank =
    dialect === "desktop"
      ? new LionPocketDatabase(join(directory, "anchor.sqlite"))
      : null;
  let mobile =
    dialect === "android"
      ? sqliteTestConnection(join(directory, "anchor.sqlite"))
      : null;
  if (mobile) await migrate(mobile.db);
  let sqlite = bank?.db ?? mobile!.sqlite;
  dispose.push(() => sqlite.close());
  sqlite.exec(
    "DELETE FROM categories; DELETE FROM payment_methods; DELETE FROM cards;",
  );
  let db = bank?.syncDatabase() ?? mobileSyncDatabase(mobile!.db);
  let repo = mobile ? new MobileRepository(mobile.db, randomUUID) : null;
  const save = async (description: string) =>
    bank
      ? bank.saveTransaction({ ...input, description })
      : repo!.save({ ...input, description });
  await save(input.description);
  await db.run(
    startFinancialBaseline(
      client.profile,
      "https://fixture.invalid",
      "/fixture/before-binding.sqlite",
      randomUUID,
    ),
  );
  await save("C2_AFTER_SERVER_BACKUP");
  const challenge: EpochRecoveryChallenge = {
    formatVersion: 1,
    serverId: client.profile.pin.serverId,
    vaultId: client.profile.pin.vaultId,
    fromEpoch: client.profile.pin.serverEpoch,
    toEpoch: randomUUID(),
    authorityPublicKey: client.profile.pin.authorityPublicKey,
    restoreId: randomUUID(),
    challengeId: randomUUID(),
    nonce: crypto.nonce(),
    restoredRegistry: client.profile.checkpoint!,
    restoredStateSha256: crypto.hash("synthetic server snapshot C1"),
    expiresAt: 1790942400000,
  };
  const acceptedAuthorization = await authorizeEpochRecovery(
    client,
    challenge,
    true,
  );
  const prepare = (
    overrides: Partial<Parameters<typeof prepareAnchorArchive>[0]> = {},
  ) =>
    prepareAnchorArchive({
      db,
      device: client,
      acceptedAuthorization,
      confirmed: true,
      backup: () =>
        createEpochAnchorBackup(
          sqlite,
          join(directory, randomUUID() + ".sqlite"),
        ),
      inspectBackup: inspectEpochAnchorBackup,
      ...overrides,
    });
  const snapshot = () =>
    Object.fromEntries(
      [...syncTables, ...Object.keys(financialTableTypes)].map((t) => [
        t,
        sqlite.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all(),
      ]),
    );
  return {
    get client() {
      return client;
    },
    get sqlite() {
      return sqlite;
    },
    get db() {
      return db;
    },
    restart: async (secrets?: SecretStore) => {
      const profile = JSON.parse(
        String(
          sqlite
            .prepare(
              "SELECT profile_a_json FROM recovery_journal WHERE restore_id=?",
            )
            .get(acceptedAuthorization.restoreId)!.profile_a_json,
        ),
      );
      sqlite.close();
      bank =
        dialect === "desktop"
          ? new LionPocketDatabase(join(directory, "anchor.sqlite"))
          : null;
      mobile =
        dialect === "android"
          ? sqliteTestConnection(join(directory, "anchor.sqlite"))
          : null;
      if (mobile) await migrate(mobile.db);
      sqlite = bank?.db ?? mobile!.sqlite;
      db = bank?.syncDatabase() ?? mobileSyncDatabase(mobile!.db);
      repo = mobile ? new MobileRepository(mobile.db, randomUUID) : null;
      crypto = new ProvisioningCrypto(sodium);
      client = new DeviceProvisioning(
        profile,
        secrets ?? new DesktopSecretStore(join(directory, "secret-wrappers")),
        crypto,
      );
      return {
        db,
        deviceA: client,
        sodium,
        restoreId: acceptedAuthorization.restoreId,
      };
    },
    directory,
    prepare,
    snapshot,
    acceptedAuthorization,
    save,
    bank,
    mobile,
    get crypto() {
      return crypto;
    },
  };
}

async function plan(f: Awaited<ReturnType<typeof fixture>>) {
  await f.prepare();
  await f.db.run(
    planAnchorBaseline(f.acceptedAuthorization.restoreId, randomUUID),
  );
  return {
    db: f.db,
    deviceA: f.client,
    sodium,
    restoreId: f.acceptedAuthorization.restoreId,
  };
}
async function oldRecovery(f: Awaited<ReturnType<typeof fixture>>) {
  const old = await makeRecovery(f.client, sodium, "9007199254740993");
  const master = f.crypto.decode(old.code.slice(4));
  await f.client.secrets.store(f.client.scope("recoveryMaster"), master);
  master.fill(0);
  return old;
}
async function decryptReplay(
  f: Awaited<ReturnType<typeof fixture>>,
  o: Awaited<ReturnType<typeof plan>>,
) {
  const row = f.sqlite.prepare("SELECT * FROM recovery_b_saga").get()!,
    profile = JSON.parse(String(row.profile_b_json));
  const b = new DeviceProvisioning(profile, f.client.secrets, f.crypto),
    key = await b.secrets.load(b.scope("dataKey"));
  if (!key) throw new Error("fixture");
  const mapping = f.sqlite
      .prepare("SELECT * FROM recovery_revision_mapping ORDER BY ordinal")
      .all(),
    decoded: BaselineOperation[] = [];
  try {
    for (const stored of f.sqlite
      .prepare("SELECT * FROM recovery_b_envelopes ORDER BY ordinal")
      .all()) {
      const envelope = decodeCommit(encodeUtf8(String(stored.envelope_text))),
        { signature, ...unsigned } = envelope;
      void signature;
      const op = envelope.operations[0],
        bytes = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
          null,
          f.crypto.decode(op.ciphertext),
          operationAssociatedData(unsigned, 0),
          f.crypto.decode(op.nonce),
          key,
        );
      const revision = decodeCanonical(bytes) as BaselineOperation["revision"];
      bytes.fill(0);
      decoded.push({
        commitId: envelope.commitId,
        opId: op.opId,
        objectId: op.objectId,
        parents: op.parents,
        revision,
        isHead: mapping[decoded.length].is_head === 1,
      });
    }
  } finally {
    key.fill(0);
  }
  const original = mapping.map((r) => {
    const a = f.sqlite
      .prepare(
        "SELECT * FROM recovery_archive_sync_revisions WHERE revision_id=?",
      )
      .get(r.revision_a)!;
    return {
      commitId: String(a.commit_id),
      opId: String(a.revision_id),
      objectId: String(a.object_id),
      parents: JSON.parse(String(a.parents_json)),
      revision: JSON.parse(String(a.payload_json)),
      isHead: r.is_head === 1,
    };
  });
  await f.db.run(
    verifyBaselineReplay(
      [f.client.profile.pin.vaultId, f.client.profile.pin.serverEpoch],
      original,
      decoded,
      new Map(mapping.map((r) => [String(r.revision_a), String(r.revision_b)])),
    ),
  );
  return decoded;
}
function mockStatus(r: EpochStagingRequest) {
  const p = r.payload as {
    lastOrdinal?: string;
    batchOrdinal?: string;
    commitCount?: string;
    operationCount?: string;
    batchCount?: string;
    manifest?: {
      commitCount: string;
      operationCount: string;
      batchCount: string;
    };
  };
  const counts = p.manifest ?? p;
  return {
    state:
      r.action === "prepare"
        ? "prepared"
        : r.action === "validate"
          ? "validated"
          : "uploading",
    commitCount: counts.commitCount ?? p.lastOrdinal ?? "0",
    operationCount: counts.operationCount ?? p.lastOrdinal ?? "0",
    batchCount: counts.batchCount ?? p.batchOrdinal ?? "0",
    activationAvailable: false,
    readyForActivation: r.action === "prepare",
  };
}
async function mockActivationOptions(
  f: Awaited<ReturnType<typeof fixture>>,
  o: Awaited<ReturnType<typeof plan>>,
  dialect: "desktop" | "android" = "desktop",
): Promise<AnchorActivationOptions> {
  let profile = structuredClone(f.client.profile),
    record:
      import("@lionpocket/sync-protocol").EpochActivationRecord | undefined;
  return {
    ...o,
    dialect,
    endpoint: "https://fixture.invalid",
    transport: async (action, r) => {
      if (action === "status" && !record) return { state: "prepared" };
      const row = f.sqlite
        .prepare(
          "SELECT profile_b_json,manifest_json FROM recovery_b_saga WHERE restore_id=?",
        )
        .get(o.restoreId)!;
      const b = JSON.parse(String(row.profile_b_json)),
        m = JSON.parse(String(row.manifest_json));
      const { signature, ...unsigned } = r;
      void signature;
      record ??= {
        ...unsigned,
        requestSha256: f.crypto.hash(canonicalStringify(r)),
        trustPinSha256: f.crypto.hash(canonicalStringify(b.pin)),
        logPosition: m.commitCount,
        commitCount: m.commitCount,
        operationCount: m.operationCount,
      };
      return { state: "active", activation: record };
    },
    inspectBackup: inspectEpochAnchorBackup,
    checkpoint: () =>
      createEpochAnchorBackup(
        f.sqlite,
        join(f.directory, randomUUID() + ".sqlite"),
      ),
    inspectCheckpoint: (path) =>
      inspectEpochActivationCheckpoint(path, o.restoreId),
    saveProfile: async (p) => {
      profile = structuredClone(p);
    },
    loadProfile: async () => profile,
    firstPull: async () => undefined,
  };
}
// Recovery fixtures use the production memory-hard KDF while the full suite runs in parallel.
describe("operational B preparation remains isolated", () => {
  for (const dialect of ["desktop", "android"] as const)
    it(`${dialect}: distinct identity, same authority/master, C1+C2 encrypted replay, no active writes`, async () => {
      const f = await fixture(dialect),
        old = await oldRecovery(f),
        o = await plan(f),
        before = f.snapshot();
      const prepared = await prepareOperationalB({
        ...o,
        previousRecovery: old.recovery,
      });
      expect(prepared.phase).toBe("recovery_confirmed");
      expect(prepared.code).toBeUndefined();
      expect(prepared.profile.deviceId).not.toBe(f.client.profile.deviceId);
      expect(prepared.profile.installationId).toBe(
        f.client.profile.installationId,
      );
      expect(prepared.profile.pin.authorityPublicKey).toBe(
        f.client.profile.pin.authorityPublicKey,
      );
      expect(prepared.profile.pin.keyVersion).toBe(2);
      expect(prepared.profile.grants).toHaveLength(1);
      expect(prepared.recovery.envelope.recoveryVersion).toBe(
        "9007199254740994",
      );
      const b = new DeviceProvisioning(
          prepared.profile,
          f.client.secrets,
          f.crypto,
        ),
        bundle = openRecovery(b, sodium, prepared.recovery, old.code);
      expect(bundle.dataKeys.map((k) => k.keyVersion)).toEqual([2]);
      expect(prepared.recovery.envelope.ciphertext).not.toBe(
        old.recovery.envelope.ciphertext,
      );
      const requests: EpochStagingRequest[] = [];
      await stageOperationalB({
        ...o,
        previousTrustedTransition: null,
        transport: async (_a, r) => {
          requests.push(r);
          return mockStatus(r);
        },
      });
      const decoded = await decryptReplay(f, o);
      void decoded;
      expect(requests.map((r) => r.action)).toEqual([
        "begin",
        "batch",
        "validate",
        "prepare",
      ]);
      expect(f.snapshot()).toEqual(before);
      const publicRows = [
        "recovery_b_saga",
        "recovery_b_envelopes",
        "recovery_b_batches",
      ].map((t) => f.sqlite.prepare(`SELECT * FROM ${t}`).all());
      expect(JSON.stringify(publicRows)).not.toContain(input.description);
      expect(JSON.stringify(publicRows)).not.toContain(old.code);
      const preparationBytes = (await f.client.secrets.load(
        epochPreparationSecretScope(
          f.client.profile,
          o.restoreId,
          f.acceptedAuthorization.toEpoch,
        ),
      ))!;
      const preparation = decodeCanonical(preparationBytes) as Record<
        string,
        string
      >;
      const publicText = JSON.stringify([publicRows, requests]);
      for (const purpose of [
        "signingSeed",
        "boxSeed",
        "dataKey",
        "authoritySeed",
        "recoveryMaster",
      ])
        expect(publicText.includes(preparation[purpose])).toBe(false);
      expect(
        publicText.includes(new TextDecoder().decode(preparationBytes)),
      ).toBe(false);
      preparationBytes.fill(0);
      const akey = await f.client.secrets.load(f.client.scope("dataKey")),
        bkey = await b.secrets.load(b.scope("dataKey"));
      expect(akey !== null && bkey !== null && !sodium.memcmp(akey, bkey)).toBe(
        true,
      );
      akey?.fill(0);
      bkey?.fill(0);
      expect(
        f.sqlite.prepare("SELECT phase FROM recovery_b_saga").get()!.phase,
      ).toBe("prepared");
    });
  it("new code is pending until explicit redigitation, including a clean recovery store", async () => {
    const f = await fixture(),
      old = await makeRecovery(f.client, sodium, "1"),
      o = await plan(f);
    const prepared = await prepareOperationalB({
      ...o,
      previousRecovery: old.recovery,
    });
    expect(prepared.code).toBeDefined();
    await expect(
      stageOperationalB({
        ...o,
        previousTrustedTransition: null,
        transport: async () => {
          throw new Error("must not send");
        },
      }),
    ).rejects.toThrow("recovery_confirmation_required");
    await expect(
      confirmOperationalBRecovery(o, "LP1." + f.crypto.nonce()),
    ).rejects.toThrow();
    await confirmOperationalBRecovery(o, prepared.code!);
    const { TestSecrets } =
      await import("../../../../sync-server/src/testSupport");
    const clean = new DeviceProvisioning(
      prepared.profile,
      new TestSecrets(),
      f.crypto,
    );
    expect(
      openRecovery(
        clean,
        sodium,
        prepared.recovery,
        prepared.code!,
      ).dataKeys.map((k) => k.keyVersion),
    ).toEqual([2]);
    expect(
      JSON.stringify(f.sqlite.prepare("SELECT * FROM recovery_b_saga").all()),
    ).not.toContain(prepared.code!);
  });
  it("refuses changed reserved secrets and a stale post-archive plan without publishing", async () => {
    const f = await fixture(),
      o = await plan(f),
      before = f.snapshot();
    const prepared = await prepareOperationalB({
      ...o,
      previousRecovery: null,
    });
    const b = new DeviceProvisioning(
        prepared.profile,
        f.client.secrets,
        f.crypto,
      ),
      different = sodium.randombytes_buf(32);
    await b.secrets.store(b.scope("signingSeed"), different);
    different.fill(0);
    await expect(
      prepareOperationalB({ ...o, previousRecovery: null }),
    ).rejects.toThrow("secret_reservation_mismatch");
    expect(f.snapshot()).toEqual(before);
    const stale = await fixture(),
      old = await oldRecovery(stale),
      options = await plan(stale);
    await prepareOperationalB({ ...options, previousRecovery: old.recovery });
    await stale.save("NEW_A_AFTER_ARCHIVE");
    await expect(
      stageOperationalB({
        ...options,
        previousTrustedTransition: null,
        transport: async () => {
          throw new Error("must not publish");
        },
      }),
    ).rejects.toThrow("epoch_archive_stale");
  });
  it.each([
    "preparation_bundle_stored",
    "preparation_bundle_verified",
    "identity_reserved",
    "secret:signingSeed",
    "secret:boxSeed",
    "secret:dataKey",
    "secret:authoritySeed",
    "secret:recoveryMaster",
    "secrets_prepared",
    "recovery_before_save",
    "recovery_created",
    "recovery_confirmed",
  ])(
    "real SQLite/store adapter restart converges on the identical B after %s",
    async (fault) => {
      const f = await fixture("desktop", true),
        old = await oldRecovery(f),
        o = await plan(f),
        before = f.snapshot();
      await expect(
        prepareOperationalB({
          ...o,
          previousRecovery: old.recovery,
          fault: (point) => {
            if (point === fault) throw new Error("crash");
          },
        }),
      ).rejects.toThrow("crash");
      const scope = epochPreparationSecretScope(
        f.client.profile,
        o.restoreId,
        f.acceptedAuthorization.toEpoch,
      );
      const bytes = await f.client.secrets.load(scope);
      expect(bytes !== null).toBe(true);
      const privateBundle = decodeCanonical(bytes!) as Record<string, string>;
      const proposedProfile = {
        pin: {
          ...f.client.profile.pin,
          founderDeviceId: privateBundle.deviceId,
          serverEpoch: scope.toEpoch,
          keyVersion: privateBundle.baseKeyVersion,
        },
        deviceId: privateBundle.deviceId,
        signingPublicKey: privateBundle.signingPublicKey,
        boxPublicKey: privateBundle.boxPublicKey,
      };
      const independentGrant = {
        formatVersion: 1,
        serverId: scope.serverId,
        serverEpoch: scope.toEpoch,
        vaultId: scope.vaultId,
        registryVersion: "1",
        previousRegistrySha256: null,
        deviceId: privateBundle.deviceId,
        signingPublicKey: privateBundle.signingPublicKey,
        boxPublicKey: privateBundle.boxPublicKey,
        status: "approved",
      };
      const originalPublic = f.sqlite
        .prepare(
          "SELECT profile_b_json,begin_public_json,recovery_json FROM recovery_b_saga",
        )
        .get();
      const retry = await f.restart();
      const uuid = vi.spyOn(f.crypto, "uuid").mockImplementation(() => {
        throw new Error("Second random identity is forbidden");
      });
      const random = vi.spyOn(sodium, "randombytes_buf");
      let prepared: Awaited<ReturnType<typeof prepareOperationalB>>;
      try {
        prepared = await prepareOperationalB({
          ...retry,
          previousRecovery: null,
        }); // Bundle carries verified Recovery A.
        expect(random).not.toHaveBeenCalled();
      } finally {
        random.mockRestore();
      }
      expect(prepared.profile.deviceId === privateBundle.deviceId).toBe(true);
      expect(
        prepared.profile.signingPublicKey === privateBundle.signingPublicKey,
      ).toBe(true);
      expect(prepared.profile.boxPublicKey === privateBundle.boxPublicKey).toBe(
        true,
      );
      expect(prepared.phase).toBe("recovery_confirmed");
      expect(uuid).not.toHaveBeenCalled();
      expect(prepared.profile.pin).toEqual(proposedProfile.pin);
      const { signature, ...grant } = prepared.profile.grants[0];
      expect(grant).toEqual(independentGrant);
      expect(signature).toBeDefined();
      const beginAfter = JSON.parse(
        String(
          f.sqlite
            .prepare("SELECT begin_public_json FROM recovery_b_saga")
            .get()!.begin_public_json,
        ),
      );
      expect(beginAfter.keyBase.baseKeyVersion).toBe(
        privateBundle.baseKeyVersion,
      );
      expect(beginAfter.keyBase.previousActiveKeyVersion).toBe(
        f.client.profile.activeKeyVersion ?? f.client.profile.pin.keyVersion,
      );
      expect(beginAfter.keyBase.fromEpoch).toBe(scope.fromEpoch);
      expect(beginAfter.keyBase.serverEpoch).toBe(scope.toEpoch);
      const b = new DeviceProvisioning(
        prepared.profile,
        f.client.secrets,
        f.crypto,
      );
      for (const purpose of [
        "signingSeed",
        "boxSeed",
        "dataKey",
        "authoritySeed",
        "recoveryMaster",
      ] as const) {
        const key = await b.secrets.load(b.scope(purpose));
        expect(
          key !== null && f.crypto.encode(key) === privateBundle[purpose],
        ).toBe(true);
        key?.fill(0);
      }
      expect(f.snapshot()).toEqual(before);
      const after = f.sqlite
        .prepare(
          "SELECT profile_b_json,begin_public_json,recovery_json,preparation_format FROM recovery_b_saga",
        )
        .get()!;
      expect(after.preparation_format).toBe(2);
      if (originalPublic) {
        expect(after.profile_b_json).toBe(originalPublic.profile_b_json);
        expect(after.begin_public_json).toBe(originalPublic.begin_public_json);
        if (originalPublic.recovery_json)
          expect(after.recovery_json).toBe(originalPublic.recovery_json);
      }
      const publicRows = canonicalStringify(
        f.sqlite.prepare("SELECT * FROM recovery_b_saga").all(),
      );
      for (const purpose of [
        "signingSeed",
        "boxSeed",
        "dataKey",
        "authoritySeed",
        "recoveryMaster",
      ])
        expect(publicRows.includes(privateBundle[purpose])).toBe(false);
      expect(publicRows.includes(new TextDecoder().decode(bytes!))).toBe(false);
      expect(prepared.activationAvailable).toBe(false);
      const persisted = await f.client.secrets.load(scope);
      expect(persisted !== null && sodium.memcmp(persisted, bytes!)).toBe(true);
      persisted?.fill(0);
      bytes!.fill(0);
    },
  );
  it("crash before the preparation bundle leaves no public reservation and retry can start", async () => {
    const f = await fixture("desktop", true),
      o = await plan(f),
      before = f.snapshot();
    await expect(
      prepareOperationalB({
        ...o,
        previousRecovery: null,
        fault: (point) => {
          if (point === "before_preparation_bundle") throw new Error("crash");
        },
      }),
    ).rejects.toThrow("crash");
    expect(f.sqlite.prepare("SELECT * FROM recovery_b_saga").all()).toEqual([]);
    const retry = await f.restart();
    expect(
      (await prepareOperationalB({ ...retry, previousRecovery: null })).phase,
    ).toBe("recovery_pending_confirmation");
    expect(f.snapshot()).toEqual(before);
  });
  it.each([false, true])(
    "ambiguous bundle store (durable=%s) never freezes missing random material",
    async (durable) => {
      const f = await fixture("desktop", true),
        o = await plan(f),
        original = f.client.secrets;
      let stored = false;
      const adapter: SecretStore = {
        load: async (scope) => {
          if (scope.purpose === "epochPreparation" && stored)
            throw new Error("process died before reread");
          return original.load(scope);
        },
        store: async (scope, bytes) => {
          if (scope.purpose !== "epochPreparation")
            return original.store(scope, bytes);
          if (durable) await original.store(scope, bytes);
          stored = true;
          throw new Error("ambiguous store acknowledgement");
        },
        remove: (scope) => original.remove(scope),
      };
      const interrupted = {
        ...o,
        deviceA: new DeviceProvisioning(f.client.profile, adapter, f.crypto),
      };
      await expect(
        prepareOperationalB({ ...interrupted, previousRecovery: null }),
      ).rejects.toThrow("process died");
      expect(f.sqlite.prepare("SELECT * FROM recovery_b_saga").all()).toEqual(
        [],
      );
      const scope = epochPreparationSecretScope(
          f.client.profile,
          o.restoreId,
          f.acceptedAuthorization.toEpoch,
        ),
        bytes = await original.load(scope);
      expect(bytes !== null).toBe(durable);
      const retry = await f.restart();
      if (durable)
        vi.spyOn(f.crypto, "uuid").mockImplementation(() => {
          throw new Error("Second identity forbidden");
        });
      const prepared = await prepareOperationalB({
        ...retry,
        previousRecovery: null,
      });
      if (bytes) {
        expect(
          prepared.profile.deviceId ===
            (decodeCanonical(bytes) as Record<string, string>).deviceId,
        ).toBe(true);
        bytes.fill(0);
      }
      expect(prepared.activationAvailable).toBe(false);
    },
  );
  it("restart before redigitation presents the same LP1 and recovery artifact; wrong code remains refused", async () => {
    const f = await fixture("desktop", true),
      o = await plan(f);
    const first = await prepareOperationalB({ ...o, previousRecovery: null });
    const retry = await f.restart();
    const second = await prepareOperationalB({
      ...retry,
      previousRecovery: null,
    });
    expect(second.code === first.code).toBe(true);
    expect(second.recovery).toEqual(first.recovery);
    await expect(
      confirmOperationalBRecovery(
        retry,
        "LP1." + f.crypto.encode(sodium.randombytes_buf(32)),
      ),
    ).rejects.toThrow();
    await confirmOperationalBRecovery(retry, second.code!);
    expect(
      (await prepareOperationalB({ ...retry, previousRecovery: null })).phase,
    ).toBe("recovery_confirmed");
  });
  it.each([
    "identity_reserved",
    "recovery_pending_confirmation",
    "recovery_confirmed",
  ])("pause and explicit resume preserve the same B from %s", async (phase) => {
    const f = await fixture("desktop", true),
      o = await plan(f),
      before = f.snapshot();
    if (phase === "identity_reserved")
      await expect(
        prepareOperationalB({
          ...o,
          previousRecovery: null,
          fault: (point) => {
            if (point === phase) throw new Error("crash");
          },
        }),
      ).rejects.toThrow("crash");
    else {
      const first = await prepareOperationalB({ ...o, previousRecovery: null });
      if (phase === "recovery_confirmed")
        await confirmOperationalBRecovery(o, first.code!);
    }
    const original = f.sqlite.prepare("SELECT * FROM recovery_b_saga").get()!;
    await cancelOperationalB(o);
    await cancelOperationalB(o);
    await f.db.run(cancelAnchorPlan(o.restoreId));
    expect(
      f.sqlite.prepare("SELECT phase FROM recovery_journal").get()!.phase,
    ).toBe("planned");
    const retry = await f.restart();
    await expect(
      prepareOperationalB({ ...retry, previousRecovery: null }),
    ).rejects.toThrow("recovery_attempt_paused");
    expect((await resumeOperationalB(retry)).phase).toBe(phase);
    const after = await prepareOperationalB({
      ...retry,
      previousRecovery: null,
    });
    expect(canonicalStringify(after.profile)).toBe(original.profile_b_json);
    if (original.recovery_json)
      expect(canonicalStringify(after.recovery)).toBe(original.recovery_json);
    expect(f.snapshot()).toEqual(before);
    expect(after.activationAvailable).toBe(false);
  });
  it.each(["secret:signingSeed", "recovery_before_save", "confirmation"])(
    "concurrent pause is never overwritten by %s",
    async (point) => {
      const f = await fixture(),
        o = await plan(f);
      if (point === "confirmation") {
        const prepared = await prepareOperationalB({
          ...o,
          previousRecovery: null,
        });
        const original = f.client.secrets;
        let once = true;
        const adapter: SecretStore = {
          store: (scope, bytes) => original.store(scope, bytes),
          remove: (scope) => original.remove(scope),
          load: async (scope) => {
            if (once && scope.purpose === "epochPreparation") {
              once = false;
              await cancelOperationalB(o);
            }
            return original.load(scope);
          },
        };
        await expect(
          confirmOperationalBRecovery(
            {
              ...o,
              deviceA: new DeviceProvisioning(
                f.client.profile,
                adapter,
                f.crypto,
              ),
            },
            prepared.code!,
          ),
        ).rejects.toThrow("recovery_attempt_paused");
      } else
        await expect(
          prepareOperationalB({
            ...o,
            previousRecovery: null,
            fault: async (step) => {
              if (step === point) await cancelOperationalB(o);
            },
          }),
        ).rejects.toThrow("recovery_attempt_paused");
      const row = f.sqlite
        .prepare("SELECT phase,recovery_confirmed FROM recovery_b_saga")
        .get()!;
      expect(row.phase).toBe("cancelled");
      expect(row.recovery_confirmed).toBe(0);
      await resumeOperationalB(o);
      expect(
        (await prepareOperationalB({ ...o, previousRecovery: null }))
          .activationAvailable,
      ).toBe(false);
    },
  );
  it.each([
    "extra",
    "format",
    "scope",
    "uuid",
    "signingSeed",
    "boxSeed",
    "dataKey",
    "authoritySeed",
    "recoveryMaster",
    "nonce",
    "signingPublicKey",
    "boxPublicKey",
    "authorityPublicKey",
    "base",
    "commitments",
    "malformed",
  ])(
    "strict private parsing fails closed without leaking canaries: %s",
    async (mutation) => {
      const f = await fixture(),
        o = await plan(f);
      await expect(
        prepareOperationalB({
          ...o,
          previousRecovery: null,
          fault: (point) => {
            if (point === "preparation_bundle_stored") throw new Error("crash");
          },
        }),
      ).rejects.toThrow("crash");
      const scope = epochPreparationSecretScope(
        f.client.profile,
        o.restoreId,
        f.acceptedAuthorization.toEpoch,
      );
      const bytes = await f.client.secrets.load(scope),
        bundle = decodeCanonical(bytes!) as Record<string, unknown>;
      if (mutation === "extra")
        bundle.PRIVATE_BUNDLE_CANARY = "PRIVATE_BUNDLE_CANARY";
      else if (mutation === "format") bundle.formatVersion = 2;
      else if (mutation === "scope")
        (bundle.scope as Record<string, unknown>).restoreId = randomUUID();
      else if (mutation === "uuid") bundle.deviceId = "PRIVATE_BUNDLE_CANARY";
      else if (mutation === "nonce")
        bundle.recoveryNonce = f.crypto.encode(new Uint8Array(23));
      else if (mutation === "base") bundle.baseKeyVersion = 1;
      else if (mutation === "commitments")
        (bundle.commitments as Record<string, unknown>).operationCount = "99";
      else if (mutation.endsWith("PublicKey"))
        bundle[mutation] = f.crypto.encode(new Uint8Array(32));
      else bundle[mutation] = f.crypto.encode(new Uint8Array(31));
      const corrupt =
        mutation === "malformed"
          ? encodeUtf8('{"PRIVATE_BUNDLE_CANARY')
          : encodeUtf8(canonicalStringify(bundle));
      // Test-only corruption of storage, not an overwrite path offered by the real adapters.
      (f.client.secrets as TestSecrets).values.set(
        secretContext(scope),
        corrupt,
      );
      await expect(
        prepareOperationalB({ ...o, previousRecovery: null }),
      ).rejects.toThrow(/^invalid_preparation_secret_bundle$/);
      expect(f.sqlite.prepare("SELECT * FROM recovery_b_saga").all()).toEqual(
        [],
      );
      bytes!.fill(0);
    },
  );
  it("private digest and public reservation mismatches are hard failures, never repaired", async () => {
    const f = await fixture(),
      o = await plan(f),
      prepared = await prepareOperationalB({ ...o, previousRecovery: null });
    const scope = epochPreparationSecretScope(
        f.client.profile,
        o.restoreId,
        f.acceptedAuthorization.toEpoch,
      ),
      store = f.client.secrets as TestSecrets;
    const original = (await store.load(scope))!,
      bundle = decodeCanonical(original) as Record<string, unknown>;
    bundle.deviceId = randomUUID();
    store.values.set(
      secretContext(scope),
      encodeUtf8(canonicalStringify(bundle)),
    );
    await expect(
      prepareOperationalB({ ...o, previousRecovery: null }),
    ).rejects.toThrow("secret_reservation_mismatch");
    store.values.delete(secretContext(scope));
    await expect(
      prepareOperationalB({ ...o, previousRecovery: null }),
    ).rejects.toThrow("preparation_secret_bundle_unavailable");
    store.values.set(secretContext(scope), original);
    f.sqlite.exec("DROP TRIGGER recovery_b_identity");
    f.sqlite
      .prepare("UPDATE recovery_b_saga SET profile_b_json=?")
      .run(canonicalStringify({ ...prepared.profile, deviceId: randomUUID() }));
    await expect(
      prepareOperationalB({ ...o, previousRecovery: null }),
    ).rejects.toThrow("secret_reservation_mismatch");
  });
  it("a different valid recovery artifact cannot replace the bundle-reserved ciphertext during resume/staging", async () => {
    const f = await fixture(),
      old = await oldRecovery(f),
      o = await plan(f),
      before = f.snapshot();
    const prepared = await prepareOperationalB({
      ...o,
      previousRecovery: old.recovery,
    });
    const b = new DeviceProvisioning(
        prepared.profile,
        f.client.secrets,
        f.crypto,
      ),
      master = (await b.secrets.load(b.scope("recoveryMaster")))!;
    let changed;
    try {
      changed = (
        await makeRecovery(
          b,
          sodium,
          prepared.recovery.envelope.recoveryVersion,
          master,
        )
      ).recovery;
    } finally {
      master.fill(0);
    }
    f.sqlite.exec("DROP TRIGGER recovery_b_recovery_json");
    f.sqlite
      .prepare("UPDATE recovery_b_saga SET recovery_json=?")
      .run(canonicalStringify(changed));
    await expect(confirmOperationalBRecovery(o, old.code)).rejects.toThrow(
      "secret_reservation_mismatch",
    );
    await expect(
      stageOperationalB({
        ...o,
        previousTrustedTransition: null,
        transport: async () => {
          throw new Error("Must not publish");
        },
      }),
    ).rejects.toThrow("secret_reservation_mismatch");
    expect(f.snapshot()).toEqual(before);
  });
  it("migrates old draft saga metadata as legacy blocked without inventing lost secrets", async () => {
    const f = await fixture(),
      o = await plan(f);
    const legacySchema = operationalBSchema[0].replace(
      /,\n {2}preparation_format[\s\S]*resume_phase TEXT/,
      "",
    );
    f.sqlite.exec(legacySchema);
    f.sqlite
      .prepare(
        "INSERT INTO recovery_b_saga(restore_id,profile_b_json,begin_public_json,expected_secrets_json,recovery_source,phase) VALUES(?,'{}','{}','{}','new','identity_reserved')",
      )
      .run(o.restoreId);
    await expect(
      prepareOperationalB({ ...o, previousRecovery: null }),
    ).rejects.toThrow("legacy_preparation_blocked");
    expect(
      f.sqlite.prepare("SELECT preparation_format FROM recovery_b_saga").get()!
        .preparation_format,
    ).toBe(1);
    expect(
      await f.client.secrets.load(
        epochPreparationSecretScope(
          f.client.profile,
          o.restoreId,
          f.acceptedAuthorization.toEpoch,
        ),
      ),
    ).toBeNull();
  });
  it("formats and private commitments are immutable after the new reservation", async () => {
    const f = await fixture(),
      o = await plan(f);
    await prepareOperationalB({ ...o, previousRecovery: null });
    expect(() =>
      f.sqlite.exec("UPDATE recovery_b_saga SET preparation_format=1"),
    ).toThrow("immutable");
    expect(() =>
      f.sqlite.exec("UPDATE recovery_b_saga SET preparation_sha256='changed'"),
    ).toThrow("immutable");
  });
  it.each([
    "begin",
    "envelope",
    "batch",
    "manifest",
    "validate",
    "transition",
    "remote_prepared",
  ])("reuses byte-identical envelopes after %s", async (fault) => {
    const f = await fixture("desktop", true),
      old = await oldRecovery(f),
      o = await plan(f);
    await prepareOperationalB({ ...o, previousRecovery: old.recovery });
    const remote = new Map<string, string>();
    let once = true;
    const transport = async (action: string, r: EpochStagingRequest) => {
      const payload = canonicalStringify(r.payload),
        id =
          action === "batch"
            ? action +
              ":" +
              (r.payload as { batchOrdinal: string }).batchOrdinal
            : action;
      if (remote.has(id)) expect(remote.get(id)).toBe(payload);
      else remote.set(id, payload);
      return mockStatus(r);
    };
    await expect(
      stageOperationalB({
        ...o,
        previousTrustedTransition: null,
        transport,
        fault: (s) => {
          if (once && s === fault) {
            once = false;
            throw new Error("crash");
          }
        },
      }),
    ).rejects.toThrow("crash");
    await expect(cancelOperationalB(o)).rejects.toThrow(
      "remote_staging_requires_resume",
    );
    const retry = await f.restart();
    await stageOperationalB({
      ...retry,
      previousTrustedTransition: null,
      transport,
    });
    expect(remote.has("prepare")).toBe(true);
  });
  it("batches 107 operations and decrypts them through the normal projection", async () => {
    const f = await fixture();
    for (let i = 0; i < 105; i++) await f.save("LARGE_GRAPH_" + i);
    const o = await plan(f),
      old = await oldRecovery(f);
    await prepareOperationalB({ ...o, previousRecovery: old.recovery });
    const batches: number[] = [];
    const result = await stageOperationalB({
      ...o,
      previousTrustedTransition: null,
      transport: async (a, r) => {
        if (a === "batch")
          batches.push((r.payload as { envelopes: string[] }).envelopes.length);
        return mockStatus(r);
      },
    });
    expect(batches).toEqual([100, 7]);
    expect(result.manifest.operationCount).toBe("107");
    await decryptReplay(f, o);
  }, 30000);
  it.each([false, true])(
    "encrypts Z→X/Y with tombstone=%s and keeps the common base through the importer",
    async (deleted) => {
      const f = await fixture(),
        base = f.sqlite
          .prepare(
            "SELECT * FROM sync_revisions ORDER BY length(local_seq),local_seq LIMIT 1",
          )
          .get()!;
      f.sqlite
        .prepare("DELETE FROM sync_heads WHERE object_id=?")
        .run(base.object_id);
      for (const [index, description] of ["BRANCH_X", "BRANCH_Y"].entries()) {
        const revision = JSON.parse(String(base.payload_json));
        revision.snapshot.description = description;
        if (deleted && index === 0)
          Object.assign(revision, {
            action: "delete",
            snapshot: null,
            reason: "user",
            deletedAt: revision.authoredAt,
            slotKey: null,
            importKey: null,
          });
        const seq = incrementDecimal64(
            String(
              f.sqlite.prepare("SELECT local_seq FROM sync_local_state").get()!
                .local_seq,
            ),
          ),
          id = randomUUID();
        f.sqlite
          .prepare("INSERT INTO sync_revisions VALUES(?,?,?,?,?,?,?,?)")
          .run(
            id,
            base.object_id,
            randomUUID(),
            seq,
            revision.action,
            revision.authoredAt,
            canonicalStringify([base.revision_id]),
            canonicalStringify(revision),
          );
        f.sqlite
          .prepare("INSERT INTO sync_heads VALUES(?,?)")
          .run(base.object_id, id);
        f.sqlite.prepare("UPDATE sync_local_state SET local_seq=?").run(seq);
        if (revision.action === "delete")
          f.sqlite
            .prepare("INSERT INTO sync_tombstones VALUES(?,?,?)")
            .run(base.object_id, id, revision.deletedAt);
      }
      function* project(): SqlWorkflow {
        yield sql("UPDATE sync_control SET applying=1");
        yield* projectObject(String(base.object_id), "desktop", randomUUID);
        yield sql("UPDATE sync_control SET applying=0");
      }
      await f.db.run(project());
      const o = await plan(f),
        old = await oldRecovery(f);
      await prepareOperationalB({ ...o, previousRecovery: old.recovery });
      await stageOperationalB({
        ...o,
        previousTrustedTransition: null,
        transport: async (_a, r) => mockStatus(r),
      });
      const decoded = await decryptReplay(f, o);
      const branches = decoded.filter((x) => x.objectId === base.object_id);
      expect(branches).toHaveLength(3);
      expect(branches.filter((x) => x.isHead)).toHaveLength(2);
      expect(
        branches.filter((x) => x.revision.action === "delete"),
      ).toHaveLength(deleted ? 1 : 0);
      const financialBefore = f.snapshot();
      await requestAnchorActivation(await mockActivationOptions(f, o), true);
      const mapped = f.sqlite
        .prepare(
          "SELECT revision_b FROM recovery_revision_mapping WHERE revision_a=?",
        )
        .get(base.revision_id)!;
      expect(
        f.sqlite
          .prepare(
            "SELECT base_revision_id FROM sync_conflicts WHERE object_id=? AND resolution_id IS NULL",
          )
          .get(base.object_id)!.base_revision_id,
      ).toBe(mapped.revision_b);
      expect(
        f.sqlite
          .prepare("SELECT count(*) AS n FROM sync_heads WHERE object_id=?")
          .get(base.object_id)!.n,
      ).toBe(2);
      expect(
        f.sqlite
          .prepare(
            "SELECT count(*) AS n FROM sync_tombstones WHERE object_id=?",
          )
          .get(base.object_id)!.n,
      ).toBe(deleted ? 1 : 0);
      for (const table of Object.keys(financialTableTypes))
        expect(f.snapshot()[table]).toEqual(financialBefore[table]);
    },
  );
}, 30000);

describe("anchor activation installation on real adapters", () => {
  for (const dialect of ["desktop", "android"] as const) {
    it(`${dialect}: durable activation, exact B graph, stable financial rows and next device sequence`, async () => {
      const f = await fixture(dialect),
        old = await oldRecovery(f),
        o = await plan(f);
      await prepareOperationalB({ ...o, previousRecovery: old.recovery });
      await stageOperationalB({
        ...o,
        previousTrustedTransition: null,
        transport: async (_action, request) => mockStatus(request),
      });
      const before = f.snapshot();
      let active:
        import("@lionpocket/sync-protocol").EpochActivationRecord | undefined;
      let profile = structuredClone(f.client.profile);
      const options: AnchorActivationOptions = {
        ...o,
        dialect,
        endpoint: "https://fixture.invalid",
        transport: async (action, request) => {
          if (!active && action === "status") return { state: "prepared" };
          const { signature, ...unsigned } = request;
          void signature;
          const row = f.sqlite
            .prepare("SELECT profile_b_json,manifest_json FROM recovery_b_saga")
            .get()!;
          const b = JSON.parse(String(row.profile_b_json)),
            manifest = JSON.parse(String(row.manifest_json));
          active ??= {
            ...unsigned,
            requestSha256: f.crypto.hash(canonicalStringify(request)),
            trustPinSha256: f.crypto.hash(canonicalStringify(b.pin)),
            logPosition: manifest.commitCount,
            commitCount: manifest.commitCount,
            operationCount: manifest.operationCount,
          };
          return { state: "active", activation: active };
        },
        inspectBackup: inspectEpochAnchorBackup,
        checkpoint: () =>
          createEpochAnchorBackup(
            f.sqlite,
            join(f.directory, randomUUID() + ".sqlite"),
          ),
        inspectCheckpoint: (path) =>
          inspectEpochActivationCheckpoint(path, o.restoreId),
        saveProfile: async (value) => {
          profile = structuredClone(value);
        },
        loadProfile: async () => profile,
        firstPull: async () => undefined,
      };
      await expect(requestAnchorActivation(options, false)).rejects.toThrow(
        "confirmation_required",
      );
      await requestAnchorActivation(options, true);
      expect(
        f.sqlite.prepare("SELECT phase FROM recovery_activation_saga").get()!
          .phase,
      ).toBe("recovered");
      expect(profile.pin.serverEpoch).toBe(f.acceptedAuthorization.toEpoch);
      const after = f.snapshot();
      for (const table of [
        ...Object.keys(financialTableTypes),
        "sync_identity",
        "sync_series",
        "sync_slots",
        "sync_import_provenance",
        "sync_aliases",
      ])
        expect(after[table]).toEqual(before[table]);
      expect(after.sync_inbox).toHaveLength(2);
      expect(after.sync_inbox.every((row) => row.state === "applied")).toBe(
        true,
      );
      expect(after.sync_outbox).toEqual([]);
      expect(after.sync_local_state[0]).toMatchObject({
        device_seq: "2",
        local_seq: "2",
        received_cursor: "2",
        applied_cursor: "2",
        pull_upper_bound: null,
      });
      expect(after.sync_bindings[0].binding_id).not.toBe(
        before.sync_bindings[0].binding_id,
      );
      await expect(cancelOperationalB(o)).rejects.toThrow(
        "requires_finalization",
      );
      await expect(f.db.run(cancelAnchorPlan(o.restoreId))).rejects.toThrow(
        "requires_finalization",
      );
      await f.save("C4_OFFLINE_AFTER_RECOVERY");
      expect(
        f.sqlite.prepare("SELECT count(*) AS n FROM sync_outbox").get()!.n,
      ).toBe(1);
      const b = new DeviceProvisioning(profile, f.client.secrets, f.crypto);
      const { ManualSync } = await import("@lionpocket/sync-local");
      const engine = new ManualSync(
        f.db,
        b,
        sodium,
        dialect,
        "https://fixture.invalid",
        {
          request: async () => {
            throw new Error("offline");
          },
        },
      );
      const commit = f.sqlite
        .prepare("SELECT commit_id FROM sync_outbox")
        .get()!.commit_id;
      expect(
        decodeCommit(encodeUtf8(await engine.prepare(String(commit))))
          .deviceSeq,
      ).toBe("3");
    }, 30000);
  }
});

describe("activation crash resumption", () => {
  it.each(["manifestSha256", "transitionSha256", "trustPinSha256", "serverId", "vaultId", "toEpoch", "anchorDeviceId", "commitCount"])("rejects forged active %s before local installation", async (field) => {
    const f = await fixture(), old = await oldRecovery(f), o = await plan(f);
    await prepareOperationalB({ ...o, previousRecovery: old.recovery });
    await stageOperationalB({ ...o, previousTrustedTransition: null, transport: async (_action, r) => mockStatus(r) });
    const before = f.snapshot(), options = await mockActivationOptions(f, o), transport = options.transport;
    options.transport = async (action, request) => {
      const response = await transport(action, request) as import('@lionpocket/sync-protocol').EpochActivationStatus;
      if (response.state !== 'active') return response;
      return { ...response, activation: { ...response.activation, [field]: field === 'commitCount' ? '999' : field.endsWith('Sha256') ? f.crypto.hash('forged') : f.crypto.uuid() } };
    };
    await expect(requestAnchorActivation(options, true)).rejects.toThrow(/activation_mismatch|invalid_epoch_activation/);
    for (const table of [...Object.keys(financialTableTypes), 'sync_revisions', 'sync_heads', 'sync_inbox', 'sync_outbox', 'sync_bindings', 'sync_identity']) expect(f.snapshot()[table]).toEqual(before[table]);
    expect(f.sqlite.prepare('SELECT phase FROM recovery_activation_saga').get()!.phase).toBe('activation_requested');
    await resumeAnchorActivation({ ...options, transport });
    expect(f.sqlite.prepare('SELECT phase FROM recovery_activation_saga').get()!.phase).toBe('recovered');
  }, 30000);
  for (const dialect of ["desktop", "android"] as const) {
    it.each([
      "request_persisted",
      "remote_response",
      "remote_active",
      "before_checkpoint",
      "before_sqlite",
      "during_sqlite",
      "after_sqlite",
      "before_profile",
      "during_profile",
      "after_profile",
      "before_coordinator",
      "before_first_pull",
      "during_first_pull",
      "after_first_pull",
    ])(
      `${dialect}: restart converges after %s`,
      async (point) => {
        const f = await fixture(dialect),
          old = await oldRecovery(f),
          o = await plan(f);
        await prepareOperationalB({ ...o, previousRecovery: old.recovery });
        await stageOperationalB({
          ...o,
          previousTrustedTransition: null,
          transport: async (_action, r) => mockStatus(r),
        });
        const before = f.snapshot();
        let profile = structuredClone(f.client.profile),
          record:
            | import("@lionpocket/sync-protocol").EpochActivationRecord
            | undefined;
        let failed = false,
          activationCalls = 0;
        const requests: string[] = [];
        const opts = (): AnchorActivationOptions => ({
          ...o,
          db: f.db,
          deviceA: f.client,
          dialect,
          endpoint: "https://fixture.invalid",
          transport: async (action, r) => {
            requests.push(canonicalStringify(r));
            if (action === "status" && !record) return { state: "prepared" };
            if (action === "activate") activationCalls++;
            const saga = f.sqlite
              .prepare(
                "SELECT profile_b_json,manifest_json FROM recovery_b_saga",
              )
              .get()!;
            const b = JSON.parse(String(saga.profile_b_json)),
              m = JSON.parse(String(saga.manifest_json));
            const { signature, ...unsigned } = r;
            void signature;
            record ??= {
              ...unsigned,
              requestSha256: f.crypto.hash(canonicalStringify(r)),
              trustPinSha256: f.crypto.hash(canonicalStringify(b.pin)),
              logPosition: m.commitCount,
              commitCount: m.commitCount,
              operationCount: m.operationCount,
            };
            return { state: "active", activation: record };
          },
          inspectBackup: inspectEpochAnchorBackup,
          checkpoint: () =>
            createEpochAnchorBackup(
              f.sqlite,
              join(f.directory, randomUUID() + ".sqlite"),
            ),
          inspectCheckpoint: (path) =>
            inspectEpochActivationCheckpoint(path, o.restoreId),
          saveProfile: async (p) => {
            if (point === "during_profile" && !failed) {
              failed = true;
              throw new Error("client_crash");
            }
            profile = structuredClone(p);
          },
          loadProfile: async () => profile,
          firstPull: async () => {
            if (point === "during_first_pull" && !failed) {
              failed = true;
              throw new Error("client_crash");
            }
          },
          fault: (step) => {
            if (
              point === "during_sqlite" &&
              step === "before_sqlite" &&
              !failed
            ) {
              failed = true;
              f.sqlite.exec(
                "CREATE TEMP TRIGGER activation_fault BEFORE INSERT ON main.sync_revision_origin BEGIN SELECT RAISE(ABORT,'client_crash'); END",
              );
            }
            if (step === point && !failed) {
              failed = true;
              throw new Error("client_crash");
            }
          },
        });
        await expect(requestAnchorActivation(opts(), true)).rejects.toThrow(
          "client_crash",
        );
        const reserved = String(
          f.sqlite
            .prepare("SELECT request_text FROM recovery_activation_saga")
            .get()!.request_text,
        );
        if (
          [
            "request_persisted",
            "remote_response",
            "remote_active",
            "before_checkpoint",
            "before_sqlite",
            "during_sqlite",
          ].includes(point)
        ) {
          expect(
            f.sqlite.prepare("SELECT server_epoch FROM sync_local_state").get()!
              .server_epoch,
          ).toBe(f.client.profile.pin.serverEpoch);
          expect(f.snapshot().sync_outbox).toEqual(before.sync_outbox);
        }
        await f.restart(f.client.secrets);
        await resumeAnchorActivation(opts());
        expect(
          f.sqlite.prepare("SELECT phase FROM recovery_activation_saga").get()!
            .phase,
        ).toBe("recovered");
        expect(profile.pin.serverEpoch).toBe(f.acceptedAuthorization.toEpoch);
        expect(new Set(requests)).toEqual(new Set([reserved]));
        expect(activationCalls).toBe(1);
        for (const table of Object.keys(financialTableTypes))
          expect(f.snapshot()[table]).toEqual(before[table]);
        expect(f.sqlite.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
        expect(
          f.sqlite
            .prepare("SELECT count(*) AS n FROM recovery_archive_sync_outbox")
            .get()!.n,
        ).toBe(before.sync_outbox.length);
      },
      30000,
    );
  }
});

describe("stable logical sidecars during activation", () => {
  it("preserves nonempty series/slots/import provenance/aliases record for record", async () => {
    const f = await fixture();
    const recurring = f.bank!.saveRecurringExpense({
      kind: "expense",
      description: "RECURRING_STABLE_IDENTITY",
      plannedAmount: 42,
      dueDay: 8,
      startMonth: "2026-10",
      active: true,
    });
    f.bank!.ensureRecurringForMonth("2026-10");
    const slot = f.sqlite
      .prepare(
        "SELECT id FROM transactions WHERE source_type='recurring' AND source_id=? LIMIT 1",
      )
      .get(recurring.id)!;
    f.bank!.saveTransaction({
      ...input,
      id: String(slot.id),
      description: "PROMOTED_STABLE_SLOT",
    });
    const id = f.sqlite
      .prepare("SELECT local_id,object_id FROM sync_identity LIMIT 1")
      .get()!;
    f.sqlite
      .prepare("INSERT INTO sync_aliases VALUES(?,?)")
      .run(randomUUID(), id.object_id);
    await f.db.run(
      (function* (): SqlWorkflow {
        yield sql(
          "UPDATE transactions SET source_type='imported',source_id=? WHERE id=?",
          ["lp1:" + "a".repeat(64), String(id.local_id)],
        );
        yield sql("INSERT INTO sync_import_provenance VALUES(?,?,NULL)", [
          String(id.local_id),
          "a".repeat(64),
        ]);
      })(),
    );
    const old = await oldRecovery(f),
      o = await plan(f);
    await prepareOperationalB({ ...o, previousRecovery: old.recovery });
    await stageOperationalB({
      ...o,
      previousTrustedTransition: null,
      transport: async (_action, r) => mockStatus(r),
    });
    const before = f.snapshot();
    for (const table of [
      "sync_series",
      "sync_slots",
      "sync_import_provenance",
      "sync_aliases",
    ])
      expect(before[table].length).toBeGreaterThan(0);
    await requestAnchorActivation(await mockActivationOptions(f, o), true);
    for (const table of [
      ...Object.keys(financialTableTypes),
      "sync_identity",
      "sync_series",
      "sync_slots",
      "sync_import_provenance",
      "sync_aliases",
    ])
      expect(f.snapshot()[table]).toEqual(before[table]);
  }, 30000);
});
