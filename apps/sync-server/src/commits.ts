import type { PoolClient } from 'pg';
import {
  activeDevice,
  assertDecimal64,
  assertUuid,
  canonicalStringify,
  commitSigningInput,
  decodeCommit,
  exactObject,
  sameScope,
  validateGrantChain,
  type CommitEnvelope,
  type CommitReceipt,
  type DeviceGrant,
  type TrustPin,
} from '@lionpocket/sync-protocol';
import type { ProvisioningCrypto } from '@lionpocket/sync-local';

/** Caller holds the vault row lock and the HTTP proof savepoint. All ciphertext and graph writes are atomic. */
export async function acceptCommit(
  tx: PoolClient,
  bytes: Uint8Array,
  pin: TrustPin,
  grants: DeviceGrant[],
  deviceId: string,
  crypto: ProvisioningCrypto,
) {
  const envelope = decodeCommit(bytes);
  sameScope(envelope, pin);
  if (envelope.deviceId !== deviceId) throw new Error('forbidden');
  if (envelope.keyVersion !== pin.keyVersion)
    throw new Error('key_version_mismatch');
  const current = validateGrantChain(grants, pin, crypto);
  const author = activeDevice(current.devices, deviceId);
  if (!grants.some((g) => g.registryVersion === envelope.deviceRegistryVersion))
    throw new Error('registry_order');
  const history = validateGrantChain(
    grants.filter(
      (g) =>
        BigInt(g.registryVersion) <= BigInt(envelope.deviceRegistryVersion),
    ),
    pin,
    crypto,
  );
  activeDevice(history.devices, deviceId);
  const { signature, ...unsigned } = envelope;
  if (
    !crypto.verify(
      signature,
      commitSigningInput(unsigned),
      author.signingPublicKey,
    )
  )
    throw new Error('invalid_signature');
  const text = canonicalStringify(envelope),
    digest = crypto.hash(text);
  const existing = (
    await tx.query(
      'SELECT envelope_text,digest,receipt FROM sync_commits WHERE vault_id=$1 AND (commit_id=$2 OR (device_id=$3 AND device_seq=$4))',
      [pin.vaultId, envelope.commitId, deviceId, envelope.deviceSeq],
    )
  ).rows;
  if (existing.length) {
    if (
      existing.length !== 1 ||
      existing[0].envelope_text !== text ||
      existing[0].digest !== digest
    )
      throw new Error('idempotency_mismatch');
    return existing[0].receipt as CommitReceipt;
  }
  const objectHeads = new Map<string, string[]>(),
    operations = new Map<string, { objectId: string }>();
  const missing = new Set<string>();
  for (const op of envelope.operations) {
    if (
      (
        await tx.query(
          'SELECT 1 FROM sync_operations WHERE vault_id=$1 AND op_id=$2',
          [pin.vaultId, op.opId],
        )
      ).rowCount
    )
      throw new Error('idempotency_mismatch');
    if (!objectHeads.has(op.objectId))
      objectHeads.set(
        op.objectId,
        (
          await tx.query(
            'SELECT op_id::text FROM sync_remote_heads WHERE vault_id=$1 AND object_id=$2 ORDER BY op_id',
            [pin.vaultId, op.objectId],
          )
        ).rows.map((r) => r.op_id),
      );
    for (const parent of op.parents) {
      const prior = operations.get(parent);
      const remote =
        prior ??
        (
          await tx.query(
            'SELECT object_id::text AS "objectId" FROM sync_operations WHERE vault_id=$1 AND op_id=$2',
            [pin.vaultId, parent],
          )
        ).rows[0];
      if (!remote) missing.add(parent);
      else if (remote.objectId !== op.objectId)
        throw new Error('invalid_envelope');
    }
    const heads = objectHeads.get(op.objectId) as string[];
    if (
      op.expectedHeads &&
      canonicalStringify(heads) !== canonicalStringify(op.expectedHeads)
    )
      throw new Error('heads_changed');
    objectHeads.set(
      op.objectId,
      [...heads.filter((id) => !op.parents.includes(id)), op.opId].sort(),
    );
    operations.set(op.opId, { objectId: op.objectId });
  }
  if (missing.size)
    throw new CommitRejection('missing_parents', [...missing].sort());
  const position = (
    await tx.query(
      'UPDATE sync_vaults SET log_position=log_position+1 WHERE vault_id=$1 RETURNING log_position::text',
      [pin.vaultId],
    )
  ).rows[0].log_position as string;
  const receipt: CommitReceipt = {
    serverId: pin.serverId,
    serverEpoch: pin.serverEpoch,
    vaultId: pin.vaultId,
    commitId: envelope.commitId,
    deviceId,
    deviceSeq: envelope.deviceSeq,
    result: 'accepted',
    logPosition: position,
    envelopeSha256: digest,
    acceptedRegistryVersion: current.checkpoint.version,
    heads: [...objectHeads]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([objectId, revisionIds]) => ({ objectId, revisionIds })),
  };
  await tx.query(
    'INSERT INTO sync_commits(vault_id,commit_id,device_id,device_seq,log_position,envelope_text,digest,accepted_registry_version,receipt) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
    [
      pin.vaultId,
      envelope.commitId,
      deviceId,
      envelope.deviceSeq,
      position,
      text,
      digest,
      current.checkpoint.version,
      receipt,
    ],
  );
  for (const op of envelope.operations)
    await tx.query(
      'INSERT INTO sync_operations(vault_id,op_id,object_id,commit_id,parents) VALUES($1,$2,$3,$4,$5)',
      [pin.vaultId, op.opId, op.objectId, envelope.commitId, op.parents],
    );
  for (const [objectId, heads] of objectHeads) {
    await tx.query(
      'DELETE FROM sync_remote_heads WHERE vault_id=$1 AND object_id=$2',
      [pin.vaultId, objectId],
    );
    for (const head of heads)
      await tx.query('INSERT INTO sync_remote_heads VALUES($1,$2,$3)', [
        pin.vaultId,
        objectId,
        head,
      ]);
  }
  return receipt;
}
export class CommitRejection extends Error {
  constructor(
    message: string,
    readonly missingParents: string[],
  ) {
    super(message);
  }
}
export async function changesPage(
  tx: PoolClient,
  value: unknown,
  pin: TrustPin,
  deviceId: string,
) {
  const request = exactObject(value, [
    'formatVersion',
    'bindingId',
    'serverId',
    'serverEpoch',
    'vaultId',
    'cursor',
    'upperBound',
    'limit',
  ]);
  sameScope(request as unknown as TrustPin, pin);
  assertUuid(request.bindingId, '4');
  assertDecimal64(request.cursor);
  if (
    request.formatVersion !== 1 ||
    !Number.isInteger(request.limit) ||
    Number(request.limit) < 1 ||
    Number(request.limit) > 100
  )
    throw new Error('invalid_envelope');
  await tx.query(
    'INSERT INTO sync_remote_bindings(binding_id,vault_id,server_epoch,device_id) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',
    [request.bindingId, pin.vaultId, pin.serverEpoch, deviceId],
  );
  const [binding] = (
    await tx.query(
      'SELECT vault_id::text,server_epoch::text,device_id::text FROM sync_remote_bindings WHERE binding_id=$1',
      [request.bindingId],
    )
  ).rows;
  if (
    !binding ||
    binding.vault_id !== pin.vaultId ||
    binding.server_epoch !== pin.serverEpoch ||
    binding.device_id !== deviceId
  )
    throw new Error('binding_mismatch');
  const latest = (
    await tx.query(
      'SELECT log_position::text FROM sync_vaults WHERE vault_id=$1',
      [pin.vaultId],
    )
  ).rows[0].log_position as string;
  const upper = request.upperBound === null ? latest : request.upperBound;
  assertDecimal64(upper);
  if (
    BigInt(upper) > BigInt(latest) ||
    BigInt(String(request.cursor)) > BigInt(upper)
  )
    throw new Error('cursor_mismatch');
  const rows = (
    await tx.query(
      'SELECT log_position::text,octet_length(envelope_text) AS size,accepted_registry_version::text FROM sync_commits WHERE vault_id=$1 AND log_position>$2 AND log_position<=$3 ORDER BY sync_commits.log_position LIMIT $4',
      [pin.vaultId, request.cursor, upper, request.limit],
    )
  ).rows;
  const entries: {
    logPosition: string;
    acceptedRegistryVersion: string;
    envelope: CommitEnvelope;
  }[] = [];
  let size = 2048;
  for (const row of rows) {
    const cost = Number(row.size) + 256;
    if (size + cost > 4194304) break;
    size += cost;
    const envelope = (
      await tx.query(
        'SELECT envelope_text FROM sync_commits WHERE vault_id=$1 AND log_position=$2',
        [pin.vaultId, row.log_position],
      )
    ).rows[0].envelope_text;
    entries.push({
      logPosition: row.log_position,
      acceptedRegistryVersion: row.accepted_registry_version,
      envelope: JSON.parse(envelope),
    });
  }
  const next = entries.at(-1)?.logPosition ?? request.cursor;
  return {
    serverId: pin.serverId,
    serverEpoch: pin.serverEpoch,
    vaultId: pin.vaultId,
    bindingId: request.bindingId,
    upperBound: upper,
    nextCursor: next,
    hasMore: BigInt(String(next)) < BigInt(upper),
    commits: entries,
  };
}
