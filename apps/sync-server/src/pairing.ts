import type { PoolClient } from 'pg';
import {
  activeDevice,
  canonicalStringify,
  exactObject,
  sameScope,
  verifyInvite,
  verifyPairing,
  pairingSecurityCode,
  pairingCapabilityInput,
  validateGrantChain,
  type HttpProof,
  type PairingInvite,
  type PairingRequest,
} from '@lionpocket/sync-protocol';
import type { ProvisioningCrypto } from '@lionpocket/sync-local';

export const pairingSchema = `
CREATE TABLE IF NOT EXISTS sync_pairing_invites (
 invite_id uuid PRIMARY KEY, vault_id uuid NOT NULL REFERENCES sync_vaults(vault_id),
 envelope jsonb NOT NULL, capability_hash text NOT NULL, expires_at bigint NOT NULL,
 revoked boolean NOT NULL DEFAULT false, device_id uuid
);
ALTER TABLE sync_pairings ADD COLUMN IF NOT EXISTS invite_id uuid;
ALTER TABLE sync_pairings ADD COLUMN IF NOT EXISTS device_name text;
ALTER TABLE sync_pairings ADD COLUMN IF NOT EXISTS pairing_auth jsonb;
ALTER TABLE sync_pairings ADD COLUMN IF NOT EXISTS denied boolean NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS sync_invites_vault ON sync_pairing_invites(vault_id);
`;
export async function managePairing(
  tx: PoolClient,
  action: string,
  value: unknown,
  vaultId: string,
  crypto: ProvisioningCrypto,
) {
  if (action === 'invite-create') {
    verifyInvite(value, crypto);
    const invite = value as PairingInvite;
    const vault = (
      await tx.query('SELECT pin FROM sync_vaults WHERE vault_id=$1', [vaultId])
    ).rows[0];
    if (
      !vault ||
      canonicalStringify(vault.pin) !== canonicalStringify(invite.pin)
    )
      throw new Error('scope_mismatch');
    if (
      invite.expiresAt <= Date.now() ||
      invite.expiresAt > Date.now() + 16 * 60000
    )
      throw new Error('invite_expired');
    // One live invitation per vault. A claimed invitation stays usable only for its original device status.
    await tx.query(
      'UPDATE sync_pairing_invites SET revoked=true WHERE vault_id=$1 AND device_id IS NULL',
      [vaultId],
    );
    await tx.query(
      'INSERT INTO sync_pairing_invites(invite_id,vault_id,envelope,capability_hash,expires_at) VALUES($1,$2,$3,$4,$5)',
      [invite.id, vaultId, invite, invite.capabilityHash, invite.expiresAt],
    );
  } else if (action === 'invite-revoke') {
    const v = exactObject(value, ['inviteId']);
    await tx.query(
      'UPDATE sync_pairing_invites SET revoked=true WHERE vault_id=$1 AND invite_id=$2',
      [vaultId, v.inviteId],
    );
  } else {
    const v = exactObject(value, ['deviceId']);
    await tx.query(
      'UPDATE sync_pairings SET denied=true WHERE vault_id=$1 AND device_id=$2 AND NOT approved',
      [vaultId, v.deviceId],
    );
  }
  return { ok: true };
}
/** These endpoints never accept account operations. Request capability cannot fetch a registry/key. */
export async function onboardPairing(
  tx: PoolClient,
  action: 'request' | 'status',
  inviteId: string,
  value: unknown,
  proof: HttpProof,
  crypto: ProvisioningCrypto,
  checkProof: (key: string) => Promise<void>,
) {
  let row = (
    await tx.query('SELECT * FROM sync_pairing_invites WHERE invite_id=$1', [
      inviteId,
    ])
  ).rows[0];
  if (!row) throw new Error('invite_invalid');
  const invite = row.envelope as PairingInvite;
  verifyInvite(invite, crypto);
  sameScope(invite.pin, proof);
  const vault = (
    await tx.query('SELECT * FROM sync_vaults WHERE vault_id=$1 FOR UPDATE', [
      row.vault_id,
    ])
  ).rows[0];
  if (
    !vault ||
    canonicalStringify(vault.pin) !== canonicalStringify(invite.pin)
  )
    throw new Error('epoch_changed');
  // All control operations acquire vault before invitation: avoid a claim/revoke deadlock.
  row = (
    await tx.query(
      'SELECT * FROM sync_pairing_invites WHERE invite_id=$1 FOR UPDATE',
      [inviteId],
    )
  ).rows[0];
  if (!row) throw new Error('invite_invalid');
  if (
    (
      await tx.query(
        'SELECT 1 FROM sync_disabled_accounts WHERE issuer=$1 AND subject=$2',
        [vault.owner_issuer, vault.owner_subject],
      )
    ).rowCount
  )
    throw new Error('forbidden');
  const grants = (
    await tx.query(
      'SELECT grant_envelope FROM sync_grants WHERE vault_id=$1 ORDER BY registry_version',
      [row.vault_id],
    )
  ).rows.map((r) => r.grant_envelope);
  const registry = validateGrantChain(grants, invite.pin, crypto);
  if (action === 'request') {
    const v = exactObject(value, [
      'capabilitySignature',
      'request',
      'deviceName',
    ]);
    if (row.revoked) throw new Error('invite_revoked');
    if (Number(row.expires_at) <= Date.now()) throw new Error('invite_expired');
    const request = v.request as PairingRequest;
    verifyPairing(request, crypto);
    sameScope(request, invite.pin);
    if (request.deviceId !== proof.deviceId) throw new Error('forbidden');
    if (
      typeof v.capabilitySignature !== 'string' ||
      !crypto.verify(
        v.capabilitySignature,
        pairingCapabilityInput(invite, request, String(v.deviceName)),
        invite.capabilityPublicKey,
      )
    )
      throw new Error('invite_invalid');
    await checkProof(request.signingPublicKey);
    if (
      typeof v.deviceName !== 'string' ||
      v.deviceName.length < 1 ||
      v.deviceName.length > 80 ||
      Array.from(v.deviceName).some(
        (c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127,
      )
    )
      throw new Error('invalid_envelope');
    if (row.device_id && row.device_id !== request.deviceId)
      throw new Error('invite_consumed');
    const prior = (
      await tx.query(
        'SELECT request,denied,invite_id FROM sync_pairings WHERE vault_id=$1 AND device_id=$2',
        [row.vault_id, request.deviceId],
      )
    ).rows[0];
    if (prior?.denied && prior.invite_id === inviteId)
      throw new Error('pairing_denied');
    if (
      prior &&
      canonicalStringify(prior.request) !== canonicalStringify(request)
    )
      throw new Error('pairing_exists');
    if (registry.devices.has(request.deviceId))
      throw new Error('pairing_exists');
    if (prior && prior.invite_id !== inviteId) {
      await tx.query(
        'UPDATE sync_pairings SET denied=false,invite_id=$3,device_name=$4,pairing_auth=$5 WHERE vault_id=$1 AND device_id=$2 AND NOT approved',
        [
          row.vault_id,
          request.deviceId,
          inviteId,
          v.deviceName,
          {
            invite,
            deviceName: v.deviceName,
            capabilitySignature: v.capabilitySignature,
          },
        ],
      );
      await tx.query(
        'UPDATE sync_pairing_invites SET device_id=$2 WHERE invite_id=$1',
        [inviteId, request.deviceId],
      );
    }
    if (!prior) {
      const count = (
        await tx.query(
          'SELECT count(*)::int AS n FROM sync_pairings p LEFT JOIN sync_pairing_invites i ON i.invite_id=p.invite_id WHERE p.vault_id=$1 AND NOT p.approved AND NOT p.denied AND (p.invite_id IS NULL OR (NOT i.revoked AND i.expires_at>$2))',
          [row.vault_id, Date.now()],
        )
      ).rows[0].n;
      if (count >= 10) throw new Error('rate_limited');
      await tx.query(
        'INSERT INTO sync_pairings(vault_id,device_id,fingerprint,request,invite_id,device_name,pairing_auth) VALUES($1,$2,$3,$4,$5,$6,$7)',
        [
          row.vault_id,
          request.deviceId,
          request.fingerprint,
          request,
          inviteId,
          v.deviceName,
          {
            invite,
            deviceName: v.deviceName,
            capabilitySignature: v.capabilitySignature,
          },
        ],
      );
      await tx.query(
        'UPDATE sync_pairing_invites SET device_id=$2 WHERE invite_id=$1',
        [inviteId, request.deviceId],
      );
    }
    return { state: 'waiting' };
  }
  exactObject(value, []);
  if (row.device_id !== proof.deviceId) throw new Error('forbidden');
  const pairing = (
    await tx.query(
      'SELECT request,denied,invite_id FROM sync_pairings WHERE vault_id=$1 AND device_id=$2',
      [row.vault_id, proof.deviceId],
    )
  ).rows[0];
  if (!pairing) throw new Error('pairing_missing');
  await checkProof(pairing.request.signingPublicKey);
  if (pairing.denied) throw new Error('pairing_denied');
  if (!registry.devices.has(proof.deviceId)) {
    if (row.revoked) throw new Error('invite_revoked');
    if (Number(row.expires_at) <= Date.now()) throw new Error('invite_expired');
    return { state: 'waiting' };
  }
  const device = activeDevice(registry.devices, proof.deviceId);
  if (
    device.signingPublicKey !== pairing.request.signingPublicKey ||
    device.boxPublicKey !== pairing.request.boxPublicKey
  )
    throw new Error('invalid_pairing_grant');
  const delivery = (
    await tx.query(
      'SELECT delivery FROM sync_deliveries WHERE vault_id=$1 AND recipient_device_id=$2',
      [row.vault_id, proof.deviceId],
    )
  ).rows[0]?.delivery;
  if (!delivery) return { state: 'waiting' };
  return {
    state: 'approved',
    pin: invite.pin,
    grants,
    delivery,
    keyCheckpoints: vault.key_checkpoints,
  };
}
export function namedRequest(
  row: {
    request: PairingRequest;
    device_name?: string;
    invite_id?: string;
    pairing_auth?: unknown;
  },
  crypto: ProvisioningCrypto,
) {
  return {
    ...row.request,
    pairingAuth: row.pairing_auth ?? null,
    deviceName: row.device_name || 'Novo aparelho',
    securityCode: pairingSecurityCode(row.invite_id ?? '', row.request, crypto),
  };
}
