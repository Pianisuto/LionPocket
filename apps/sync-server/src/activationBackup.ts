import type { PoolClient } from "pg";
import {
  activeDevice,
  assertEpochActivationRecord,
  canonicalStringify,
  commitSigningInput,
  decodeCommit,
  encodeUtf8,
  epochBaselineManifestInput,
  epochTransitionDigest,
  validateGrantChain,
  verifyEpochActivationRequest,
  type EpochActivationRequest,
  type CommitReceipt,
  type StagingBegin,
} from "@lionpocket/sync-protocol";
import {
  validateKeyCheckpoints,
  verifySignedRecovery,
  type ProvisioningCrypto,
} from "@lionpocket/sync-local";

/** Called in the same READ ONLY backup audit as verifyStagingBackup. Verify the activation boundary,
 * then replay the complete public log, including subsequent ordinary pushes. No DEK is used. */
export async function verifyActivationBackup(
  tx: PoolClient,
  crypto: ProvisioningCrypto,
) {
  if (
    (
      await tx.query(`SELECT 1 FROM sync_vaults v WHERE
    (SELECT count(*) FROM sync_generations g WHERE g.vault_id=v.vault_id AND g.state='active')<>1 OR
    NOT EXISTS(SELECT 1 FROM sync_generations g WHERE g.vault_id=v.vault_id AND g.server_epoch=(v.pin->>'serverEpoch')::uuid AND g.state='active') LIMIT 1`)
    ).rowCount
  )
    throw new Error("invalid_activation_backup");
  // Pending restores deliberately select their sealed old generation until activation.
  // Every other vault must select the environment's epoch.
  if (
    (
      await tx.query(`SELECT 1 FROM sync_vaults v CROSS JOIN sync_environment e
    WHERE v.pin->>'serverId'<>e.server_id::text OR
    ((v.pin->>'serverEpoch')::uuid<>e.server_epoch AND NOT EXISTS (
      SELECT 1 FROM sync_restore_vaults rv JOIN sync_restores r USING(restore_id)
      WHERE rv.vault_id=v.vault_id AND rv.source_epoch=(v.pin->>'serverEpoch')::uuid
      AND r.server_id=e.server_id AND r.to_epoch=e.server_epoch AND rv.state<>'recovered')) LIMIT 1`)
    ).rowCount
  )
    throw new Error("invalid_activation_backup");
  const activations = (
    await tx.query(
      "SELECT * FROM sync_epoch_activations ORDER BY vault_id,to_epoch",
    )
  ).rows;
  for (const a of activations) {
    const staging = (
      await tx.query(
        "SELECT * FROM sync_epoch_staging WHERE restore_id=$1 AND vault_id=$2",
        [a.restore_id, a.vault_id],
      )
    ).rows[0];
    const t = (
      await tx.query(
        "SELECT * FROM sync_epoch_transitions WHERE restore_id=$1 AND vault_id=$2",
        [a.restore_id, a.vault_id],
      )
    ).rows[0];
    const from = (
      await tx.query(
        "SELECT * FROM sync_generations WHERE vault_id=$1 AND server_epoch=$2",
        [a.vault_id, a.from_epoch],
      )
    ).rows[0];
    const selected = (
      await tx.query("SELECT * FROM sync_vaults WHERE vault_id=$1", [
        a.vault_id,
      ])
    ).rows[0];
    const active = selected.pin.serverEpoch === a.to_epoch;
    const target = active
      ? selected
      : (
          await tx.query(
            "SELECT * FROM archive_sync_vaults WHERE vault_id=$1 AND generation_epoch=$2",
            [a.vault_id, a.to_epoch],
          )
        ).rows[0];
    if (
      !staging ||
      !t ||
      !target ||
      !from?.archive_sealed ||
      from.state !== "archived" ||
      staging.state !== "prepared"
    )
      throw new Error("invalid_activation_backup");
    const begin: StagingBegin = JSON.parse(staging.begin_text),
      m = JSON.parse(staging.manifest_text),
      request: EpochActivationRequest = JSON.parse(a.request_text);
    assertEpochActivationRecord(a.record);
    verifyEpochActivationRequest(
      request,
      begin.registry[0].signingPublicKey,
      crypto,
    );
    const { signature, ...unsigned } = request;
    void signature;
    const expected = {
      ...unsigned,
      requestSha256: crypto.hash(a.request_text),
      trustPinSha256: crypto.hash(canonicalStringify(begin.pin)),
      logPosition: m.commitCount,
      commitCount: m.commitCount,
      operationCount: m.operationCount,
    };
    if (
      canonicalStringify(request) !== a.request_text ||
      a.request_sha256 !== expected.requestSha256 ||
      a.activation_id !== request.activationId ||
      a.restore_id !== request.restoreId ||
      a.vault_id !== request.vaultId ||
      a.from_epoch !== request.fromEpoch ||
      a.to_epoch !== request.toEpoch ||
      a.anchor_device_id !== request.anchorDeviceId ||
      a.log_position !== m.commitCount ||
      canonicalStringify(expected) !== canonicalStringify(a.record) ||
      crypto.hash(epochBaselineManifestInput(m)) !== a.manifest_sha256 ||
      epochTransitionDigest(JSON.parse(t.transition_text), crypto) !==
        a.transition_sha256 ||
      request.manifestSha256 !== a.manifest_sha256 ||
      request.transitionSha256 !== a.transition_sha256 ||
      canonicalStringify(target.pin) !== canonicalStringify(begin.pin) ||
      target.base_key_version !== String(begin.pin.keyVersion) ||
      BigInt(target.log_position) < BigInt(m.commitCount)
    )
      throw new Error("invalid_activation_backup");
    const args = active ? [a.vault_id] : [a.vault_id, a.to_epoch];
    const suffix = active ? "" : " AND generation_epoch=$2";
    const prefix = active ? "" : "archive_";
    const grants = (
      await tx.query(
        `SELECT grant_envelope FROM ${prefix}sync_grants WHERE vault_id=$1${suffix} ORDER BY registry_version`,
        args,
      )
    ).rows.map((r) => r.grant_envelope);
    const registry = validateGrantChain(grants, target.pin, crypto);
    if (
      target.registry_version !== registry.checkpoint.version ||
      canonicalStringify(grants[0]) !== canonicalStringify(begin.registry[0]) ||
      validateKeyCheckpoints(target.key_checkpoints, target.pin, grants, {
        crypto,
      }) !== Number(target.active_key_version)
    )
      throw new Error("invalid_activation_backup");
    verifySignedRecovery(target.recovery, target.pin, crypto);
    if (
      BigInt(target.recovery.envelope.recoveryVersion) <
        BigInt(begin.recovery.envelope.recoveryVersion) ||
      (target.recovery.envelope.recoveryVersion ===
        begin.recovery.envelope.recoveryVersion &&
        canonicalStringify(target.recovery) !==
          canonicalStringify(begin.recovery))
    )
      throw new Error("invalid_activation_backup");
    const heads = new Map<string, string[]>(),
      operations = new Map<
        string,
        { objectId: string; commitId: string; parents: string[] }
      >();
    let cursor = "0";
    for (;;) {
      const rows = (
        await tx.query(
          `SELECT * FROM ${prefix}sync_commits WHERE vault_id=$1${suffix} AND log_position>$${args.length + 1} ORDER BY log_position LIMIT 100`,
          [...args, cursor],
        )
      ).rows;
      if (!rows.length) break;
      for (const c of rows) {
        const e = decodeCommit(encodeUtf8(c.envelope_text));
        const accepted = validateGrantChain(
          grants.filter(
            (g) =>
              BigInt(g.registryVersion) <= BigInt(c.accepted_registry_version),
          ),
          target.pin,
          crypto,
        );
        const authored = validateGrantChain(
          grants.filter(
            (g) => BigInt(g.registryVersion) <= BigInt(e.deviceRegistryVersion),
          ),
          target.pin,
          crypto,
        );
        const { signature, ...unsignedCommit } = e;
        if (
          BigInt(c.log_position) !== BigInt(cursor) + 1n ||
          e.commitId !== c.commit_id ||
          e.deviceId !== c.device_id ||
          e.deviceSeq !== c.device_seq ||
          e.serverId !== target.pin.serverId ||
          e.serverEpoch !== a.to_epoch ||
          e.vaultId !== a.vault_id ||
          c.digest !== crypto.hash(c.envelope_text) ||
          !crypto.verify(
            signature,
            commitSigningInput(unsignedCommit),
            activeDevice(authored.devices, e.deviceId).signingPublicKey,
          )
        )
          throw new Error("invalid_activation_backup");
        activeDevice(accepted.devices, e.deviceId);
        const touched = new Set<string>();
        for (const op of e.operations) {
          if (
            operations.has(op.opId) ||
            op.parents.some((p) => operations.get(p)?.objectId !== op.objectId)
          )
            throw new Error("invalid_activation_backup");
          const prior = heads.get(op.objectId) ?? [];
          if (
            op.expectedHeads &&
            canonicalStringify(op.expectedHeads) !== canonicalStringify(prior)
          )
            throw new Error("invalid_activation_backup");
          heads.set(
            op.objectId,
            [...prior.filter((id) => !op.parents.includes(id)), op.opId].sort(),
          );
          operations.set(op.opId, {
            objectId: op.objectId,
            commitId: e.commitId,
            parents: op.parents,
          });
          touched.add(op.objectId);
        }
        const receipt: CommitReceipt = {
          serverId: e.serverId,
          serverEpoch: e.serverEpoch,
          vaultId: e.vaultId,
          commitId: e.commitId,
          deviceId: e.deviceId,
          deviceSeq: e.deviceSeq,
          result: "accepted",
          logPosition: c.log_position,
          envelopeSha256: c.digest,
          acceptedRegistryVersion: c.accepted_registry_version,
          heads: [...touched].sort().map((objectId) => ({
            objectId,
            revisionIds: heads.get(objectId)!,
          })),
        };
        if (canonicalStringify(receipt) !== canonicalStringify(c.receipt))
          throw new Error("invalid_activation_backup");
        if (BigInt(c.log_position) <= BigInt(m.commitCount)) {
          const staged = (
            await tx.query(
              "SELECT * FROM sync_epoch_staging_commits WHERE restore_id=$1 AND vault_id=$2 AND ordinal=$3",
              [a.restore_id, a.vault_id, c.log_position],
            )
          ).rows[0];
          if (
            !staged ||
            staged.envelope_text !== c.envelope_text ||
            staged.digest !== c.digest ||
            c.accepted_registry_version !== "1"
          )
            throw new Error("invalid_activation_backup");
        }
        cursor = c.log_position;
        if (cursor === m.commitCount) {
          const stagedHeads = (
            await tx.query(
              "SELECT object_id::text,op_id::text FROM sync_epoch_staging_heads WHERE restore_id=$1 AND vault_id=$2 ORDER BY object_id,op_id",
              [a.restore_id, a.vault_id],
            )
          ).rows;
          const actual = [...heads]
            .sort(([a], [b]) => (a < b ? -1 : 1))
            .flatMap(([object_id, ids]) =>
              ids.map((op_id) => ({ object_id, op_id })),
            );
          if (canonicalStringify(actual) !== canonicalStringify(stagedHeads))
            throw new Error("invalid_activation_backup");
        }
      }
    }
    if (cursor !== target.log_position)
      throw new Error("invalid_activation_backup");
    const remoteHeads = (
      await tx.query(
        `SELECT object_id::text,op_id::text FROM ${prefix}sync_remote_heads WHERE vault_id=$1${suffix} ORDER BY object_id,op_id`,
        args,
      )
    ).rows;
    const actualHeads = [...heads]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .flatMap(([object_id, ids]) =>
        ids.map((op_id) => ({ object_id, op_id })),
      );
    if (canonicalStringify(remoteHeads) !== canonicalStringify(actualHeads))
      throw new Error("invalid_activation_backup");
    const remoteOps = (
      await tx.query(
        `SELECT op_id::text,object_id::text,commit_id::text,parents FROM ${prefix}sync_operations WHERE vault_id=$1${suffix} ORDER BY op_id`,
        args,
      )
    ).rows;
    const actualOps = [...operations]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([op_id, o]) => ({
        op_id,
        object_id: o.objectId,
        commit_id: o.commitId,
        parents: o.parents,
      }));
    if (canonicalStringify(remoteOps) !== canonicalStringify(actualOps))
      throw new Error("invalid_activation_backup");
  }
}
