import {
  canonicalStringify,
  epochTransitionDigest,
  verifyEpochTransition,
  type StagingBegin,
} from "@lionpocket/sync-protocol";
import type { ProvisioningCrypto } from "@lionpocket/sync-local";
import type { PoolClient } from "pg";
import { stagingManifest, validateStagingBegin } from "./epochStaging";
/** Caller starts a READ ONLY transaction. Works on incomplete and prepared snapshots without DEKs. */
export async function verifyStagingBackup(
  tx: PoolClient,
  crypto: ProvisioningCrypto,
) {
  const tables = [
    "sync_epoch_staging",
    "sync_epoch_staging_batches",
    "sync_epoch_staging_commits",
    "sync_epoch_staging_operations",
    "sync_epoch_staging_heads",
    "sync_epoch_transitions",
  ];
  const triggers = (
    await tx.query(
      `SELECT count(*)::text AS n FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
  WHERE NOT t.tgisinternal AND ((c.relname=$1 AND t.tgname='immutable_staging_attempt') OR
  (c.relname=ANY($2::text[]) AND t.tgname='immutable_staging_bytes'))`,
      [tables[0], [tables[1], tables[2], tables[3], tables[5]]],
    )
  ).rows[0].n;
  if (triggers !== "5") throw new Error("invalid_staging_backup");
  const refs = (
    await tx.query(`SELECT 1 FROM sync_epoch_staging s LEFT JOIN sync_epoch_authorizations a USING(restore_id,vault_id)
  LEFT JOIN sync_epoch_challenges c ON c.challenge_id=a.challenge_id
  LEFT JOIN sync_restores r ON r.restore_id=s.restore_id
  WHERE a.vault_id IS NULL OR c.owner_issuer<>s.owner_issuer OR c.owner_subject<>s.owner_subject
    OR r.from_epoch<>s.from_epoch OR r.to_epoch<>s.to_epoch LIMIT 1`)
  ).rowCount;
  if (refs) throw new Error("invalid_staging_backup");
  let restore = "00000000-0000-0000-0000-000000000000",
    vault = restore;
  for (;;) {
    const rows = (
      await tx.query(
        "SELECT * FROM sync_epoch_staging WHERE (restore_id,vault_id)>($1::uuid,$2::uuid) ORDER BY restore_id,vault_id LIMIT 100",
        [restore, vault],
      )
    ).rows;
    if (!rows.length) break;
    for (const s of rows) {
      restore = s.restore_id;
      vault = s.vault_id;
      const source = (
        await tx.query("SELECT * FROM sync_vaults WHERE vault_id=$1", [vault])
      ).rows[0];
      // Future activation can move the source to its immutable generation archive.
      const a =
        source?.pin.serverEpoch === s.from_epoch
          ? source
          : (
              await tx.query(
                "SELECT * FROM archive_sync_vaults WHERE vault_id=$1 AND generation_epoch=$2",
                [vault, s.from_epoch],
              )
            ).rows[0];
      const permission = (
        await tx.query(
          "SELECT * FROM sync_epoch_authorizations WHERE restore_id=$1 AND vault_id=$2",
          [restore, vault],
        )
      ).rows[0];
      if (!a || !permission || s.begin_sha256 !== crypto.hash(s.begin_text))
        throw new Error("invalid_staging_backup");
      const begin = validateStagingBegin(
        JSON.parse(s.begin_text),
        a.pin,
        a.key_checkpoints,
        permission.known_grants,
        a.recovery,
        crypto,
      ) as StagingBegin;
      if (
        canonicalStringify(begin) !== s.begin_text ||
        canonicalStringify(begin.authorization) !==
          canonicalStringify(permission.authorization_envelope) ||
        begin.pin.founderDeviceId !== s.anchor_device_id ||
        begin.pin.serverEpoch !== s.to_epoch
      )
        throw new Error("invalid_staging_backup");
      const observed = await stagingManifest(
        tx,
        s,
        begin,
        crypto,
        s.state !== "uploading",
      );
      if (
        s.state === "uploading" &&
        (s.manifest_text !== null || s.heads_sha256 !== null)
      )
        throw new Error("invalid_staging_backup");
      if (
        s.state !== "uploading" &&
        (canonicalStringify(observed) !== s.manifest_text ||
          observed.headsSha256 !== s.heads_sha256)
      )
        throw new Error("invalid_staging_backup");
      const transition = (
        await tx.query(
          "SELECT * FROM sync_epoch_transitions WHERE restore_id=$1 AND vault_id=$2",
          [restore, vault],
        )
      ).rows[0];
      if ((s.state === "prepared") !== Boolean(transition))
        throw new Error("invalid_staging_backup");
      if (transition) {
        const previous = (
          await tx.query(
            "SELECT transition_text FROM sync_epoch_transitions WHERE vault_id=$1 AND to_epoch=$2",
            [vault, s.from_epoch],
          )
        ).rows[0];
        const value = JSON.parse(transition.transition_text);
        verifyEpochTransition(
          value,
          {
            fromPin: a.pin,
            toPin: begin.pin,
            authorization: begin.authorization,
            manifest: observed,
            registry: begin.registry,
            keyCheckpoint: begin.keyBase,
            recovery: begin.recovery,
            previousTransition: previous
              ? JSON.parse(previous.transition_text)
              : null,
          },
          crypto,
        );
        if (
          canonicalStringify(value) !== transition.transition_text ||
          transition.manifest_text !== s.manifest_text ||
          transition.from_epoch !== s.from_epoch ||
          transition.to_epoch !== s.to_epoch ||
          epochTransitionDigest(value, crypto) !== transition.digest ||
          transition.state !== "prepared"
        )
          throw new Error("invalid_staging_backup");
      }
    }
  }
}
