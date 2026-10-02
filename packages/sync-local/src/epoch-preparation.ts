import {
  assertKeyVersion,
  assertDecimal64,
  exactObject,
  canonicalStringify,
  commitSigningInput,
  decodeCommit,
  encodeUtf8,
  epochBaselineManifestInput,
  epochKeyBaseSigningInput,
  epochStagingSigningInput,
  epochTransitionDigest,
  epochTransitionSigningInput,
  operationAssociatedData,
  stagingLimits,
  validateGrantChain,
  verifyEpochTransition,
  accumulateStagingEnvelope,
  initialEnvelopesSha256,
  type EpochBaselineManifest,
  type EpochStagingRequest,
  type EpochTransition,
  type StagingBegin,
  type StagingAction,
  type UnsignedCommit,
} from "@lionpocket/sync-protocol";
import {
  anchorPlanCommitments,
  epochArchiveColumns,
  plannedAnchorOperations,
} from "./epoch-archive";
import { DeviceProvisioning, type ProvisionedProfile } from "./provisioning";
import {
  makeRecovery,
  openRecovery,
  validateKeyCheckpoints,
  verifySignedRecovery,
  type SignedRecovery,
} from "./security";
import { sql, type LocalSyncDatabase } from "./transport-state";
import type { SqlRow, SqlWorkflow } from "./manual";
import type { SecretScope } from "./secrets";
import type { TransportSodium } from "./transport";

export const operationalBSchema = [
  `CREATE TABLE IF NOT EXISTS recovery_b_saga (
  restore_id TEXT PRIMARY KEY REFERENCES recovery_journal(restore_id),profile_b_json TEXT NOT NULL,
  begin_public_json TEXT NOT NULL,expected_secrets_json TEXT NOT NULL,recovery_source TEXT NOT NULL CHECK(recovery_source IN ('reused','new')),
  phase TEXT NOT NULL CHECK(phase IN ('identity_reserved','secrets_prepared','recovery_pending_confirmation','recovery_confirmed','staging','staged','prepared','cancelled')),
  recovery_json TEXT,recovery_confirmed INTEGER NOT NULL DEFAULT 0 CHECK(recovery_confirmed IN (0,1)),
  remote_started INTEGER NOT NULL DEFAULT 0 CHECK(remote_started IN (0,1)),
  last_device_seq TEXT NOT NULL DEFAULT '0',manifest_json TEXT,transition_json TEXT)`,
  `CREATE TRIGGER IF NOT EXISTS recovery_b_identity BEFORE UPDATE OF restore_id,profile_b_json,begin_public_json,expected_secrets_json,recovery_source ON recovery_b_saga
  BEGIN SELECT RAISE(ABORT,'B reservation is immutable'); END`,
  ...["recovery_json", "manifest_json", "transition_json"].map(
    (
      c,
    ) => `CREATE TRIGGER IF NOT EXISTS recovery_b_${c} BEFORE UPDATE OF ${c} ON recovery_b_saga
  WHEN OLD.${c} IS NOT NULL AND OLD.${c} IS NOT NEW.${c} BEGIN SELECT RAISE(ABORT,'B artifact is immutable'); END`,
  ),
  `CREATE TRIGGER IF NOT EXISTS recovery_b_delete BEFORE DELETE ON recovery_b_saga BEGIN SELECT RAISE(ABORT,'B reservation is immutable'); END`,
  `CREATE TABLE IF NOT EXISTS recovery_b_envelopes (
  restore_id TEXT NOT NULL REFERENCES recovery_b_saga(restore_id),ordinal INTEGER NOT NULL,commit_id TEXT NOT NULL,
  envelope_text TEXT NOT NULL,digest TEXT NOT NULL,PRIMARY KEY(restore_id,ordinal),UNIQUE(restore_id,commit_id))`,
  `CREATE TABLE IF NOT EXISTS recovery_b_batches (
  restore_id TEXT NOT NULL REFERENCES recovery_b_saga(restore_id),batch_ordinal INTEGER NOT NULL,batch_text TEXT NOT NULL,digest TEXT NOT NULL,
  PRIMARY KEY(restore_id,batch_ordinal))`,
  ...["recovery_b_envelopes", "recovery_b_batches"].flatMap((t) =>
    ["UPDATE", "DELETE"].map(
      (action) =>
        `CREATE TRIGGER IF NOT EXISTS ${t}_${action.toLowerCase()} BEFORE ${action} ON ${t} BEGIN SELECT RAISE(ABORT,'B staging bytes are immutable'); END`,
    ),
  ),
];
function recoveryRun(workflow: SqlWorkflow) {
  workflow.preserveUncapturedWrites = true;
  return workflow;
}
function* statements(
  items: Array<{ sql: string; params?: (string | number | null)[] }>,
): SqlWorkflow {
  for (const item of items) yield sql(item.sql, item.params);
}
async function write(
  db: LocalSyncDatabase,
  items: Array<{ sql: string; params?: (string | number | null)[] }>,
) {
  await db.run(recoveryRun(statements(items)));
}
export type PreparationFault = (step: string) => void | Promise<void>;
interface BaseOptions {
  db: LocalSyncDatabase;
  deviceA: DeviceProvisioning;
  sodium: TransportSodium;
  restoreId: string;
  fault?: PreparationFault;
}
async function attempt(o: BaseOptions) {
  const [row] = await o.db.read(
    "SELECT * FROM recovery_b_saga WHERE restore_id=?",
    [o.restoreId],
  );
  if (!row || row.phase === "cancelled")
    throw new Error("recovery_attempt_missing");
  return row;
}
function deviceB(o: BaseOptions, row: SqlRow) {
  return new DeviceProvisioning(
    JSON.parse(String(row.profile_b_json)) as ProvisionedProfile,
    o.deviceA.secrets,
    o.deviceA.crypto,
  );
}
/** Fail closed if any normal A sidecar changed after the archive; never prepare a stale plan. */
async function currentPlan(o: BaseOptions) {
  const [journal] = await o.db.read(
    "SELECT * FROM recovery_journal WHERE restore_id=?",
    [o.restoreId],
  );
  if (
    !journal ||
    journal.profile_a_json !== canonicalStringify(o.deviceA.profile)
  )
    throw new Error("recovery_attempt_mismatch");
  const commitments = await anchorPlanCommitments(o.db, o.restoreId, (t) =>
    o.deviceA.crypto.hash(t),
  );
  for (const [table, cols] of Object.entries(epochArchiveColumns)) {
    const cast = cols.map((c) => `CAST(${c} AS TEXT) AS ${c}`).join(",");
    const active = `SELECT ${cast} FROM ${table}`;
    const archived = `SELECT ${cast} FROM recovery_archive_${table} WHERE vault_id_scope=? AND epoch_scope=?`;
    const params = [journal.vault_id, journal.from_epoch];
    if (
      (
        await o.db.read(
          `SELECT * FROM (${active} EXCEPT ${archived}) LIMIT 1`,
          params,
        )
      ).length ||
      (
        await o.db.read(
          `SELECT * FROM (${archived} EXCEPT ${active}) LIMIT 1`,
          params,
        )
      ).length
    )
      throw new Error("epoch_archive_stale");
  }
  return { journal, commitments };
}
function secretDigest(
  d: DeviceProvisioning,
  purpose: SecretScope["purpose"],
  secret: Uint8Array,
) {
  return d.crypto.hash(
    canonicalStringify({
      context: "LionPocket/epoch-secret-reservation/v1",
      scope: d.scope(purpose),
      secret: d.crypto.encode(secret),
    }),
  );
}
async function verifySecrets(
  d: DeviceProvisioning,
  row: SqlRow,
  candidates?: Map<SecretScope["purpose"], Uint8Array>,
  fault?: PreparationFault,
) {
  const expected = JSON.parse(String(row.expected_secrets_json)) as Record<
    SecretScope["purpose"],
    string
  >;
  // Check the complete reservation before performing any write. Missing random material after process death is a blocker.
  for (const [purpose, digest] of Object.entries(expected)) {
    const p = purpose as SecretScope["purpose"],
      existing = await d.secrets.load(d.scope(p)),
      secret = existing ?? candidates?.get(p);
    try {
      if (!secret) throw new Error("secret_reservation_incomplete");
      if (secretDigest(d, p, secret) !== digest)
        throw new Error("secret_reservation_mismatch");
      if (p === "signingSeed" || p === "authoritySeed" || p === "boxSeed") {
        const pair =
          p === "boxSeed"
            ? d.crypto.sodium.crypto_box_seed_keypair(secret)
            : d.crypto.sodium.crypto_sign_seed_keypair(secret);
        d.crypto.erase(pair.privateKey);
        const publicKey =
          p === "signingSeed"
            ? d.profile.signingPublicKey
            : p === "boxSeed"
              ? d.profile.boxPublicKey
              : d.profile.pin.authorityPublicKey;
        if (d.crypto.encode(pair.publicKey) !== publicKey)
          throw new Error("secret_reservation_mismatch");
      }
    } finally {
      if (existing) d.crypto.erase(existing);
    }
  }
  for (const purpose of [
    "signingSeed",
    "boxSeed",
    "dataKey",
    "authoritySeed",
    "recoveryMaster",
  ] as const) {
    const p = purpose as SecretScope["purpose"],
      existing = await d.secrets.load(d.scope(p));
    if (existing) {
      d.crypto.erase(existing);
      continue;
    }
    const secret = candidates?.get(p);
    if (!secret) throw new Error("secret_reservation_incomplete");
    await d.secrets.store(d.scope(p), secret);
    await fault?.(`secret:${p}`);
  }
}
/** Explicit preparation only. The active saved profile and financial tables are never written.
 * A reserved-but-missing random secret is intentionally blocked, never silently replaced. See draft evidence. */
export async function prepareOperationalB(
  o: BaseOptions & { previousRecovery: SignedRecovery | null },
) {
  await write(
    o.db,
    operationalBSchema.map((sql) => ({ sql })),
  );
  const { journal, commitments } = await currentPlan(o);
  let row = (
    await o.db.read("SELECT * FROM recovery_b_saga WHERE restore_id=?", [
      o.restoreId,
    ])
  )[0];
  let candidates: Map<SecretScope["purpose"], Uint8Array> | undefined;
  try {
    if (!row) {
      const a = o.deviceA,
        authority = await a.secrets.load(a.scope("authoritySeed"));
      if (!authority) throw new Error("authority_secret_unavailable");
      candidates = new Map([
        ["authoritySeed", authority],
        ["signingSeed", o.sodium.randombytes_buf(32)],
        ["boxSeed", o.sodium.randombytes_buf(32)],
        ["dataKey", o.sodium.randombytes_buf(32)],
      ]);
      const pair = o.sodium.crypto_sign_seed_keypair(authority);
      a.crypto.erase(pair.privateKey);
      if (a.crypto.encode(pair.publicKey) !== a.profile.pin.authorityPublicKey)
        throw new Error("key_mismatch");
      const active = validateKeyCheckpoints(
        a.profile.keyCheckpoints ?? [],
        a.profile.pin,
        a.profile.grants,
        a,
      );
      if (active !== (a.profile.activeKeyVersion ?? a.profile.pin.keyVersion))
        throw new Error("key_version_mismatch");
      assertKeyVersion(active + 1);
      let master = await a.secrets.load(a.scope("recoveryMaster"));
      const reused = master !== null;
      if (o.previousRecovery)
        verifySignedRecovery(o.previousRecovery, a.profile.pin, a.crypto);
      if (master) {
        candidates.set("recoveryMaster", master);
        if (!o.previousRecovery) throw new Error("recovery_unavailable");
        const old = openRecovery(
          a,
          o.sodium,
          o.previousRecovery,
          "LP1." + a.crypto.encode(master),
        );
        if (
          old.activeKeyVersion > active ||
          BigInt(old.registryVersion) > BigInt(a.profile.checkpoint!.version)
        )
          throw new Error("invalid_recovery_bundle");
        // Every key and the authority opened from the old recovery must match the local trusted secrets.
        const oldAuthority = a.crypto.decode(old.authoritySignSeed);
        try {
          if (a.crypto.encode(oldAuthority) !== a.crypto.encode(authority))
            throw new Error("key_mismatch");
        } finally {
          a.crypto.erase(oldAuthority);
        }
        for (const k of old.dataKeys) {
          const key = await a.secrets.load(a.scope("dataKey", k.keyVersion));
          try {
            if (!key || a.crypto.encode(key) !== k.vaultKey)
              throw new Error("key_mismatch");
          } finally {
            if (key) a.crypto.erase(key);
          }
        }
      } else {
        master = o.sodium.randombytes_buf(32);
        candidates.set("recoveryMaster", master);
      }
      const deviceId = a.crypto.uuid(),
        sign = o.sodium.crypto_sign_seed_keypair(
          candidates.get("signingSeed")!,
        ),
        box = o.sodium.crypto_box_seed_keypair(candidates.get("boxSeed")!);
      a.crypto.erase(sign.privateKey);
      a.crypto.erase(box.privateKey);
      const profile: ProvisionedProfile = {
        formatVersion: 1,
        installationId: a.profile.installationId,
        deviceId,
        pin: {
          ...a.profile.pin,
          serverEpoch: String(journal.to_epoch),
          founderDeviceId: deviceId,
          keyVersion: active + 1,
        },
        signingPublicKey: a.crypto.encode(sign.publicKey),
        boxPublicKey: a.crypto.encode(box.publicKey),
        grants: [],
        activeKeyVersion: active + 1,
        keyCheckpoints: [],
      };
      const b = new DeviceProvisioning(profile, a.secrets, a.crypto);
      // Produce the initial registry using the standard signed grant primitive, without bootstrap or network.
      const { deviceGrantSigningInput } =
        await import("@lionpocket/sync-protocol");
      const grant = {
        formatVersion: 1 as const,
        serverId: profile.pin.serverId,
        serverEpoch: profile.pin.serverEpoch,
        vaultId: profile.pin.vaultId,
        registryVersion: "1",
        previousRegistrySha256: null,
        deviceId,
        signingPublicKey: profile.signingPublicKey,
        boxPublicKey: profile.boxPublicKey,
        status: "approved" as const,
      };
      profile.grants = [
        {
          ...grant,
          signature: a.crypto.sign(deviceGrantSigningInput(grant), authority),
        },
      ];
      profile.checkpoint = validateGrantChain(
        profile.grants,
        profile.pin,
        a.crypto,
      ).checkpoint;
      const base = {
        formatVersion: 1 as const,
        serverId: profile.pin.serverId,
        serverEpoch: profile.pin.serverEpoch,
        vaultId: profile.pin.vaultId,
        restoreId: o.restoreId,
        fromEpoch: a.profile.pin.serverEpoch,
        baseKeyVersion: active + 1,
        previousActiveKeyVersion: active,
        previousKeyCheckpointsSha256: a.crypto.hash(
          canonicalStringify(a.profile.keyCheckpoints ?? []),
        ),
      };
      const publicBegin = {
        authorization: JSON.parse(String(journal.authorization_json)),
        pin: profile.pin,
        registry: profile.grants,
        keyBase: {
          ...base,
          signature: a.crypto.sign(epochKeyBaseSigningInput(base), authority),
        },
        knownKeyCheckpoints: a.profile.keyCheckpoints ?? [],
        previousRecovery: o.previousRecovery,
        archiveSha256: commitments.archiveSha256,
        mappingSha256: commitments.mappingSha256,
        operationCount: commitments.operationCount,
        headsSha256: commitments.headsSha256,
      };
      const expected = Object.fromEntries(
        [...candidates].map(([p, s]) => [p, secretDigest(b, p, s)]),
      );
      await write(o.db, [
        {
          sql: `INSERT INTO recovery_b_saga(restore_id,profile_b_json,begin_public_json,expected_secrets_json,recovery_source,phase)
    VALUES(?,?,?,?,?,'identity_reserved')`,
          params: [
            o.restoreId,
            canonicalStringify(profile),
            canonicalStringify(publicBegin),
            canonicalStringify(expected),
            reused ? "reused" : "new",
          ],
        },
      ]);
      await o.fault?.("identity_reserved");
      row = await attempt(o);
    }
    const b = deviceB(o, row);
    await verifySecrets(b, row, candidates, o.fault);
    if (row.phase === "identity_reserved")
      await write(o.db, [
        {
          sql: "UPDATE recovery_b_saga SET phase='secrets_prepared' WHERE restore_id=?",
          params: [o.restoreId],
        },
      ]);
    row = await attempt(o);
    if (!row.recovery_json) {
      const master = await b.secrets.load(b.scope("recoveryMaster"));
      if (!master) throw new Error("secret_unavailable");
      try {
        const begin = JSON.parse(String(row.begin_public_json));
        const version = (
          BigInt(begin.previousRecovery?.envelope.recoveryVersion ?? "0") + 1n
        ).toString();
        const recovery = await makeRecovery(b, o.sodium, version, master);
        await write(o.db, [
          {
            sql: "UPDATE recovery_b_saga SET recovery_json=?,phase='recovery_pending_confirmation' WHERE restore_id=?",
            params: [canonicalStringify(recovery.recovery), o.restoreId],
          },
        ]);
      } finally {
        b.crypto.erase(master);
      }
      await o.fault?.("recovery_created");
    }
    row = await attempt(o);
    if (row.recovery_source === "reused" && !row.recovery_confirmed) {
      const master = await b.secrets.load(b.scope("recoveryMaster"));
      if (!master) throw new Error("secret_unavailable");
      try {
        await confirmOperationalBRecovery(o, "LP1." + b.crypto.encode(master));
      } finally {
        b.crypto.erase(master);
      }
    }
    row = await attempt(o);
    let code: string | undefined;
    if (row.recovery_source === "new" && !row.recovery_confirmed) {
      const master = await b.secrets.load(b.scope("recoveryMaster"));
      if (!master) throw new Error("secret_unavailable");
      try {
        code = "LP1." + b.crypto.encode(master);
      } finally {
        b.crypto.erase(master);
      }
    }
    return {
      profile: b.profile,
      recovery: JSON.parse(String(row.recovery_json)) as SignedRecovery,
      phase: String(row.phase),
      ...(code ? { code } : {}),
      activationAvailable: false as const,
    };
  } finally {
    if (candidates)
      for (const s of candidates.values()) o.deviceA.crypto.erase(s);
  }
}
export async function confirmOperationalBRecovery(
  o: BaseOptions,
  code: string,
) {
  const row = await attempt(o),
    b = deviceB(o, row);
  await verifySecrets(b, row);
  if (!row.recovery_json) throw new Error("recovery_unavailable");
  const bundle = openRecovery(
    b,
    o.sodium,
    JSON.parse(String(row.recovery_json)),
    code,
  );
  if (
    bundle.formatVersion !== 2 ||
    bundle.baseKeyVersion !== b.profile.pin.keyVersion ||
    bundle.activeKeyVersion !== b.profile.activeKeyVersion ||
    bundle.registryVersion !== b.profile.checkpoint!.version
  )
    throw new Error("invalid_recovery_bundle");
  for (const k of bundle.dataKeys) {
    const key = await b.secrets.load(b.scope("dataKey", k.keyVersion));
    try {
      if (!key || b.crypto.encode(key) !== k.vaultKey)
        throw new Error("key_mismatch");
    } finally {
      if (key) b.crypto.erase(key);
    }
  }
  const master = await b.secrets.load(b.scope("recoveryMaster"));
  try {
    if (!master || "LP1." + b.crypto.encode(master) !== code)
      throw new Error("invalid_recovery_code");
  } finally {
    if (master) b.crypto.erase(master);
  }
  if (!row.recovery_confirmed)
    await write(o.db, [
      {
        sql: "UPDATE recovery_b_saga SET recovery_confirmed=1,phase='recovery_confirmed' WHERE restore_id=?",
        params: [o.restoreId],
      },
    ]);
  await o.fault?.("recovery_confirmed");
}
/** Owner OIDC transport; intentionally independent of the normal A coordinator and HTTP-proof route. */
export type StagingTransport = (
  action: StagingAction,
  request: EpochStagingRequest,
) => Promise<unknown>;
export async function stageOperationalB(
  o: BaseOptions & {
    transport: StagingTransport;
    previousTrustedTransition: EpochTransition | null;
  },
) {
  let row = await attempt(o);
  if (!row.recovery_confirmed)
    throw new Error("recovery_confirmation_required");
  const { commitments } = await currentPlan(o),
    b = deviceB(o, row);
  await verifySecrets(b, row);
  const begin = {
    recoveryConfirmed: true,
    ...JSON.parse(String(row.begin_public_json)),
    recovery: JSON.parse(String(row.recovery_json)),
  } as StagingBegin;
  if (
    begin.archiveSha256 !== commitments.archiveSha256 ||
    begin.mappingSha256 !== commitments.mappingSha256 ||
    begin.headsSha256 !== commitments.headsSha256
  )
    throw new Error("epoch_archive_stale");
  const send = async (action: StagingAction, payload: unknown) => {
    const seed = await b.secrets.load(b.scope("signingSeed"));
    if (!seed) throw new Error("secret_unavailable");
    try {
      const unsigned = {
        formatVersion: 1 as const,
        vaultId: b.profile.pin.vaultId,
        restoreId: o.restoreId,
        action,
        payload,
      };
      const response = exactObject(
        await o.transport(action, {
          ...unsigned,
          signature: b.crypto.sign(epochStagingSigningInput(unsigned), seed),
        }),
        [
          "state",
          "commitCount",
          "operationCount",
          "batchCount",
          "activationAvailable",
          "readyForActivation",
        ],
      );
      for (const field of ["commitCount", "operationCount", "batchCount"])
        assertDecimal64(response[field]);
      if (
        !["uploading", "validated", "prepared"].includes(
          String(response.state),
        ) ||
        response.activationAvailable !== false ||
        typeof response.readyForActivation !== "boolean"
      )
        throw new Error("invalid_staging_response");
      return response;
    } finally {
      b.crypto.erase(seed);
    }
  };
  if (!row.remote_started)
    await write(o.db, [
      {
        sql: "UPDATE recovery_b_saga SET remote_started=1,phase='staging' WHERE restore_id=?",
        params: [o.restoreId],
      },
    ]);
  await send("begin", begin);
  await o.fault?.("begin");
  const page = await plannedAnchorOperations(o.db, o.restoreId);
  const seed = await b.secrets.load(b.scope("signingSeed")),
    key = await b.secrets.load(b.scope("dataKey"));
  if (!seed || !key) {
    if (seed) b.crypto.erase(seed);
    if (key) b.crypto.erase(key);
    throw new Error("secret_unavailable");
  }
  let ordinal = 0,
    batchOrdinal = 0,
    digest = initialEnvelopesSha256(
      {
        restoreId: o.restoreId,
        vaultId: b.profile.pin.vaultId,
        fromEpoch: o.deviceA.profile.pin.serverEpoch,
        toEpoch: b.profile.pin.serverEpoch,
      },
      b.crypto,
    );
  try {
    for (;;) {
      const operations = await page(ordinal);
      if (!operations.length) break;
      const envelopes: string[] = [];
      for (const op of operations) {
        const existing = (
          await o.db.read(
            "SELECT envelope_text FROM recovery_b_envelopes WHERE restore_id=? AND ordinal=?",
            [o.restoreId, op.ordinal],
          )
        )[0];
        let text: string;
        if (existing) text = String(existing.envelope_text);
        else {
          const unsigned: UnsignedCommit = {
            protocolVersion: 1,
            serverId: b.profile.pin.serverId,
            serverEpoch: b.profile.pin.serverEpoch,
            vaultId: b.profile.pin.vaultId,
            deviceId: b.profile.deviceId,
            deviceSeq: String(op.ordinal),
            commitId: op.commitId,
            keyVersion: b.profile.pin.keyVersion,
            deviceRegistryVersion: "1",
            cryptoSuite: "lp-sodium-v1",
            operations: [
              {
                opId: op.opId,
                objectId: op.objectId,
                parents: op.parents,
                nonce: b.crypto.encode(o.sodium.randombytes_buf(24)),
                ciphertext: "",
              },
            ],
          };
          const bytes = encodeUtf8(canonicalStringify(op.revision));
          try {
            unsigned.operations[0].ciphertext = b.crypto.encode(
              o.sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
                bytes,
                operationAssociatedData(unsigned, 0),
                null,
                b.crypto.decode(unsigned.operations[0].nonce),
                key,
              ),
            );
          } finally {
            b.crypto.erase(bytes);
          }
          text = canonicalStringify({
            ...unsigned,
            signature: b.crypto.sign(commitSigningInput(unsigned), seed),
          });
          decodeCommit(encodeUtf8(text));
          await write(o.db, [
            {
              sql: "INSERT INTO recovery_b_envelopes VALUES(?,?,?,?,?)",
              params: [
                o.restoreId,
                op.ordinal,
                op.commitId,
                text,
                b.crypto.hash(text),
              ],
            },
          ]);
          await o.fault?.("envelope");
        }
        envelopes.push(text);
      }
      // Deterministic partition by the request byte cap as well as the planner's 100-row page.
      let start = 0;
      while (start < envelopes.length) {
        const selected: string[] = [];
        let next = start;
        while (
          next < envelopes.length &&
          selected.length < stagingLimits.commitsPerBatch
        ) {
          const proposed = {
            batchOrdinal: String(batchOrdinal + 1),
            firstOrdinal: String(operations[start].ordinal),
            lastOrdinal: String(operations[next].ordinal),
            envelopes: [...selected, envelopes[next]],
          };
          if (
            encodeUtf8(canonicalStringify(proposed)).length + 1024 >
            stagingLimits.requestBytes
          )
            break;
          selected.push(envelopes[next++]);
        }
        if (!selected.length) throw new Error("payload_too_large");
        batchOrdinal++;
        if (batchOrdinal > stagingLimits.maxBatches)
          throw new Error("payload_too_large");
        const batch = {
          batchOrdinal: String(batchOrdinal),
          firstOrdinal: String(operations[start].ordinal),
          lastOrdinal: String(operations[next - 1].ordinal),
          envelopes: selected,
        };
        const text = canonicalStringify(batch),
          prior = (
            await o.db.read(
              "SELECT batch_text FROM recovery_b_batches WHERE restore_id=? AND batch_ordinal=?",
              [o.restoreId, batchOrdinal],
            )
          )[0];
        if (prior && prior.batch_text !== text)
          throw new Error("idempotency_mismatch");
        if (!prior)
          await write(o.db, [
            {
              sql: "INSERT INTO recovery_b_batches VALUES(?,?,?,?)",
              params: [o.restoreId, batchOrdinal, text, b.crypto.hash(text)],
            },
          ]);
        await send("batch", batch);
        await o.fault?.("batch");
        for (let i = start; i < next; i++)
          digest = accumulateStagingEnvelope(
            digest,
            String(operations[i].ordinal),
            String(batchOrdinal),
            operations[i].commitId,
            envelopes[i],
            b.crypto,
          );
        start = next;
      }
      ordinal = operations[operations.length - 1].ordinal;
    }
  } finally {
    b.crypto.erase(seed);
    b.crypto.erase(key);
  }
  await currentPlan(o);
  const h = (v: unknown) => b.crypto.hash(canonicalStringify(v));
  const manifest: EpochBaselineManifest = {
    formatVersion: 1,
    serverId: b.profile.pin.serverId,
    vaultId: b.profile.pin.vaultId,
    serverEpoch: b.profile.pin.serverEpoch,
    restoreId: o.restoreId,
    anchorDeviceId: b.profile.deviceId,
    authorizationSha256: h(begin.authorization),
    registrySha256: h(begin.registry),
    keyCheckpointSha256: h(begin.keyBase),
    recoverySha256: h(begin.recovery),
    archiveSha256: begin.archiveSha256,
    mappingSha256: begin.mappingSha256,
    commitCount: String(ordinal),
    operationCount: commitments.operationCount,
    batchCount: String(batchOrdinal),
    envelopesSha256: digest,
    headsSha256: commitments.headsSha256,
  };
  row = await attempt(o);
  if (row.manifest_json && row.manifest_json !== canonicalStringify(manifest))
    throw new Error("idempotency_mismatch");
  if (!row.manifest_json)
    await write(o.db, [
      {
        sql: "UPDATE recovery_b_saga SET manifest_json=?,last_device_seq=?,phase='staged' WHERE restore_id=?",
        params: [canonicalStringify(manifest), String(ordinal), o.restoreId],
      },
    ]);
  await o.fault?.("manifest");
  await send("validate", manifest);
  await o.fault?.("validate");
  let transition: EpochTransition;
  if (row.transition_json) transition = JSON.parse(String(row.transition_json));
  else {
    const unsigned = {
      formatVersion: 1 as const,
      serverId: b.profile.pin.serverId,
      vaultId: b.profile.pin.vaultId,
      fromEpoch: o.deviceA.profile.pin.serverEpoch,
      toEpoch: b.profile.pin.serverEpoch,
      restoreId: o.restoreId,
      authorityPublicKey: b.profile.pin.authorityPublicKey,
      authorizationSha256: manifest.authorizationSha256,
      restoredStateSha256: begin.authorization.restoredStateSha256,
      manifestSha256: b.crypto.hash(epochBaselineManifestInput(manifest)),
      trustPinSha256: h(b.profile.pin),
      registrySha256: manifest.registrySha256,
      keyCheckpointSha256: manifest.keyCheckpointSha256,
      recoverySha256: manifest.recoverySha256,
      archiveSha256: manifest.archiveSha256,
      mappingSha256: manifest.mappingSha256,
      previousTransitionSha256: o.previousTrustedTransition
        ? epochTransitionDigest(o.previousTrustedTransition, b.crypto)
        : null,
    };
    const authority = await b.secrets.load(b.scope("authoritySeed"));
    if (!authority) throw new Error("authority_secret_unavailable");
    try {
      transition = {
        ...unsigned,
        signature: b.crypto.sign(
          epochTransitionSigningInput(unsigned),
          authority,
        ),
      };
    } finally {
      b.crypto.erase(authority);
    }
  }
  verifyEpochTransition(
    transition,
    {
      fromPin: o.deviceA.profile.pin,
      toPin: b.profile.pin,
      authorization: begin.authorization,
      manifest,
      registry: begin.registry,
      keyCheckpoint: begin.keyBase,
      recovery: begin.recovery,
      previousTransition: o.previousTrustedTransition,
    },
    b.crypto,
  );
  if (!row.transition_json)
    await write(o.db, [
      {
        sql: "UPDATE recovery_b_saga SET transition_json=? WHERE restore_id=?",
        params: [canonicalStringify(transition), o.restoreId],
      },
    ]);
  await o.fault?.("transition");
  await currentPlan(o);
  const response = await send("prepare", { manifest, transition });
  if (
    response.state !== "prepared" ||
    response.commitCount !== manifest.commitCount ||
    response.operationCount !== manifest.operationCount ||
    response.batchCount !== manifest.batchCount
  )
    throw new Error("invalid_staging_response");
  await o.fault?.("remote_prepared");
  await write(o.db, [
    {
      sql: "UPDATE recovery_b_saga SET phase='prepared' WHERE restore_id=?",
      params: [o.restoreId],
    },
  ]);
  return { manifest, transition, activationAvailable: false as const };
}
export async function cancelOperationalB(o: BaseOptions) {
  const row = await attempt(o);
  if (row.remote_started) throw new Error("remote_staging_requires_resume");
  await write(o.db, [
    {
      sql: "UPDATE recovery_b_saga SET phase='cancelled' WHERE restore_id=?",
      params: [o.restoreId],
    },
  ]);
}
