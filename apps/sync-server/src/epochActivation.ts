import type { PoolClient } from "pg";
import {
  assertEpochActivationRequest,
  canonicalStringify,
  encodeUtf8,
  epochBaselineManifestInput,
  epochTransitionDigest,
  verifyEpochActivationRequest,
  verifyEpochTransition,
  type EpochActivationRecord,
  type EpochActivationStatus,
  type StagingBegin,
} from "@lionpocket/sync-protocol";
import type { ProvisioningCrypto } from "@lionpocket/sync-local";
import type { Identity } from "./identity";
import { acceptCommit } from "./commits";
import { generationArchiveKeys } from "./generations";
import { stagingManifest, validateStagingBegin } from "./epochStaging";

export type ActivationFault = (step: string) => void | Promise<void>;
/** The caller owns BEGIN/COMMIT. All selection, public graph and ciphertext changes share that transaction.
 * Both routes use the identical signed durable intention, outside the normal HTTP proof. */
export async function epochActivation(
  tx: PoolClient,
  activate: boolean,
  value: unknown,
  vaultId: string,
  account: Identity,
  environment: { serverId: string; serverEpoch: string },
  crypto: ProvisioningCrypto,
  fault?: ActivationFault,
): Promise<EpochActivationStatus> {
  assertEpochActivationRequest(value);
  const request = value,
    args = [request.restoreId, vaultId];
  await fault?.("before_lock");
  const vault = (
    await tx.query("SELECT * FROM sync_vaults WHERE vault_id=$1 FOR UPDATE", [
      vaultId,
    ])
  ).rows[0];
  if (
    !vault ||
    vault.owner_issuer !== account.issuer ||
    vault.owner_subject !== account.subject
  )
    throw new Error("forbidden");
  const env = (
    await tx.query("SELECT * FROM sync_environment WHERE singleton FOR SHARE")
  ).rows[0];
  if (
    request.vaultId !== vaultId ||
    request.serverId !== environment.serverId ||
    request.toEpoch !== environment.serverEpoch ||
    env.server_id !== request.serverId ||
    env.server_epoch !== request.toEpoch
  )
    throw new Error("epoch_changed");
  const restore = (
    await tx.query(
      "SELECT * FROM sync_restores WHERE restore_id=$1 FOR UPDATE",
      [request.restoreId],
    )
  ).rows[0];
  const restored = (
    await tx.query(
      "SELECT * FROM sync_restore_vaults WHERE restore_id=$1 AND vault_id=$2 FOR UPDATE",
      args,
    )
  ).rows[0];
  const staging = (
    await tx.query(
      "SELECT * FROM sync_epoch_staging WHERE restore_id=$1 AND vault_id=$2 FOR UPDATE",
      args,
    )
  ).rows[0];
  const transition = (
    await tx.query(
      "SELECT * FROM sync_epoch_transitions WHERE restore_id=$1 AND vault_id=$2 FOR UPDATE",
      args,
    )
  ).rows[0];
  const generations = (
    await tx.query(
      "SELECT * FROM sync_generations WHERE vault_id=$1 ORDER BY server_epoch FOR UPDATE",
      [vaultId],
    )
  ).rows;
  await fault?.("after_lock");
  if (
    !restore ||
    !restored ||
    !staging ||
    !transition ||
    staging.state !== "prepared" ||
    transition.state !== "prepared"
  )
    throw new Error("staging_not_prepared");
  if (
    restore.server_id !== request.serverId ||
    restore.from_epoch !== request.fromEpoch ||
    restore.to_epoch !== request.toEpoch ||
    restored.source_epoch !== request.fromEpoch ||
    staging.from_epoch !== request.fromEpoch ||
    staging.to_epoch !== request.toEpoch ||
    transition.from_epoch !== request.fromEpoch ||
    transition.to_epoch !== request.toEpoch ||
    staging.owner_issuer !== account.issuer ||
    staging.owner_subject !== account.subject
  )
    throw new Error("activation_mismatch");
  const source = (
    await tx.query(
      "SELECT * FROM archive_sync_vaults WHERE vault_id=$1 AND generation_epoch=$2",
      [vaultId, request.fromEpoch],
    )
  ).rows[0];
  const permission = (
    await tx.query(
      "SELECT * FROM sync_epoch_authorizations WHERE restore_id=$1 AND vault_id=$2",
      args,
    )
  ).rows[0];
  const owner =
    permission &&
    (
      await tx.query(
        "SELECT * FROM sync_epoch_challenges WHERE challenge_id=$1",
        [permission.challenge_id],
      )
    ).rows[0];
  if (
    !source ||
    !permission ||
    !owner ||
    !owner.consumed ||
    owner.owner_issuer !== account.issuer ||
    owner.owner_subject !== account.subject ||
    !generations.some(
      (g) => g.server_epoch === request.fromEpoch && g.archive_sealed,
    )
  )
    throw new Error("activation_mismatch");
  const begin: StagingBegin = validateStagingBegin(
    JSON.parse(staging.begin_text),
    source.pin,
    source.key_checkpoints,
    permission.known_grants,
    source.recovery,
    crypto,
  );
  verifyEpochActivationRequest(
    request,
    begin.registry[0].signingPublicKey,
    crypto,
  );
  const text = canonicalStringify(request),
    digest = crypto.hash(text);
  const existing = (
    await tx.query(
      "SELECT * FROM sync_epoch_activations WHERE restore_id=$1 AND vault_id=$2",
      args,
    )
  ).rows[0];
  if (
    existing &&
    (existing.request_text !== text || existing.request_sha256 !== digest)
  ) {
    if (activate) throw new Error("idempotency_mismatch");
    return { state: "mismatch" };
  }
  if (
    staging.begin_sha256 !== crypto.hash(staging.begin_text) ||
    canonicalStringify(begin.authorization) !==
      canonicalStringify(permission.authorization_envelope) ||
    begin.pin.founderDeviceId !== request.anchorDeviceId ||
    staging.anchor_device_id !== request.anchorDeviceId ||
    transition.digest !== request.transitionSha256 ||
    epochTransitionDigest(JSON.parse(transition.transition_text), crypto) !==
      request.transitionSha256 ||
    transition.manifest_text !== staging.manifest_text
  )
    throw new Error("activation_mismatch");
  const manifest = await stagingManifest(tx, staging, begin, crypto);
  if (
    canonicalStringify(manifest) !== staging.manifest_text ||
    crypto.hash(epochBaselineManifestInput(manifest)) !== request.manifestSha256
  )
    throw new Error("activation_mismatch");
  const previous = (
    await tx.query(
      "SELECT transition_text FROM sync_epoch_transitions WHERE vault_id=$1 AND to_epoch=$2",
      [vaultId, request.fromEpoch],
    )
  ).rows[0];
  verifyEpochTransition(
    JSON.parse(transition.transition_text),
    {
      fromPin: source.pin,
      toPin: begin.pin,
      authorization: begin.authorization,
      manifest,
      registry: begin.registry,
      keyCheckpoint: begin.keyBase,
      recovery: begin.recovery,
      previousTransition: previous
        ? JSON.parse(previous.transition_text)
        : null,
    },
    crypto,
  );
  await fault?.("after_validate");
  if (existing) {
    if (
      vault.pin.serverEpoch !== request.toEpoch ||
      !generations.some(
        (g) => g.state === "active" && g.server_epoch === request.toEpoch,
      ) ||
      !generations.some(
        (g) => g.state === "archived" && g.server_epoch === request.fromEpoch,
      )
    )
      throw new Error("activation_mismatch");
    return {
      state: "active",
      activation: existing.record as EpochActivationRecord,
    };
  }
  if (
    vault.pin.serverEpoch !== request.fromEpoch ||
    generations.filter((g) => g.state === "active").length !== 1 ||
    !generations.some(
      (g) =>
        g.state === "active" &&
        g.server_epoch === request.fromEpoch &&
        g.archive_sealed,
    ) ||
    generations.some((g) => g.server_epoch === request.toEpoch)
  )
    throw new Error("activation_mismatch");
  // A is transport-blocked after restore. Still verify every active row against the sealed evidence before deleting anything.
  for (const table of Object.keys(generationArchiveKeys)) {
    const columns = (
      await tx.query(
        "SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position",
        [table],
      )
    ).rows
      .map((r) => String(r.column_name))
      .join(",");
    const a = `SELECT ${columns} FROM ${table} WHERE vault_id=$1`;
    const archive = `SELECT ${columns} FROM archive_${table} WHERE vault_id=$1 AND generation_epoch=$2`;
    if (
      (
        await tx.query(
          `SELECT 1 FROM ((${a} EXCEPT ${archive}) UNION ALL (${archive} EXCEPT ${a})) mismatch LIMIT 1`,
          [vaultId, request.fromEpoch],
        )
      ).rowCount
    )
      throw new Error("generation_archive_mismatch");
  }
  if (!activate) return { state: "prepared" };
  for (const [index, table] of [
    "sync_remote_heads",
    "sync_operations",
    "sync_commits",
    "sync_remote_bindings",
    "sync_deliveries",
    "sync_pairings",
    "sync_grants",
  ].entries()) {
    await tx.query(`DELETE FROM ${table} WHERE vault_id=$1`, [vaultId]);
    if (index === 0) await fault?.("after_first_delete");
  }
  for (const grant of begin.registry)
    await tx.query("INSERT INTO sync_grants VALUES($1,$2,$3)", [
      vaultId,
      grant.registryVersion,
      grant,
    ]);
  await tx.query(
    `UPDATE sync_vaults SET pin=$2,registry_version=1,base_key_version=$3,active_key_version=$3,
    key_checkpoints='[]',recovery=$4,rotation_required=false,log_position=0 WHERE vault_id=$1`,
    [vaultId, begin.pin, begin.pin.keyVersion, begin.recovery],
  );
  await fault?.("after_vault_update");
  await tx.query(
    "UPDATE sync_generations SET state='archived' WHERE vault_id=$1 AND server_epoch=$2",
    [vaultId, request.fromEpoch],
  );
  await tx.query(
    "INSERT INTO sync_generations(vault_id,server_epoch,state) VALUES($1,$2,'active')",
    [vaultId, request.toEpoch],
  );
  await fault?.("after_generation_swap");
  // Reuse precisely the normal acceptance/receipt semantics. No encryption, signing, nonce generation or envelope rewriting.
  let cursor = "0";
  for (;;) {
    const rows = (
      await tx.query(
        "SELECT ordinal::text,envelope_text,digest FROM sync_epoch_staging_commits WHERE restore_id=$1 AND vault_id=$2 AND ordinal>$3 ORDER BY sync_epoch_staging_commits.ordinal LIMIT 100",
        [...args, cursor],
      )
    ).rows;
    if (!rows.length) break;
    for (const row of rows) {
      const receipt = await acceptCommit(
        tx,
        encodeUtf8(row.envelope_text),
        begin.pin,
        begin.registry,
        request.anchorDeviceId,
        crypto,
      );
      if (
        receipt.logPosition !== row.ordinal ||
        receipt.envelopeSha256 !== row.digest
      )
        throw new Error("activation_mismatch");
      cursor = row.ordinal;
      await fault?.("promoting_commit");
    }
  }
  if (
    cursor !== manifest.commitCount ||
    (
      await tx.query(
        `SELECT 1 FROM (
    (SELECT object_id,op_id FROM sync_remote_heads WHERE vault_id=$2 EXCEPT SELECT object_id,op_id FROM sync_epoch_staging_heads WHERE restore_id=$1 AND vault_id=$2)
    UNION ALL (SELECT object_id,op_id FROM sync_epoch_staging_heads WHERE restore_id=$1 AND vault_id=$2 EXCEPT SELECT object_id,op_id FROM sync_remote_heads WHERE vault_id=$2)) mismatch LIMIT 1`,
        args,
      )
    ).rowCount
  )
    throw new Error("activation_mismatch");
  const { signature, ...unsigned } = request;
  void signature;
  const record: EpochActivationRecord = {
    ...unsigned,
    requestSha256: digest,
    trustPinSha256: crypto.hash(canonicalStringify(begin.pin)),
    logPosition: cursor,
    commitCount: manifest.commitCount,
    operationCount: manifest.operationCount,
  };
  await tx.query(
    `INSERT INTO sync_epoch_activations(activation_id,restore_id,vault_id,from_epoch,to_epoch,anchor_device_id,request_text,request_sha256,manifest_sha256,transition_sha256,record,log_position)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [
      request.activationId,
      request.restoreId,
      vaultId,
      request.fromEpoch,
      request.toEpoch,
      request.anchorDeviceId,
      text,
      digest,
      request.manifestSha256,
      request.transitionSha256,
      record,
      cursor,
    ],
  );
  await tx.query(
    "UPDATE sync_restore_vaults SET state='recovered' WHERE restore_id=$1 AND vault_id=$2",
    args,
  );
  return { state: "active", activation: record };
}
