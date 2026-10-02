import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import sodium from "libsodium-wrappers-sumo";
import {
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
import { founder } from "../../../../sync-server/src/testSupport";
import { LionPocketDatabase } from "../database";
import {
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
async function fixture(dialect: "desktop" | "android" = "desktop") {
  const directory = mkdtempSync(join(tmpdir(), "lp-anchor-archive-test-"));
  dispose.push(() => rmSync(directory, { force: true, recursive: true }));
  const crypto = new ProvisioningCrypto(sodium),
    { client } = await founder(crypto);
  const bank =
    dialect === "desktop"
      ? new LionPocketDatabase(join(directory, "anchor.sqlite"))
      : null;
  const mobile =
    dialect === "android"
      ? sqliteTestConnection(join(directory, "anchor.sqlite"))
      : null;
  if (mobile) await migrate(mobile.db);
  const sqlite = bank?.db ?? mobile!.sqlite;
  dispose.push(() => sqlite.close());
  sqlite.exec(
    "DELETE FROM categories; DELETE FROM payment_methods; DELETE FROM cards;",
  );
  const db = bank?.syncDatabase() ?? mobileSyncDatabase(mobile!.db);
  const repo = mobile ? new MobileRepository(mobile.db, randomUUID) : null;
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
    client,
    sqlite,
    db,
    directory,
    prepare,
    snapshot,
    acceptedAuthorization,
    save,
    bank,
    mobile,
    crypto,
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
      const akey = await f.client.secrets.load(f.client.scope("dataKey")),
        bkey = await b.secrets.load(b.scope("dataKey"));
      expect(akey).not.toEqual(bkey);
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
    "identity_reserved",
    "secret:signingSeed",
    "secret:boxSeed",
    "secret:dataKey",
    "secret:authoritySeed",
  ])(
    "draft blocker: crash at %s preserves A and refuses missing reserved secrets",
    async (fault) => {
      const f = await fixture(),
        o = await plan(f),
        before = f.snapshot();
      await expect(
        prepareOperationalB({
          ...o,
          previousRecovery: null,
          fault: (s) => {
            if (s === fault) throw new Error("crash");
          },
        }),
      ).rejects.toThrow("crash");
      await expect(
        prepareOperationalB({ ...o, previousRecovery: null }),
      ).rejects.toThrow("secret_reservation_incomplete");
      expect(f.snapshot()).toEqual(before);
      expect(
        f.sqlite.prepare("SELECT remote_started FROM recovery_b_saga").get()!
          .remote_started,
      ).toBe(0);
    },
  );
  it.each(["secret:recoveryMaster", "recovery_created", "recovery_confirmed"])(
    "resumes after all secrets exist: %s",
    async (fault) => {
      const f = await fixture(),
        old = await oldRecovery(f),
        o = await plan(f);
      let once = true;
      await expect(
        prepareOperationalB({
          ...o,
          previousRecovery: old.recovery,
          fault: (s) => {
            if (once && s === fault) {
              once = false;
              throw new Error("crash");
            }
          },
        }),
      ).rejects.toThrow("crash");
      expect(
        (await prepareOperationalB({ ...o, previousRecovery: old.recovery }))
          .phase,
      ).toBe("recovery_confirmed");
    },
  );
  it.each([
    "begin",
    "envelope",
    "batch",
    "manifest",
    "validate",
    "transition",
    "remote_prepared",
  ])("reuses byte-identical envelopes after %s", async (fault) => {
    const f = await fixture(),
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
    await stageOperationalB({
      ...o,
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
    },
  );
}, 30000);
