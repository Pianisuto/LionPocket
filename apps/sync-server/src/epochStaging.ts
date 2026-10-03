import {
  assertBase64Url,
  assertDecimal64,
  assertEpochBaselineManifest,
  assertTrustPin,
  canonicalStringify,
  commitSigningInput,
  decodeCommit,
  encodeUtf8,
  epochTransitionDigest,
  exactObject,
  sameScope,
  stagingLimits,
  validateGrantChain,
  verifyEpochKeyBase,
  verifyEpochRecoveryAuthorization,
  verifyEpochStagingRequest,
  verifyEpochTransition,
  accumulateStagingEnvelope,
  accumulateStagingHead,
  initialEnvelopesSha256,
  initialStagingHeadsSha256,
  type EpochBaselineManifest,
  type EpochStagingRequest,
  type EpochTransition,
  type StagingBegin,
  type TrustPin,
  type DeviceGrant,
} from "@lionpocket/sync-protocol";
import {
  validateKeyCheckpoints,
  verifySignedRecovery,
  type KeyCheckpoint,
  type ProvisioningCrypto,
} from "@lionpocket/sync-local";
import type { PoolClient } from "pg";
import type { Identity } from "./identity";

const hash = (v: unknown, crypto: ProvisioningCrypto) =>
  crypto.hash(canonicalStringify(v));
/** Server verifies public artifacts and known signed A history. It has no DEK or semantic mapping oracle. */
export function validateStagingBegin(
  value: unknown,
  pin: TrustPin,
  restoredKeys: KeyCheckpoint[],
  knownGrants: DeviceGrant[],
  restoredRecovery: StagingBegin["previousRecovery"] | null,
  crypto: ProvisioningCrypto,
): StagingBegin {
  const b = exactObject(value, [
    "recoveryConfirmed",
    "authorization",
    "pin",
    "registry",
    "keyBase",
    "knownKeyCheckpoints",
    "previousRecovery",
    "recovery",
    "archiveSha256",
    "mappingSha256",
    "operationCount",
    "headsSha256",
  ]) as unknown as StagingBegin;
  if (b.recoveryConfirmed !== true)
    throw new Error("recovery_confirmation_required");
  assertTrustPin(b.pin);
  const a = b.authorization;
  const { signature, intent, knownRegistry, ...challenge } = a;
  void signature;
  void intent;
  verifyEpochRecoveryAuthorization(
    a,
    { pin, challenge, knownRegistry },
    crypto,
  );
  if (
    b.pin.serverId !== pin.serverId ||
    b.pin.vaultId !== pin.vaultId ||
    b.pin.serverEpoch !== a.toEpoch ||
    b.pin.authorityPublicKey !== pin.authorityPublicKey ||
    b.pin.founderDeviceId === pin.founderDeviceId ||
    knownGrants.some((g) => g.deviceId === b.pin.founderDeviceId)
  )
    throw new Error("scope_mismatch");
  if (!Array.isArray(b.registry) || b.registry.length !== 1)
    throw new Error("invalid_registry");
  const registry = validateGrantChain(b.registry, b.pin, crypto);
  const anchor = registry.devices.get(b.pin.founderDeviceId)!;
  if (
    knownGrants.some(
      (g) =>
        g.signingPublicKey === anchor.signingPublicKey ||
        g.boxPublicKey === anchor.boxPublicKey,
    )
  )
    throw new Error("duplicate_device_key");
  if (
    !Array.isArray(b.knownKeyCheckpoints) ||
    b.knownKeyCheckpoints.length > 1000 ||
    restoredKeys.some(
      (k, i) =>
        canonicalStringify(k) !== canonicalStringify(b.knownKeyCheckpoints[i]),
    )
  )
    throw new Error("key_checkpoint_rollback");
  const active = validateKeyCheckpoints(
    b.knownKeyCheckpoints as KeyCheckpoint[],
    pin,
    knownGrants,
    { crypto },
  );
  verifyEpochKeyBase(b.keyBase, b.pin, crypto);
  if (
    b.keyBase.restoreId !== a.restoreId ||
    b.keyBase.fromEpoch !== pin.serverEpoch ||
    b.keyBase.previousActiveKeyVersion !== active ||
    b.keyBase.previousKeyCheckpointsSha256 !==
      hash(b.knownKeyCheckpoints, crypto)
  )
    throw new Error("key_version_mismatch");
  let previousVersion = "0";
  if (b.previousRecovery) {
    verifySignedRecovery(b.previousRecovery, pin, crypto);
    previousVersion = b.previousRecovery.envelope.recoveryVersion;
  }
  if (
    restoredRecovery &&
    (!b.previousRecovery ||
      BigInt(previousVersion) <
        BigInt(restoredRecovery.envelope.recoveryVersion) ||
      (previousVersion === restoredRecovery.envelope.recoveryVersion &&
        canonicalStringify(b.previousRecovery) !==
          canonicalStringify(restoredRecovery)))
  )
    throw new Error("recovery_version_mismatch");
  verifySignedRecovery(b.recovery, b.pin, crypto);
  if (
    BigInt(b.recovery.envelope.recoveryVersion) !==
    BigInt(previousVersion) + 1n
  )
    throw new Error("recovery_version_mismatch");
  for (const k of ["archiveSha256", "mappingSha256", "headsSha256"] as const)
    assertBase64Url(b[k], 32);
  assertDecimal64(b.operationCount);
  return b;
}
export async function epochStaging(
  tx: PoolClient,
  action: string,
  value: unknown,
  vaultId: string,
  account: Identity,
  environment: { serverId: string; serverEpoch: string },
  crypto: ProvisioningCrypto,
) {
  const request = exactObject(value, [
    "formatVersion",
    "vaultId",
    "restoreId",
    "action",
    "payload",
    "signature",
  ]) as unknown as EpochStagingRequest;
  if (request.vaultId !== vaultId || request.action !== action)
    throw new Error("scope_mismatch");
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
  const pin = vault.pin as TrustPin;
  const permission = (
    await tx.query(
      `SELECT a.*,r.server_id,r.from_epoch,r.to_epoch,v.source_epoch FROM sync_epoch_authorizations a
    JOIN sync_restores r USING(restore_id) JOIN sync_restore_vaults v USING(restore_id,vault_id)
    WHERE a.restore_id=$1 AND a.vault_id=$2`,
      [request.restoreId, vaultId],
    )
  ).rows[0];
  if (
    !permission ||
    permission.server_id !== environment.serverId ||
    permission.from_epoch !== pin.serverEpoch ||
    permission.source_epoch !== pin.serverEpoch ||
    pin.serverEpoch === environment.serverEpoch
  )
    throw new Error("restore_record_required");
  // The authorization's owner binding is in its consumed challenge, rather than inferred from login alone.
  const issuer = (
    await tx.query(
      "SELECT owner_issuer,owner_subject FROM sync_epoch_challenges WHERE challenge_id=$1",
      [permission.challenge_id],
    )
  ).rows[0];
  if (
    !issuer ||
    issuer.owner_issuer !== account.issuer ||
    issuer.owner_subject !== account.subject
  )
    throw new Error("forbidden");
  let attempt = (
    await tx.query(
      "SELECT * FROM sync_epoch_staging WHERE restore_id=$1 AND vault_id=$2 FOR UPDATE",
      [request.restoreId, vaultId],
    )
  ).rows[0];
  if (permission.to_epoch !== environment.serverEpoch) {
    // A physical restore preserves a previously accepted immutable attempt. Finish its bytes under the
    // original authorization, never retarget its epoch or create a new B identity from the old permission.
    const resumed = (
      await tx.query(
        `SELECT 1 FROM sync_restores r JOIN sync_restore_vaults v USING(restore_id)
      WHERE r.server_id=$1 AND r.from_epoch=$2 AND r.to_epoch=$3 AND v.vault_id=$4 AND v.source_epoch=$5`,
        [
          environment.serverId,
          permission.to_epoch,
          environment.serverEpoch,
          vaultId,
          pin.serverEpoch,
        ],
      )
    ).rowCount;
    if (!attempt || !resumed) throw new Error("restore_record_required");
  }
  if (action === "begin") {
    const begin = validateStagingBegin(
      request.payload,
      pin,
      vault.key_checkpoints,
      permission.known_grants,
      vault.recovery,
      crypto,
    );
    if (
      canonicalStringify(begin.authorization) !==
      canonicalStringify(permission.authorization_envelope)
    )
      throw new Error("scope_mismatch");
    verifyEpochStagingRequest(
      request,
      begin.registry[0].signingPublicKey,
      crypto,
    );
    const text = canonicalStringify(begin);
    if (attempt) {
      if (
        attempt.begin_text !== text ||
        attempt.begin_sha256 !== crypto.hash(text)
      )
        throw new Error("idempotency_mismatch");
    } else {
      await tx.query(
        `INSERT INTO sync_epoch_staging(restore_id,vault_id,from_epoch,to_epoch,owner_issuer,owner_subject,
        anchor_device_id,begin_text,begin_sha256,envelopes_sha256) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          request.restoreId,
          vaultId,
          pin.serverEpoch,
          environment.serverEpoch,
          account.issuer,
          account.subject,
          begin.pin.founderDeviceId,
          text,
          crypto.hash(text),
          initialEnvelopesSha256(
            {
              restoreId: request.restoreId,
              vaultId,
              fromEpoch: pin.serverEpoch,
              toEpoch: environment.serverEpoch,
            },
            crypto,
          ),
        ],
      );
    }
    attempt = (
      await tx.query(
        "SELECT * FROM sync_epoch_staging WHERE restore_id=$1 AND vault_id=$2",
        [request.restoreId, vaultId],
      )
    ).rows[0];
  } else {
    if (!attempt) throw new Error("staging_missing");
    const begin = JSON.parse(attempt.begin_text) as StagingBegin;
    verifyEpochStagingRequest(
      request,
      begin.registry[0].signingPublicKey,
      crypto,
    );
    if (action === "batch") {
      const batch = exactObject(request.payload, [
        "batchOrdinal",
        "firstOrdinal",
        "lastOrdinal",
        "envelopes",
      ]);
      for (const k of ["batchOrdinal", "firstOrdinal", "lastOrdinal"])
        assertDecimal64(batch[k], true);
      if (
        !Array.isArray(batch.envelopes) ||
        !batch.envelopes.length ||
        batch.envelopes.length > stagingLimits.commitsPerBatch ||
        BigInt(String(batch.lastOrdinal)) -
          BigInt(String(batch.firstOrdinal)) +
          1n !==
          BigInt(batch.envelopes.length) ||
        BigInt(String(batch.batchOrdinal)) > BigInt(stagingLimits.maxBatches)
      )
        throw new Error("invalid_staging_batch");
      const text = canonicalStringify(batch);
      if (encodeUtf8(text).length > stagingLimits.requestBytes)
        throw new Error("payload_too_large");
      const prior = (
        await tx.query(
          "SELECT batch_text,digest FROM sync_epoch_staging_batches WHERE restore_id=$1 AND vault_id=$2 AND batch_ordinal=$3",
          [request.restoreId, vaultId, batch.batchOrdinal],
        )
      ).rows[0];
      if (prior) {
        if (prior.batch_text !== text || prior.digest !== crypto.hash(text))
          throw new Error("idempotency_mismatch");
      } else {
        if (attempt.state !== "uploading") throw new Error("staging_closed");
        if (
          BigInt(String(batch.batchOrdinal)) !==
            BigInt(attempt.batch_count) + 1n ||
          BigInt(String(batch.firstOrdinal)) !==
            BigInt(attempt.commit_count) + 1n
        )
          throw new Error("staging_order");
        await tx.query(
          `INSERT INTO sync_epoch_staging_batches VALUES($1,$2,$3,$4,$5,$6,$7)`,
          [
            request.restoreId,
            vaultId,
            batch.batchOrdinal,
            batch.firstOrdinal,
            batch.lastOrdinal,
            text,
            crypto.hash(text),
          ],
        );
        let count = BigInt(attempt.commit_count),
          operations = BigInt(attempt.operation_count),
          digest = String(attempt.envelopes_sha256),
          batchOperations = 0;
        for (const envelopeText of batch.envelopes) {
          if (typeof envelopeText !== "string")
            throw new Error("invalid_envelope");
          const envelope = decodeCommit(encodeUtf8(envelopeText));
          sameScope(envelope, begin.pin);
          count++;
          if (
            canonicalStringify(envelope) !== envelopeText ||
            envelope.deviceId !== begin.pin.founderDeviceId ||
            envelope.deviceSeq !== count.toString() ||
            envelope.keyVersion !== begin.pin.keyVersion ||
            envelope.deviceRegistryVersion !== "1"
          )
            throw new Error("staging_envelope_mismatch");
          batchOperations += envelope.operations.length;
          if (batchOperations > stagingLimits.operationsPerBatch)
            throw new Error("payload_too_large");
          const { signature, ...unsigned } = envelope;
          if (
            !crypto.verify(
              signature,
              commitSigningInput(unsigned),
              begin.registry[0].signingPublicKey,
            )
          )
            throw new Error("invalid_signature");
          if (
            (
              await tx.query(
                "SELECT 1 FROM sync_epoch_staging_commits WHERE restore_id=$1 AND vault_id=$2 AND commit_id=$3",
                [request.restoreId, vaultId, envelope.commitId],
              )
            ).rowCount
          )
            throw new Error("idempotency_mismatch");
          await tx.query(
            "INSERT INTO sync_epoch_staging_commits VALUES($1,$2,$3,$4,$5,$6,$7)",
            [
              request.restoreId,
              vaultId,
              count.toString(),
              batch.batchOrdinal,
              envelope.commitId,
              envelopeText,
              crypto.hash(envelopeText),
            ],
          );
          for (const op of envelope.operations) {
            if (
              (
                await tx.query(
                  "SELECT 1 FROM sync_epoch_staging_operations WHERE restore_id=$1 AND vault_id=$2 AND op_id=$3",
                  [request.restoreId, vaultId, op.opId],
                )
              ).rowCount
            )
              throw new Error("idempotency_mismatch");
            if (op.expectedHeads !== undefined)
              throw new Error("staging_envelope_mismatch"); // causal replay, never rewrite heads conditionally
            const parents = (
              await tx.query(
                "SELECT op_id::text,object_id::text FROM sync_epoch_staging_operations WHERE restore_id=$1 AND vault_id=$2 AND op_id=ANY($3::uuid[])",
                [request.restoreId, vaultId, op.parents],
              )
            ).rows;
            if (
              parents.length !== op.parents.length ||
              parents.some((p) => p.object_id !== op.objectId)
            )
              throw new Error("missing_parents");
            await tx.query(
              "INSERT INTO sync_epoch_staging_operations VALUES($1,$2,$3,$4,$5,$6)",
              [
                request.restoreId,
                vaultId,
                op.opId,
                op.objectId,
                envelope.commitId,
                op.parents,
              ],
            );
            await tx.query(
              "DELETE FROM sync_epoch_staging_heads WHERE restore_id=$1 AND vault_id=$2 AND op_id=ANY($3::uuid[])",
              [request.restoreId, vaultId, op.parents],
            );
            await tx.query(
              "INSERT INTO sync_epoch_staging_heads VALUES($1,$2,$3,$4)",
              [request.restoreId, vaultId, op.objectId, op.opId],
            );
            operations++;
          }
          digest = accumulateStagingEnvelope(
            digest,
            count.toString(),
            String(batch.batchOrdinal),
            envelope.commitId,
            envelopeText,
            crypto,
          );
        }
        if (operations > BigInt(begin.operationCount))
          throw new Error("staging_count_mismatch");
        await tx.query(
          `UPDATE sync_epoch_staging SET commit_count=$3,operation_count=$4,batch_count=$5,envelopes_sha256=$6 WHERE restore_id=$1 AND vault_id=$2`,
          [
            request.restoreId,
            vaultId,
            count.toString(),
            operations.toString(),
            batch.batchOrdinal,
            digest,
          ],
        );
      }
    } else if (action === "validate") {
      const manifest = request.payload as EpochBaselineManifest;
      assertEpochBaselineManifest(manifest);
      const text = canonicalStringify(manifest);
      if (attempt.manifest_text) {
        if (attempt.manifest_text !== text)
          throw new Error("idempotency_mismatch");
      } else {
        const observed = await stagingManifest(tx, attempt, begin, crypto);
        if (text !== canonicalStringify(observed))
          throw new Error("staging_manifest_mismatch");
        await tx.query(
          "UPDATE sync_epoch_staging SET state='validated',heads_sha256=$3,manifest_text=$4 WHERE restore_id=$1 AND vault_id=$2",
          [request.restoreId, vaultId, observed.headsSha256, text],
        );
      }
    } else if (action === "prepare") {
      const payload = exactObject(request.payload, ["manifest", "transition"]);
      if (
        !attempt.manifest_text ||
        attempt.manifest_text !== canonicalStringify(payload.manifest)
      )
        throw new Error("staging_not_validated");
      const transition = payload.transition as EpochTransition;
      const previous = (
        await tx.query(
          "SELECT transition_text FROM sync_epoch_transitions WHERE vault_id=$1 AND to_epoch=$2",
          [vaultId, pin.serverEpoch],
        )
      ).rows[0];
      verifyEpochTransition(
        transition,
        {
          fromPin: pin,
          toPin: begin.pin,
          authorization: begin.authorization,
          manifest: payload.manifest as EpochBaselineManifest,
          registry: begin.registry,
          keyCheckpoint: begin.keyBase,
          recovery: begin.recovery,
          previousTransition: previous
            ? JSON.parse(previous.transition_text)
            : null,
        },
        crypto,
      );
      const prior = (
        await tx.query(
          "SELECT transition_text,manifest_text FROM sync_epoch_transitions WHERE restore_id=$1 AND vault_id=$2",
          [request.restoreId, vaultId],
        )
      ).rows[0];
      const text = canonicalStringify(transition);
      if (prior) {
        if (
          prior.transition_text !== text ||
          prior.manifest_text !== attempt.manifest_text
        )
          throw new Error("idempotency_mismatch");
      } else {
        await tx.query(
          "INSERT INTO sync_epoch_transitions VALUES($1,$2,$3,$4,$5,$6,$7,'prepared')",
          [
            request.restoreId,
            vaultId,
            pin.serverEpoch,
            begin.pin.serverEpoch,
            attempt.manifest_text,
            text,
            epochTransitionDigest(transition, crypto),
          ],
        );
        await tx.query(
          "UPDATE sync_epoch_staging SET state='prepared' WHERE restore_id=$1 AND vault_id=$2",
          [request.restoreId, vaultId],
        );
      }
    } else if (action !== "status") throw new Error("invalid_staging");
  }
  const row = (
    await tx.query(
      "SELECT state,commit_count::text,operation_count::text,batch_count::text FROM sync_epoch_staging WHERE restore_id=$1 AND vault_id=$2",
      [request.restoreId, vaultId],
    )
  ).rows[0];
  return {
    state: row.state,
    commitCount: row.commit_count,
    operationCount: row.operation_count,
    batchCount: row.batch_count,
    activationAvailable: true,
    readyForActivation:
      row.state === "prepared" &&
      permission.to_epoch === environment.serverEpoch,
  };
}
/** Final pass replays the exact committed bytes and public graph, independently of the upload counters. */
export async function stagingManifest(
  tx: PoolClient,
  attempt: Record<string, unknown>,
  begin: StagingBegin,
  crypto: ProvisioningCrypto,
  complete = true,
): Promise<EpochBaselineManifest> {
  const scope = {
    restoreId: String(attempt.restore_id),
    vaultId: String(attempt.vault_id),
    fromEpoch: String(attempt.from_epoch),
    toEpoch: String(attempt.to_epoch),
  };
  let digest = initialEnvelopesSha256(scope, crypto),
    count = 0n,
    cursor = "0";
  for (;;) {
    const rows = (
      await tx.query(
        `SELECT ordinal::text,batch_ordinal::text,commit_id::text,envelope_text,digest FROM sync_epoch_staging_commits
      WHERE restore_id=$1 AND vault_id=$2 AND ordinal>$3 ORDER BY sync_epoch_staging_commits.ordinal LIMIT 100`,
        [scope.restoreId, scope.vaultId, cursor],
      )
    ).rows;
    if (!rows.length) break;
    for (const r of rows) {
      count++;
      if (
        r.ordinal !== count.toString() ||
        r.digest !== crypto.hash(r.envelope_text)
      )
        throw new Error("invalid_staging");
      const envelope = decodeCommit(encodeUtf8(r.envelope_text));
      sameScope(envelope, begin.pin);
      const { signature, ...unsigned } = envelope;
      if (
        envelope.deviceSeq !== r.ordinal ||
        envelope.commitId !== r.commit_id ||
        envelope.deviceId !== begin.pin.founderDeviceId ||
        envelope.keyVersion !== begin.pin.keyVersion ||
        envelope.deviceRegistryVersion !== "1" ||
        !crypto.verify(
          signature,
          commitSigningInput(unsigned),
          begin.registry[0].signingPublicKey,
        )
      )
        throw new Error("invalid_staging");
      const ops = (
        await tx.query(
          "SELECT op_id::text,object_id::text,parents FROM sync_epoch_staging_operations WHERE restore_id=$1 AND vault_id=$2 AND commit_id=$3",
          [scope.restoreId, scope.vaultId, r.commit_id],
        )
      ).rows;
      if (
        ops.length !== envelope.operations.length ||
        envelope.operations.some(
          (o) =>
            o.expectedHeads !== undefined ||
            !ops.some(
              (p) =>
                p.op_id === o.opId &&
                p.object_id === o.objectId &&
                canonicalStringify(p.parents) === canonicalStringify(o.parents),
            ),
        )
      )
        throw new Error("invalid_staging");
      const ids = new Set<string>();
      for (const op of envelope.operations) {
        if (
          op.parents.some(
            (p) => envelope.operations.some((o) => o.opId === p) && !ids.has(p),
          )
        )
          throw new Error("missing_parents");
        ids.add(op.opId);
      }
      digest = accumulateStagingEnvelope(
        digest,
        r.ordinal,
        r.batch_ordinal,
        r.commit_id,
        r.envelope_text,
        crypto,
      );
      cursor = r.ordinal;
    }
  }
  const operationCount = (
    await tx.query(
      "SELECT count(*)::text AS n FROM sync_epoch_staging_operations WHERE restore_id=$1 AND vault_id=$2",
      [scope.restoreId, scope.vaultId],
    )
  ).rows[0].n;
  const batchCount = (
    await tx.query(
      "SELECT count(*)::text AS n FROM sync_epoch_staging_batches WHERE restore_id=$1 AND vault_id=$2",
      [scope.restoreId, scope.vaultId],
    )
  ).rows[0].n;
  if (
    count.toString() !== String(attempt.commit_count) ||
    operationCount !== String(attempt.operation_count) ||
    (complete && operationCount !== begin.operationCount) ||
    batchCount !== String(attempt.batch_count) ||
    digest !== attempt.envelopes_sha256
  )
    throw new Error("staging_count_mismatch");
  const invalidGraph = (
    await tx.query(
      `SELECT 1 FROM sync_epoch_staging_operations o CROSS JOIN LATERAL unnest(o.parents) p
    LEFT JOIN sync_epoch_staging_operations parent ON parent.restore_id=o.restore_id AND parent.vault_id=o.vault_id AND parent.op_id=p
    JOIN sync_epoch_staging_commits c ON c.restore_id=o.restore_id AND c.vault_id=o.vault_id AND c.commit_id=o.commit_id
    LEFT JOIN sync_epoch_staging_commits pc ON pc.restore_id=parent.restore_id AND pc.vault_id=parent.vault_id AND pc.commit_id=parent.commit_id
    WHERE o.restore_id=$1 AND o.vault_id=$2 AND (parent.op_id IS NULL OR parent.object_id<>o.object_id OR pc.ordinal>c.ordinal) LIMIT 1`,
      [scope.restoreId, scope.vaultId],
    )
  ).rowCount;
  if (invalidGraph) throw new Error("missing_parents");
  let batchCursor = 0n,
    last = 0n;
  for (;;) {
    const batches = (
      await tx.query(
        "SELECT * FROM sync_epoch_staging_batches WHERE restore_id=$1 AND vault_id=$2 AND batch_ordinal>$3 ORDER BY batch_ordinal LIMIT 100",
        [scope.restoreId, scope.vaultId, batchCursor.toString()],
      )
    ).rows;
    if (!batches.length) break;
    for (const stored of batches) {
      const batch = JSON.parse(stored.batch_text);
      batchCursor++;
      if (
        stored.digest !== crypto.hash(stored.batch_text) ||
        canonicalStringify(batch) !== stored.batch_text ||
        BigInt(stored.batch_ordinal) !== batchCursor ||
        BigInt(stored.first_ordinal) !== last + 1n ||
        batch.batchOrdinal !== String(stored.batch_ordinal) ||
        batch.firstOrdinal !== String(stored.first_ordinal) ||
        batch.lastOrdinal !== String(stored.last_ordinal) ||
        !Array.isArray(batch.envelopes) ||
        !batch.envelopes.length ||
        batch.envelopes.length > stagingLimits.commitsPerBatch ||
        BigInt(stored.last_ordinal) - BigInt(stored.first_ordinal) + 1n !==
          BigInt(batch.envelopes.length)
      )
        throw new Error("invalid_staging_batch");
      const commits = (
        await tx.query(
          "SELECT envelope_text FROM sync_epoch_staging_commits WHERE restore_id=$1 AND vault_id=$2 AND batch_ordinal=$3 ORDER BY ordinal",
          [scope.restoreId, scope.vaultId, stored.batch_ordinal],
        )
      ).rows.map((c) => c.envelope_text);
      if (canonicalStringify(commits) !== canonicalStringify(batch.envelopes))
        throw new Error("invalid_staging_batch");
      last = BigInt(stored.last_ordinal);
    }
  }
  if (last !== count || batchCursor.toString() !== batchCount)
    throw new Error("staging_count_mismatch");
  const headsIndexMismatch = (
    await tx.query(
      `SELECT 1 FROM (
    (SELECT object_id,op_id FROM sync_epoch_staging_heads WHERE restore_id=$1 AND vault_id=$2 EXCEPT
     SELECT o.object_id,o.op_id FROM sync_epoch_staging_operations o WHERE o.restore_id=$1 AND o.vault_id=$2
       AND NOT EXISTS(SELECT 1 FROM sync_epoch_staging_operations c WHERE c.restore_id=o.restore_id AND c.vault_id=o.vault_id AND c.parents @> ARRAY[o.op_id]))
    UNION ALL
    (SELECT o.object_id,o.op_id FROM sync_epoch_staging_operations o WHERE o.restore_id=$1 AND o.vault_id=$2
       AND NOT EXISTS(SELECT 1 FROM sync_epoch_staging_operations c WHERE c.restore_id=o.restore_id AND c.vault_id=o.vault_id AND c.parents @> ARRAY[o.op_id]) EXCEPT
     SELECT object_id,op_id FROM sync_epoch_staging_heads WHERE restore_id=$1 AND vault_id=$2)
    ) bad LIMIT 1`,
      [scope.restoreId, scope.vaultId],
    )
  ).rowCount;
  if (headsIndexMismatch) throw new Error("staging_heads_mismatch");
  let heads = initialStagingHeadsSha256(scope, crypto),
    object = "00000000-0000-0000-0000-000000000000",
    op = object;
  for (;;) {
    // Derive heads from operations, not from the client's list or the mutable head index.
    const rows = (
      await tx.query(
        `SELECT o.object_id::text,o.op_id::text FROM sync_epoch_staging_operations o
      WHERE o.restore_id=$1 AND o.vault_id=$2 AND (o.object_id,o.op_id)>($3::uuid,$4::uuid)
      AND NOT EXISTS(SELECT 1 FROM sync_epoch_staging_operations c WHERE c.restore_id=o.restore_id AND c.vault_id=o.vault_id AND c.parents @> ARRAY[o.op_id])
      ORDER BY o.object_id,o.op_id LIMIT 100`,
        [scope.restoreId, scope.vaultId, object, op],
      )
    ).rows;
    if (!rows.length) break;
    for (const r of rows) {
      object = r.object_id;
      op = r.op_id;
      heads = accumulateStagingHead(heads, object, op, crypto);
    }
  }
  if (complete && heads !== begin.headsSha256)
    throw new Error("staging_heads_mismatch");
  return {
    formatVersion: 1,
    serverId: begin.pin.serverId,
    vaultId: scope.vaultId,
    serverEpoch: scope.toEpoch,
    restoreId: scope.restoreId,
    anchorDeviceId: begin.pin.founderDeviceId,
    authorizationSha256: hash(begin.authorization, crypto),
    registrySha256: hash(begin.registry, crypto),
    keyCheckpointSha256: hash(begin.keyBase, crypto),
    recoverySha256: hash(begin.recovery, crypto),
    archiveSha256: begin.archiveSha256,
    mappingSha256: begin.mappingSha256,
    commitCount: count.toString(),
    operationCount,
    batchCount,
    envelopesSha256: digest,
    headsSha256: heads,
  };
}
