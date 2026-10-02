import {
  assertEpochRecoveryAuthorization, assertBase64Url, assertUuid, canonicalStringify, exactObject,
  validateGrantChain, verifyEpochRecoveryAuthorization,
  type DeviceGrant, type EpochRecoveryChallenge, type TrustPin,
} from '@lionpocket/sync-protocol';
import { validateKeyCheckpoints, type ProvisioningCrypto } from '@lionpocket/sync-local';
import type { PoolClient } from 'pg';
import type { Identity } from './identity';
import { sealRestoredGeneration } from './generations';

/** Caller locks the vault before issuing/consuming a challenge. This handler never activates sync. */
export async function epochRecovery(
  tx: PoolClient, action: string, value: unknown, vaultId: string, account: Identity,
  environment: { serverId: string; serverEpoch: string }, crypto: ProvisioningCrypto,
) {
  const vault = (await tx.query('SELECT * FROM sync_vaults WHERE vault_id=$1 FOR UPDATE', [vaultId])).rows[0];
  if (!vault || vault.owner_issuer !== account.issuer || vault.owner_subject !== account.subject) throw new Error('forbidden');
  const pin = vault.pin as TrustPin;
  const restored = (await tx.query(
    `SELECT r.*, v.source_epoch,v.state FROM sync_restores r JOIN sync_restore_vaults v USING(restore_id)
     WHERE r.server_id=$1 AND r.to_epoch=$2 AND v.vault_id=$3`,
    [environment.serverId, environment.serverEpoch, vaultId],
  )).rows[0];
  if (!restored || pin.serverId !== environment.serverId || pin.serverEpoch === environment.serverEpoch ||
      restored.source_epoch !== pin.serverEpoch) throw new Error('restore_record_required');
  // An unrecovered vault from A in a restored backup of B must not skip B to C.
  const priorAuthorization = (await tx.query(
    `SELECT 1 FROM sync_epoch_authorizations a JOIN sync_restores r USING(restore_id)
     WHERE a.vault_id=$1 AND r.server_id=$2 AND a.restore_id<>$3
       AND a.authorization_envelope->>'fromEpoch'=$4 LIMIT 1`,
    [vaultId, environment.serverId, restored.restore_id, pin.serverEpoch],
  )).rowCount;
  if (restored.from_epoch !== pin.serverEpoch || priorAuthorization) throw new Error('epoch_recovery_chain_required');
  const grants: DeviceGrant[] = (await tx.query(
    'SELECT grant_envelope FROM sync_grants WHERE vault_id=$1 ORDER BY registry_version', [vaultId],
  )).rows.map(r => r.grant_envelope);
  const registry = validateGrantChain(grants, pin, crypto);
  validateKeyCheckpoints(vault.key_checkpoints, pin, grants, { crypto });

  if (action === 'epoch-recovery-challenge') {
    const request = exactObject(value, ['fromEpoch', 'authorityPublicKey']);
    assertUuid(request.fromEpoch, '4'); assertBase64Url(request.authorityPublicKey, 32);
    if (request.fromEpoch !== pin.serverEpoch || request.authorityPublicKey !== pin.authorityPublicKey) throw new Error('scope_mismatch');
    const count = (await tx.query(
      `SELECT count(*)::int AS n FROM sync_epoch_challenges WHERE restore_id=$1 AND vault_id=$2
       AND expires_at > clock_timestamp()-interval '5 minutes'`, [restored.restore_id, vaultId],
    )).rows[0].n;
    if (count >= 5) throw new Error('rate_limited');
    const expiresAt = Number((await tx.query(
      "SELECT floor(extract(epoch FROM clock_timestamp()+interval '5 minutes')*1000)::text AS deadline",
    )).rows[0].deadline);
    // Hash every immutable ciphertext/receipt in visible log order, using bounded pages.
    let logSha256 = crypto.hash(canonicalStringify({ context: 'LionPocket/restored-log/v1', pin }));
    let cursor = '0';
    for (;;) {
      const rows = (await tx.query(
        `SELECT log_position::text,envelope_text,receipt,digest FROM sync_commits
         WHERE vault_id=$1 AND log_position>$2 ORDER BY sync_commits.log_position LIMIT 100`, [vaultId, cursor],
      )).rows;
      if (!rows.length) break;
      for (const row of rows) {
        if (row.digest !== crypto.hash(row.envelope_text) || BigInt(row.log_position) !== BigInt(cursor)+1n)
          throw new Error('invalid_restored_state');
        logSha256 = crypto.hash(canonicalStringify({ context: 'LionPocket/restored-log-entry/v1',
          previousSha256: logSha256, position: row.log_position, envelopeSha256: row.digest, receipt: row.receipt }));
        cursor = row.log_position;
      }
    }
    if (cursor !== String(vault.log_position)) throw new Error('invalid_restored_state');
    const restoredStateSha256 = crypto.hash(canonicalStringify({ context: 'LionPocket/restored-state/v1',
      pin, registry: registry.checkpoint, keyCheckpoints: vault.key_checkpoints, recovery: vault.recovery,
      logPosition: cursor, logSha256 }));
    const challenge: EpochRecoveryChallenge = {
      formatVersion: 1, serverId: pin.serverId, vaultId, fromEpoch: pin.serverEpoch, toEpoch: environment.serverEpoch,
      authorityPublicKey: pin.authorityPublicKey, restoreId: restored.restore_id,
      challengeId: crypto.uuid(), nonce: crypto.nonce(), restoredRegistry: registry.checkpoint, restoredStateSha256, expiresAt,
    };
    await tx.query(
      `INSERT INTO sync_epoch_challenges(challenge_id,restore_id,vault_id,owner_issuer,owner_subject,challenge,expires_at)
       VALUES($1,$2,$3,$4,$5,$6,to_timestamp($7::double precision/1000))`,
      [challenge.challengeId, challenge.restoreId, vaultId, account.issuer, account.subject, challenge, expiresAt],
    );
    // Only public control metadata and the old encrypted recovery bundle; no financial log/plaintext/keys.
    return { challenge, pin, grants, keyCheckpoints: vault.key_checkpoints, recovery: vault.recovery };
  }

  const request = exactObject(value, ['authorization', 'knownGrants']);
  assertEpochRecoveryAuthorization(request.authorization);
  const authorization = request.authorization;
  if (!Array.isArray(request.knownGrants)) throw new Error('invalid_registry');
  const knownGrants = request.knownGrants as DeviceGrant[];
  const known = validateGrantChain(knownGrants, pin, crypto, registry.checkpoint);
  // The entire restored signed history must be a prefix. Lost post-backup revocations are retained in known_grants.
  if (grants.some((grant, i) => canonicalStringify(grant) !== canonicalStringify(knownGrants[i]))) throw new Error('registry_fork');
  const row = (await tx.query(
    `SELECT *, expires_at > clock_timestamp() AS fresh FROM sync_epoch_challenges
     WHERE challenge_id=$1 AND restore_id=$2 AND vault_id=$3 FOR UPDATE`,
    [authorization.challengeId, restored.restore_id, vaultId],
  )).rows[0];
  if (!row || row.owner_issuer !== account.issuer || row.owner_subject !== account.subject) throw new Error('invalid_epoch_challenge');
  verifyEpochRecoveryAuthorization(authorization, { pin, challenge: row.challenge, knownRegistry: known.checkpoint }, crypto);
  const previous = (await tx.query(
    'SELECT authorization_envelope,known_grants FROM sync_epoch_authorizations WHERE restore_id=$1 AND vault_id=$2',
    [restored.restore_id, vaultId],
  )).rows[0];
  // Lost response retry returns the existing permission, never another mutation, even after expiration.
  if (previous && canonicalStringify(previous.authorization_envelope) === canonicalStringify(authorization) &&
      canonicalStringify(previous.known_grants) === canonicalStringify(knownGrants)) {
    await sealRestoredGeneration(tx, vaultId, environment.serverEpoch);
    return { state: 'authorized_awaiting_baseline', activationAvailable: false, authorization: previous.authorization_envelope };
  }
  if (row.consumed) throw new Error('replay');
  if (!row.fresh) throw new Error('epoch_challenge_expired');
  if (previous) throw new Error('epoch_recovery_already_authorized');
  await tx.query('UPDATE sync_epoch_challenges SET consumed=true WHERE challenge_id=$1', [authorization.challengeId]);
  await tx.query(
    'INSERT INTO sync_epoch_authorizations(restore_id,vault_id,challenge_id,authorization_envelope,known_grants) VALUES($1,$2,$3,$4,$5)',
    [restored.restore_id, vaultId, authorization.challengeId, authorization, JSON.stringify(knownGrants)],
  );
  await tx.query("UPDATE sync_restore_vaults SET state='authorized_awaiting_baseline' WHERE restore_id=$1 AND vault_id=$2", [restored.restore_id, vaultId]);
  await sealRestoredGeneration(tx, vaultId, environment.serverEpoch);
  return { state: 'authorized_awaiting_baseline', activationAvailable: false, authorization };
}
