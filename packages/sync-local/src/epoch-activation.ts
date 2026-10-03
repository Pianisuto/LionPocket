import {
  assertEpochActivationRecord,
  assertEpochActivationRequest,
  canonicalStringify,
  commitSigningInput,
  decodeCommit,
  decodeUtf8,
  encodeUtf8,
  epochActivationSigningInput,
  epochBaselineManifestInput,
  epochTransitionDigest,
  operationAssociatedData,
  verifyEpochActivationRequest,
  verifyEpochTransition,
  accumulateStagingEnvelope,
  initialEnvelopesSha256,
  type EpochActivationRequest,
  type EpochActivationRecord,
  type EpochActivationStatus,
  type EpochBaselineManifest,
  type EpochTransition,
  type StagingBegin,
} from "@lionpocket/sync-protocol";
import {
  validatePreparedOperationalB,
  type PreparationFault,
} from "./epoch-preparation";
import {
  plannedAnchorOperations,
  epochArchiveColumns,
  verifyAnchorPlanBackup,
  type AnchorBackupInspection,
  type VerifiedAnchorBackup,
} from "./epoch-archive";
import { DeviceProvisioning, type ProvisionedProfile } from "./provisioning";
import { financialTableTypes, syncTables, syncColumns } from "./schema";
import {
  applyCommit,
  sql,
  type LocalSyncDatabase,
  type ProjectionDialect,
} from "./transport-state";
import type { TransportSodium } from "./transport";
import type { SqlWorkflow, SqlRow } from "./manual";
import type { BaselineOperation } from "./epoch-replay";

/** Separate from the preparation secret phases. The intention and audit artifacts are immutable. */
export const epochActivationSchema = [
  `CREATE TABLE IF NOT EXISTS recovery_activation_saga (
    restore_id TEXT PRIMARY KEY REFERENCES recovery_b_saga(restore_id),activation_id TEXT NOT NULL UNIQUE,
    request_text TEXT NOT NULL,request_sha256 TEXT NOT NULL,manifest_sha256 TEXT NOT NULL,transition_sha256 TEXT NOT NULL,
    to_epoch TEXT NOT NULL,binding_id TEXT NOT NULL UNIQUE,financial_sha256 TEXT NOT NULL,
    phase TEXT NOT NULL CHECK(phase IN ('activation_requested','remote_active','installing_local','local_db_installed','profile_installed','finalizing','recovered')),
    remote_record TEXT,checkpoint_path TEXT,checkpoint_sha256 TEXT)`,
  `CREATE TRIGGER IF NOT EXISTS recovery_activation_identity BEFORE UPDATE OF restore_id,activation_id,request_text,request_sha256,
    manifest_sha256,transition_sha256,to_epoch,binding_id,financial_sha256 ON recovery_activation_saga BEGIN SELECT RAISE(ABORT,'Activation intention is immutable'); END`,
  ...["remote_record", "checkpoint_path", "checkpoint_sha256"].map(
    (
      c,
    ) => `CREATE TRIGGER IF NOT EXISTS recovery_activation_${c} BEFORE UPDATE OF ${c} ON recovery_activation_saga
    WHEN OLD.${c} IS NOT NULL AND NEW.${c} IS NOT OLD.${c} BEGIN SELECT RAISE(ABORT,'Activation evidence is immutable'); END`,
  ),
  `CREATE TRIGGER IF NOT EXISTS recovery_activation_delete BEFORE DELETE ON recovery_activation_saga BEGIN SELECT RAISE(ABORT,'Activation intention is immutable'); END`,
];
export interface AnchorActivationOptions {
  db: LocalSyncDatabase;
  deviceA: DeviceProvisioning;
  sodium: TransportSodium;
  restoreId: string;
  dialect: ProjectionDialect;
  endpoint: string;
  /** Both routes receive exactly the durable canonical request bytes. */
  transport(
    action: "activate" | "status",
    request: EpochActivationRequest,
  ): Promise<unknown>;
  inspectBackup(path: string): Promise<AnchorBackupInspection>;
  checkpoint(): Promise<VerifiedAnchorBackup>;
  /** Inspect a closed, consistent checkpoint including its remote_active saga. */
  inspectCheckpoint(
    path: string,
  ): Promise<{ sha256: string; requestSha256: string; phase: string }>;
  saveProfile(profile: ProvisionedProfile): Promise<void>;
  loadProfile(): Promise<ProvisionedProfile | null>;
  /** Normal signed /changes pull, under B, while foreground remains excluded by the saga. */
  firstPull(device: DeviceProvisioning): Promise<void>;
  fault?: PreparationFault;
}
function durable(w: SqlWorkflow) {
  w.preserveUncapturedWrites = true;
  return w;
}
function* validateLiveArchive(
  o: AnchorActivationOptions,
  journal: SqlRow,
): SqlWorkflow {
  for (const [table, cols] of Object.entries(epochArchiveColumns)) {
    const columns = cols
      .filter((c) => table !== "sync_control" || c !== "paused")
      .map((c) => `CAST(${c} AS TEXT) AS ${c}`)
      .join(",");
    const active = `SELECT ${columns} FROM main.${table}`;
    const archived = `SELECT ${columns} FROM main.recovery_archive_${table} WHERE vault_id_scope=? AND epoch_scope=?`;
    const args = [journal.vault_id, journal.from_epoch];
    if (
      (yield sql(`SELECT * FROM (${active} EXCEPT ${archived}) LIMIT 1`, args))
        .length ||
      (yield sql(`SELECT * FROM (${archived} EXCEPT ${active}) LIMIT 1`, args))
        .length
    )
      throw new Error("epoch_archive_stale");
  }
}
async function phase(o: AnchorActivationOptions, value: string) {
  await o.db.run(
    durable(
      (function* (): SqlWorkflow {
        yield sql(
          "UPDATE recovery_activation_saga SET phase=? WHERE restore_id=?",
          [value, o.restoreId],
        );
      })(),
    ),
  );
}
async function financialDigest(
  db: Pick<LocalSyncDatabase, "read">,
  device: DeviceProvisioning,
) {
  const tables: Record<string, string[]> = {};
  for (const table of Object.keys(financialTableTypes))
    tables[table] = (await db.read(`SELECT * FROM main.${table}`))
      .map((r) => canonicalStringify(r))
      .sort();
  return device.crypto.hash(canonicalStringify(tables));
}
async function activationRow(o: AnchorActivationOptions) {
  return (
    await o.db.read(
      "SELECT * FROM recovery_activation_saga WHERE restore_id=?",
      [o.restoreId],
    )
  )[0];
}
async function artifacts(o: AnchorActivationOptions, liveA: boolean) {
  await verifyAnchorPlanBackup(o.db);
  const prepared = await validatePreparedOperationalB(o, liveA),
    b = prepared.device;
  const manifest: EpochBaselineManifest = JSON.parse(
    String(prepared.row.manifest_json),
  );
  const transition: EpochTransition = JSON.parse(
    String(prepared.row.transition_json),
  );
  const begin: StagingBegin = {
    recoveryConfirmed: true,
    ...JSON.parse(String(prepared.row.begin_public_json)),
    recovery: JSON.parse(String(prepared.row.recovery_json)),
  };
  const previousRows = await o.db.read(
    `SELECT transition_json FROM recovery_b_saga b JOIN recovery_journal j USING(restore_id)
    WHERE j.vault_id=? AND j.to_epoch=?`,
    [b.profile.pin.vaultId, o.deviceA.profile.pin.serverEpoch],
  );
  const previous = previousRows[0]?.transition_json
    ? JSON.parse(String(previousRows[0].transition_json))
    : null;
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
      previousTransition: previous,
    },
    b.crypto,
  );
  if (
    manifest.archiveSha256 !== prepared.commitments.archiveSha256 ||
    manifest.mappingSha256 !== prepared.commitments.mappingSha256 ||
    manifest.headsSha256 !== prepared.commitments.headsSha256 ||
    manifest.operationCount !== prepared.commitments.operationCount
  )
    throw new Error("activation_mismatch");
  const operations: BaselineOperation[] = [],
    envelopes: { text: string; ordinal: string }[] = [];
  const page = await plannedAnchorOperations(o.db, o.restoreId);
  const key = await b.secrets.load(b.scope("dataKey"));
  if (!key) throw new Error("secret_unavailable");
  let cursor = 0,
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
      const rows = await page(cursor);
      if (!rows.length) break;
      for (const op of rows) {
        const [stored] = await o.db.read(
          "SELECT * FROM recovery_b_envelopes WHERE restore_id=? AND ordinal=?",
          [o.restoreId, op.ordinal],
        );
        if (!stored) throw new Error("activation_mismatch");
        const text = String(stored.envelope_text),
          e = decodeCommit(encodeUtf8(text));
        const { signature, ...unsigned } = e;
        if (
          canonicalStringify(e) !== text ||
          b.crypto.hash(text) !== stored.digest ||
          e.commitId !== op.commitId ||
          e.deviceId !== b.profile.deviceId ||
          e.serverId !== b.profile.pin.serverId ||
          e.serverEpoch !== b.profile.pin.serverEpoch ||
          e.vaultId !== b.profile.pin.vaultId ||
          e.deviceSeq !== String(op.ordinal) ||
          e.keyVersion !== b.profile.pin.keyVersion ||
          e.deviceRegistryVersion !== "1" ||
          e.operations.length !== 1 ||
          e.operations[0].opId !== op.opId ||
          e.operations[0].objectId !== op.objectId ||
          e.operations[0].expectedHeads !== undefined ||
          canonicalStringify(e.operations[0].parents) !==
            canonicalStringify(op.parents) ||
          !b.crypto.verify(
            signature,
            commitSigningInput(unsigned),
            b.profile.signingPublicKey,
          )
        )
          throw new Error("activation_mismatch");
        const plaintext = o.sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
          null,
          b.crypto.decode(e.operations[0].ciphertext),
          operationAssociatedData(unsigned, 0),
          b.crypto.decode(e.operations[0].nonce),
          key,
        );
        if (!plaintext) throw new Error("invalid_ciphertext");
        try {
          if (decodeUtf8(plaintext) !== canonicalStringify(op.revision))
            throw new Error("activation_mismatch");
        } finally {
          b.crypto.erase(plaintext);
        }
        const [batch] = await o.db.read(
          "SELECT batch_ordinal FROM recovery_b_batches WHERE restore_id=? AND CAST(json_extract(batch_text,'$.firstOrdinal') AS INTEGER)<=? AND CAST(json_extract(batch_text,'$.lastOrdinal') AS INTEGER)>=?",
          [o.restoreId, op.ordinal, op.ordinal],
        );
        if (!batch) throw new Error("activation_mismatch");
        digest = accumulateStagingEnvelope(
          digest,
          String(op.ordinal),
          String(batch.batch_ordinal),
          op.commitId,
          text,
          b.crypto,
        );
        cursor = op.ordinal;
        operations.push(op);
        envelopes.push({ text, ordinal: String(op.ordinal) });
      }
    }
  } finally {
    b.crypto.erase(key);
  }
  if (
    String(cursor) !== manifest.commitCount ||
    digest !== manifest.envelopesSha256 ||
    (
      await o.db.read(
        "SELECT count(*) AS n FROM recovery_b_envelopes WHERE restore_id=?",
        [o.restoreId],
      )
    )[0].n !== cursor
  )
    throw new Error("activation_mismatch");
  return { ...prepared, b, manifest, transition, begin, operations, envelopes };
}
function verifyRemote(
  o: AnchorActivationOptions,
  a: Awaited<ReturnType<typeof artifacts>>,
  row: SqlRow,
  record: unknown,
) {
  assertEpochActivationRecord(record);
  const request: EpochActivationRequest = JSON.parse(String(row.request_text));
  assertEpochActivationRequest(request);
  verifyEpochActivationRequest(
    request,
    a.b.profile.signingPublicKey,
    a.b.crypto,
  );
  const { signature, ...unsigned } = request;
  void signature;
  const expected: EpochActivationRecord = {
    ...unsigned,
    requestSha256: a.b.crypto.hash(String(row.request_text)),
    trustPinSha256: a.b.crypto.hash(canonicalStringify(a.b.profile.pin)),
    logPosition: a.manifest.commitCount,
    commitCount: a.manifest.commitCount,
    operationCount: a.manifest.operationCount,
  };
  if (
    row.request_sha256 !== expected.requestSha256 ||
    row.manifest_sha256 !==
      a.b.crypto.hash(epochBaselineManifestInput(a.manifest)) ||
    row.transition_sha256 !== epochTransitionDigest(a.transition, a.b.crypto) ||
    row.to_epoch !== a.b.profile.pin.serverEpoch ||
    request.manifestSha256 !== row.manifest_sha256 ||
    request.transitionSha256 !== row.transition_sha256 ||
    request.serverId !== a.b.profile.pin.serverId ||
    request.vaultId !== a.b.profile.pin.vaultId ||
    request.toEpoch !== row.to_epoch ||
    request.fromEpoch !== o.deviceA.profile.pin.serverEpoch ||
    request.anchorDeviceId !== a.b.profile.deviceId ||
    request.restoreId !== o.restoreId ||
    canonicalStringify(record) !== canonicalStringify(expected)
  )
    throw new Error("activation_mismatch");
  return record;
}
/** Explicit user confirmation is needed only to create the durable intention, never to resume it. */
export async function requestAnchorActivation(
  o: AnchorActivationOptions,
  confirmed: boolean,
) {
  await o.db.run(
    durable(
      (function* (): SqlWorkflow {
        for (const statement of epochActivationSchema) yield sql(statement);
      })(),
    ),
  );
  let row = await activationRow(o);
  if (!row) {
    if (confirmed !== true)
      throw new Error("epoch_activation_confirmation_required");
    const a = await artifacts(o, true),
      crypto = a.b.crypto;
    const unsigned = {
      formatVersion: 1 as const,
      activationId: crypto.uuid(),
      serverId: a.b.profile.pin.serverId,
      vaultId: a.b.profile.pin.vaultId,
      restoreId: o.restoreId,
      fromEpoch: o.deviceA.profile.pin.serverEpoch,
      toEpoch: a.b.profile.pin.serverEpoch,
      anchorDeviceId: a.b.profile.deviceId,
      manifestSha256: crypto.hash(epochBaselineManifestInput(a.manifest)),
      transitionSha256: epochTransitionDigest(a.transition, crypto),
    };
    const seed = await a.b.secrets.load(a.b.scope("signingSeed"));
    if (!seed) throw new Error("secret_unavailable");
    let text: string;
    try {
      text = canonicalStringify({
        ...unsigned,
        signature: crypto.sign(epochActivationSigningInput(unsigned), seed),
      });
    } finally {
      crypto.erase(seed);
    }
    const financial = await financialDigest(o.db, a.b),
      bindingId = crypto.uuid();
    await o.db.run(
      durable(
        (function* (): SqlWorkflow {
          yield* validateLiveArchive(o, a.journal);
          // Concurrent retries reserve one intention. The loser must read and use that same request.
          yield sql(
            `INSERT OR IGNORE INTO recovery_activation_saga(restore_id,activation_id,request_text,request_sha256,manifest_sha256,
        transition_sha256,to_epoch,binding_id,financial_sha256,phase) VALUES(?,?,?,?,?,?,?,?,?,'activation_requested')`,
            [
              o.restoreId,
              unsigned.activationId,
              text,
              crypto.hash(text),
              unsigned.manifestSha256,
              unsigned.transitionSha256,
              unsigned.toEpoch,
              bindingId,
              financial,
            ],
          );
          yield sql("UPDATE sync_control SET paused=1 WHERE id=1");
        })(),
      ),
    );
    await o.fault?.("request_persisted");
    row = await activationRow(o);
  }
  return resumeAnchorActivation(o);
}
export async function resumeAnchorActivation(o: AnchorActivationOptions) {
  let row = await activationRow(o);
  if (!row) throw new Error("activation_intention_missing");
  if (row.phase === "recovered") return;
  const installed = [
    "local_db_installed",
    "profile_installed",
    "finalizing",
  ].includes(String(row.phase));
  const a = await artifacts(o, !installed);
  if (!installed && (await financialDigest(o.db, a.b)) !== row.financial_sha256)
    throw new Error("financial_snapshot_changed");
  if (row.phase === "activation_requested") {
    const request: EpochActivationRequest = JSON.parse(
      String(row.request_text),
    );
    if (
      canonicalStringify(request) !== row.request_text ||
      a.b.crypto.hash(String(row.request_text)) !== row.request_sha256
    )
      throw new Error("activation_mismatch");
    let status = (await o.transport(
      "status",
      request,
    )) as EpochActivationStatus;
    if (status.state === "prepared")
      status = (await o.transport(
        "activate",
        request,
      )) as EpochActivationStatus;
    if (status.state !== "active") throw new Error("idempotency_mismatch");
    const record = verifyRemote(o, a, row, status.activation);
    await o.fault?.("remote_response");
    await o.db.run(
      durable(
        (function* (): SqlWorkflow {
          yield sql(
            "UPDATE recovery_activation_saga SET remote_record=?,phase='remote_active' WHERE restore_id=?",
            [canonicalStringify(record), o.restoreId],
          );
        })(),
      ),
    );
    await o.fault?.("remote_active");
    row = (await activationRow(o))!;
  }
  verifyRemote(o, a, row, JSON.parse(String(row.remote_record)));
  if (!installed) {
    const backup = await o.inspectBackup(String(a.journal.backup_path));
    if (
      backup.sha256 !== a.journal.backup_sha256 ||
      backup.integrity !== "ok" ||
      backup.foreignKeyViolations ||
      backup.bindingPinJson !== canonicalStringify(o.deviceA.profile.pin)
    )
      throw new Error("epoch_backup_invalid");
    await o.fault?.("before_checkpoint");
    if (!row.checkpoint_path) {
      const checkpoint = await o.checkpoint(),
        inspected = await o.inspectCheckpoint(checkpoint.path);
      if (
        checkpoint.sha256 !== inspected.sha256 ||
        inspected.requestSha256 !== row.request_sha256 ||
        inspected.phase !== "remote_active"
      )
        throw new Error("epoch_checkpoint_invalid");
      await o.db.run(
        durable(
          (function* (): SqlWorkflow {
            yield sql(
              "UPDATE recovery_activation_saga SET checkpoint_path=?,checkpoint_sha256=? WHERE restore_id=?",
              [checkpoint.path, checkpoint.sha256, o.restoreId],
            );
          })(),
        ),
      );
    } else {
      const inspected = await o.inspectCheckpoint(String(row.checkpoint_path));
      if (
        inspected.sha256 !== row.checkpoint_sha256 ||
        inspected.requestSha256 !== row.request_sha256 ||
        inspected.phase !== "remote_active"
      )
        throw new Error("epoch_checkpoint_invalid");
    }
    await phase(o, "installing_local");
    await o.fault?.("before_sqlite");
    const workflow = installGraph(o, a, row);
    await o.db.run(durable(workflow));
    await o.fault?.("after_sqlite");
    row = (await activationRow(o))!;
  }
  await verifyInstalled(o, a, row);
  await o.fault?.("before_profile");
  await o.saveProfile(a.b.profile);
  await o.fault?.("after_profile");
  if (
    canonicalStringify(await o.loadProfile()) !==
    canonicalStringify(a.b.profile)
  )
    throw new Error("profile_install_mismatch");
  await phase(o, "profile_installed");
  await o.fault?.("before_coordinator");
  await phase(o, "finalizing");
  await o.fault?.("before_first_pull");
  await o.firstPull(a.b);
  await o.fault?.("after_first_pull");
  // No preparation bundle cleanup here. It remains a private crash-recovery fallback and can be collected separately.
  await o.db.run(
    durable(
      (function* (): SqlWorkflow {
        yield sql(
          "UPDATE recovery_activation_saga SET phase='recovered' WHERE restore_id=?",
          [o.restoreId],
        );
        yield sql("UPDATE sync_control SET paused=0 WHERE id=1");
      })(),
    ),
  );
}
async function verifyInstalled(
  o: AnchorActivationOptions,
  a: Awaited<ReturnType<typeof artifacts>>,
  row: SqlRow,
) {
  const [state] = await o.db.read("SELECT * FROM sync_local_state WHERE id=1");
  const [binding] = await o.db.read(
    "SELECT * FROM sync_bindings WHERE binding_id=?",
    [String(row.binding_id)],
  );
  if (
    !binding ||
    state.mode !== "financial" ||
    state.server_id !== a.b.profile.pin.serverId ||
    state.server_epoch !== row.to_epoch ||
    state.device_id !== a.b.profile.deviceId ||
    state.binding_id !== row.binding_id ||
    state.vault_id !== a.b.profile.pin.vaultId ||
    BigInt(String(state.received_cursor)) < BigInt(a.manifest.commitCount) ||
    BigInt(String(state.applied_cursor)) < BigInt(a.manifest.commitCount) ||
    BigInt(String(state.device_seq)) < BigInt(a.manifest.commitCount) ||
    BigInt(String(state.local_seq)) < BigInt(a.manifest.operationCount) ||
    state.pull_upper_bound !== null ||
    binding.local_scope_id !== state.local_scope_id ||
    binding.server_id !== a.b.profile.pin.serverId ||
    binding.server_epoch !== row.to_epoch ||
    binding.vault_id !== a.b.profile.pin.vaultId ||
    binding.device_id !== a.b.profile.deviceId ||
    binding.endpoint !== o.endpoint ||
    binding.pin_json !== canonicalStringify(a.b.profile.pin) ||
    binding.registry_json !== canonicalStringify(a.b.profile.grants) ||
    binding.checkpoint_json !== canonicalStringify(a.b.profile.checkpoint)
  )
    throw new Error("local_install_mismatch");
  const [control] = await o.db.read("SELECT * FROM sync_control WHERE id=1");
  if (control.applying !== 0 || control.paused !== 1)
    throw new Error("local_install_mismatch");
  for (const [index, operation] of a.operations.entries()) {
    const [revision] = await o.db.read(
      "SELECT * FROM sync_revisions WHERE revision_id=?",
      [operation.opId],
    );
    const [origin] = await o.db.read(
      "SELECT * FROM sync_revision_origin WHERE revision_id=?",
      [operation.opId],
    );
    const [inbox] = await o.db.read(
      "SELECT * FROM sync_inbox WHERE commit_id=?",
      [operation.commitId],
    );
    if (
      !revision ||
      revision.object_id !== operation.objectId ||
      revision.commit_id !== operation.commitId ||
      revision.payload_json !== canonicalStringify(operation.revision) ||
      revision.parents_json !== canonicalStringify(operation.parents) ||
      !origin ||
      origin.device_id !== a.b.profile.deviceId ||
      origin.device_seq !== a.envelopes[index].ordinal ||
      origin.log_position !== a.envelopes[index].ordinal ||
      !inbox ||
      inbox.log_position !== a.envelopes[index].ordinal ||
      inbox.envelope_json !== a.envelopes[index].text ||
      inbox.state !== "applied" ||
      inbox.accepted_registry_version !== "1"
    )
      throw new Error("local_install_mismatch");
  }
}
/** Reconstruct the normal graph in TEMP using the normal importer, then install only epoch sidecars.
 * Main financial rows and stable logical identities are never projection targets. */
function* installGraph(
  o: AnchorActivationOptions,
  a: Awaited<ReturnType<typeof artifacts>>,
  row: SqlRow,
): SqlWorkflow {
  const mainTables = [...syncTables, ...Object.keys(financialTableTypes)];
  const schemas = yield sql(
    `SELECT name,sql FROM main.sqlite_master WHERE type='table' AND name IN (${mainTables.map(() => "?").join(",")})`,
    mainTables,
  );
  if (schemas.length !== mainTables.length)
    throw new Error("replay_schema_unavailable");
  yield* validateLiveArchive(o, a.journal);
  const before: Record<string, string[]> = {};
  const stable = [
    "sync_identity",
    "sync_series",
    "sync_slots",
    "sync_import_provenance",
    "sync_aliases",
  ];
  for (const table of [...Object.keys(financialTableTypes), ...stable])
    before[table] = (yield sql(`SELECT * FROM main.${table}`))
      .map((r) => canonicalStringify(r))
      .sort();
  const financial = Object.fromEntries(
    Object.keys(financialTableTypes).map((t) => [t, before[t]]),
  );
  if (a.b.crypto.hash(canonicalStringify(financial)) !== row.financial_sha256)
    throw new Error("financial_snapshot_changed");
  for (const table of mainTables) {
    if (
      (yield sql("SELECT name FROM sqlite_temp_master WHERE name=?", [table]))
        .length
    )
      throw new Error("replay_temp_collision");
    yield sql(
      String(schemas.find((s) => s.name === table)!.sql).replace(
        /^CREATE TABLE/i,
        "CREATE TEMP TABLE",
      ),
    );
  }
  for (const table of [...stable, "sync_local_state", "sync_control"])
    yield sql(`INSERT INTO temp.${table} SELECT * FROM main.${table}`);
  yield sql(
    "UPDATE temp.sync_local_state SET local_seq='0',device_id=? WHERE id=1",
    [a.b.profile.deviceId],
  );
  for (const [index, operation] of a.operations.entries()) {
    const e = decodeCommit(encodeUtf8(a.envelopes[index].text));
    yield* applyCommit(
      e,
      a.envelopes[index].ordinal,
      "1",
      [operation],
      o.dialect,
      () => a.b.crypto.uuid(),
      "1970-01-01T00:00:00.000Z",
    );
  }
  const graph = [
    "sync_revisions",
    "sync_heads",
    "sync_tombstones",
    "sync_revision_origin",
    "sync_conflicts",
  ];
  // Reverse FK order. Old receipts, errors/quarantine and transport reviews remain only in A's immutable archive.
  for (const table of [
    "sync_conflicts",
    "sync_revision_origin",
    "sync_rejected",
    "sync_heads",
    "sync_tombstones",
    "sync_revisions",
    "sync_inbox",
    "sync_outbox",
    "sync_bindings",
    "sync_review",
    "sync_bootstrap",
  ])
    yield sql(`DELETE FROM main.${table}`);
  for (const table of graph)
    yield sql(
      `INSERT INTO main.${table} SELECT ${syncColumns[table].join(",")} FROM temp.${table}`,
    );
  for (const e of a.envelopes) {
    const envelope = decodeCommit(encodeUtf8(e.text));
    yield sql(
      "INSERT INTO main.sync_inbox(commit_id,log_position,state,envelope_json,last_error,accepted_registry_version) VALUES(?,?,'applied',?,NULL,'1')",
      [envelope.commitId, e.ordinal, e.text],
    );
  }
  const scope = (yield sql(
    "SELECT local_scope_id FROM main.sync_local_state WHERE id=1",
  ))[0].local_scope_id;
  yield sql("INSERT INTO main.sync_bindings VALUES(?,?,?,?,?,?,?,?,?,?)", [
    row.binding_id,
    scope,
    o.endpoint,
    a.b.profile.pin.serverId,
    a.b.profile.pin.serverEpoch,
    a.b.profile.pin.vaultId,
    a.b.profile.deviceId,
    canonicalStringify(a.b.profile.pin),
    canonicalStringify(a.b.profile.grants),
    canonicalStringify(a.b.profile.checkpoint),
  ]);
  yield sql(
    `UPDATE main.sync_local_state SET server_id=?,server_epoch=?,vault_id=?,device_id=?,binding_id=?,local_seq=?,device_seq=?,
    received_cursor=?,applied_cursor=?,pull_upper_bound=NULL WHERE id=1`,
    [
      a.b.profile.pin.serverId,
      a.b.profile.pin.serverEpoch,
      a.b.profile.pin.vaultId,
      a.b.profile.deviceId,
      row.binding_id,
      a.manifest.operationCount,
      a.manifest.commitCount,
      a.manifest.commitCount,
      a.manifest.commitCount,
    ],
  );
  yield sql("INSERT INTO main.sync_review VALUES(?,NULL,?,?)", [
    a.b.crypto.uuid(),
    "active_key_version",
    canonicalStringify({ keyVersion: a.b.profile.pin.keyVersion }),
  ]);
  yield sql("UPDATE main.sync_control SET paused=1,applying=0 WHERE id=1");
  yield sql(
    "UPDATE main.recovery_activation_saga SET phase='local_db_installed' WHERE restore_id=?",
    [o.restoreId],
  );
  for (const table of [...Object.keys(financialTableTypes), ...stable])
    if (
      canonicalStringify(before[table]) !==
      canonicalStringify(
        (yield sql(`SELECT * FROM main.${table}`))
          .map((r) => canonicalStringify(r))
          .sort(),
      )
    )
      throw new Error("financial_install_changed");
  for (const table of [...mainTables].reverse())
    yield sql(`DROP TABLE temp.${table}`);
}
