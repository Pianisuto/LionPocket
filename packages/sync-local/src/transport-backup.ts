import {
  assertBase64Url,
  assertCommitEnvelope,
  assertCommitReceipt,
  sameScope,
  assertDecimal64,
  assertManualTransactionRevision, assertFinancialRevision, assertSupportedRevision,
  assertTrustPin,
  assertUuid,
  canonicalStringify,
  type CommitEnvelope,
} from '@lionpocket/sync-protocol';
import { envelopeDigest } from './digest';
import { transportColumns, transportTables, syncColumns, syncTables } from './schema';
import type { SqlRow } from './manual';
import { compareDecimal } from './transport-state';
const json = (text: unknown): unknown => {
  if (typeof text !== 'string') throw new Error('Missing sync payload.');
  const value: unknown = JSON.parse(text);
  if (canonicalStringify(value) !== text)
    throw new Error('Noncanonical sync payload.');
  return value;
};
export function validateTransportBackup(data: Record<string, SqlRow[]>): void {
  const financial=!!data.sync_control;
  const tables=financial ? syncTables : transportTables, columns=financial ? syncColumns : transportColumns;
  for (const table of tables) {
    if (!Array.isArray(data[table]))
      throw new Error(`Missing sync table: ${table}`);
    for (const row of data[table]) {
      const keys = columns[table];
      if (
        Object.keys(row).length !== keys.length ||
        keys.some((k) => !Object.hasOwn(row, k)) ||
        Object.values(row).some(
          (v) => v !== null && typeof v !== 'string' && typeof v !== 'number',
        )
      )
        throw new Error(`Invalid sync columns: ${table}`);
    }
  }
  const states = data.sync_local_state;
  if (states.length !== 1 || states[0].id !== 1)
    throw new Error('Invalid local sync state.');
  const state = states[0];
  if (!['disabled', 'synthetic_manual', 'financial'].includes(String(state.mode)))
    throw new Error('Invalid local sync mode.');
  if (state.local_scope_id !== null) assertUuid(state.local_scope_id, '4');
  if (state.mode === 'synthetic_manual' && !state.local_scope_id)
    throw new Error('Missing local lineage.');
  for (const key of [
    'local_seq',
    'device_seq',
    'received_cursor',
    'applied_cursor',
  ])
    assertDecimal64(state[key]);
  if (
    compareDecimal(
      String(state.applied_cursor),
      String(state.received_cursor),
    ) > 0
  )
    throw new Error('Invalid applied cursor.');
  for (const key of [
    'server_id',
    'server_epoch',
    'vault_id',
    'device_id',
    'binding_id',
  ])
    if (state[key] !== null) assertUuid(state[key], '4');
  if (state.pull_upper_bound !== null) {
    assertDecimal64(state.pull_upper_bound);
    if (
      compareDecimal(
        String(state.pull_upper_bound),
        String(state.received_cursor),
      ) < 0
    )
      throw new Error('Invalid pull bound.');
  }
  const bindings = new Map<string, SqlRow>();
  for (const row of data.sync_bindings) {
    for (const key of [
      'binding_id',
      'local_scope_id',
      'server_id',
      'server_epoch',
      'vault_id',
      'device_id',
    ])
      assertUuid(row[key], '4');
    if (bindings.has(String(row.binding_id)))
      throw new Error('Duplicate binding.');
    const pin = json(row.pin_json);
    assertTrustPin(pin);
    if (
      pin.serverId !== row.server_id ||
      pin.serverEpoch !== row.server_epoch ||
      pin.vaultId !== row.vault_id
    )
      throw new Error('Binding pin mismatch.');
    if (
      typeof row.endpoint !== 'string' ||
      !/^https?:\/\//.test(row.endpoint) ||
      !Array.isArray(json(row.registry_json))
    )
      throw new Error('Invalid binding.');
    json(row.checkpoint_json);
    bindings.set(String(row.binding_id), row);
  }
  if (state.binding_id !== null) {
    const b = bindings.get(String(state.binding_id));
    if (
      !b ||
      [
        'local_scope_id',
        'server_id',
        'server_epoch',
        'vault_id',
        'device_id',
      ].some((k) => b[k] !== state[k])
    )
      throw new Error('Invalid active binding.');
  }
  const identities = new Map<string, SqlRow>(),
    localIds = new Set<string>();
  for (const r of data.sync_identity) {
    assertUuid(r.object_id);
    if (
      !['manualTransaction','transaction','category','paymentMethod','card','recurring','installmentPurchase','goal','recurringPriorityList','monthlyPriorityList','monthlyPlanning'].includes(String(r.entity_type)) ||
      typeof r.local_id !== 'string' ||
      !r.local_id ||
      identities.has(String(r.object_id)) ||
      localIds.has(`${r.entity_type}:${r.local_id}`)
    )
      throw new Error('Invalid sync identity.');
    identities.set(String(r.object_id), r);
    localIds.add(`${r.entity_type}:${r.local_id}`);
  }
  const revisions = new Map<string, SqlRow>(),
    parents = new Map<string, string[]>(),
    sequences = new Set<string>();
  for (const r of data.sync_revisions) {
    assertUuid(r.revision_id, '4');
    assertUuid(r.commit_id, '4');
    assertDecimal64(r.local_seq, true);
    if (
      !identities.has(String(r.object_id)) ||
      revisions.has(String(r.revision_id)) ||
      sequences.has(String(r.local_seq)) ||
      compareDecimal(String(r.local_seq), String(state.local_seq)) > 0
    )
      throw new Error('Invalid revision identity.');
    const payload = json(r.payload_json);
    assertSupportedRevision(payload, financial);
    if (payload.action !== r.action || payload.authoredAt !== r.authored_at)
      throw new Error('Revision metadata mismatch.');
    const ids = json(r.parents_json);
    if (!Array.isArray(ids) || ids.length > 32)
      throw new Error('Invalid manual parents.');
    ids.forEach((id, i) => {
      assertUuid(id, '4');
      if (id === r.revision_id || (i && ids[i - 1] >= id))
        throw new Error('Invalid parent set.');
    });
    parents.set(String(r.revision_id), ids);
    revisions.set(String(r.revision_id), r);
    sequences.add(String(r.local_seq));
  }
  const rejected = new Set(
    data.sync_rejected.map((r) => String(r.revision_id)),
  );
  if (
    rejected.size !== data.sync_rejected.length ||
    [...rejected].some((id) => !revisions.has(id))
  )
    throw new Error('Invalid rejected revision.');
  const referenced = new Set<string>();
  for (const [id, ids] of parents)
    for (const parent of ids) {
      const p = revisions.get(parent),
        c = revisions.get(id)!;
      if (
        !p ||
        p.object_id !== c.object_id ||
        compareDecimal(String(p.local_seq), String(c.local_seq)) >= 0
      )
        throw new Error('Missing, foreign or cyclic parent.');
      if (!rejected.has(id)) referenced.add(parent);
    }
  const heads = new Set<string>();
  for (const r of data.sync_heads) {
    const rev = revisions.get(String(r.revision_id));
    if (
      !rev ||
      rev.object_id !== r.object_id ||
      heads.has(String(r.revision_id)) ||
      referenced.has(String(r.revision_id))
    )
      throw new Error('Invalid head.');
    heads.add(String(r.revision_id));
  }
  for (const id of revisions.keys())
    if (!rejected.has(id) && !referenced.has(id) && !heads.has(id))
      throw new Error('Missing head.');
  const tombstones = new Set<string>();
  for (const r of data.sync_tombstones) {
    const rev = revisions.get(String(r.revision_id));
    if (
      !rev ||
      rev.action !== 'delete' ||
      rev.object_id !== r.object_id ||
      (json(rev.payload_json) as { deletedAt: string }).deletedAt !==
        r.deleted_at ||
      tombstones.has(String(r.revision_id))
    )
      throw new Error('Invalid tombstone.');
    tombstones.add(String(r.revision_id));
  }
  for (const [id, r] of revisions)
    if (r.action === 'delete' && !tombstones.has(id))
      throw new Error('Missing tombstone.');
  const origins = new Set<string>();
  for (const r of data.sync_revision_origin) {
    if (
      !revisions.has(String(r.revision_id)) ||
      origins.has(String(r.revision_id))
    )
      throw new Error('Invalid revision origin.');
    assertUuid(r.device_id, '4');
    assertDecimal64(r.device_seq, true);
    assertDecimal64(r.registry_version, true);
    if (r.log_position !== null) assertDecimal64(r.log_position, true);
    origins.add(String(r.revision_id));
  }
  const outbox = new Set<string>();
  for (const r of data.sync_outbox) {
    assertUuid(r.commit_id, '4');
    assertDecimal64(r.local_seq, true);
    if (
      outbox.has(String(r.commit_id)) ||
      ![
        'pending',
        'prepared',
        'in_flight',
        'acknowledged',
        'retry',
        'blocked',
      ].includes(String(r.state))
    )
      throw new Error('Invalid local outbox.');
    const pending = json(r.payload_json) as {
      formatVersion: number;
      commitId: string;
      localSeq: string;
      operations: {
        opId: string;
        objectId: string;
        parents: string[];
        revision: unknown;
        expectedHeads?: string[];
      }[];
    };
    if (
      pending.formatVersion !== 1 ||
      pending.commitId !== r.commit_id ||
      pending.localSeq !== r.local_seq ||
      !Array.isArray(pending.operations) ||
      pending.operations.length < 1 || pending.operations.length > 100
    )
      throw new Error('Outbox/revision mismatch.');
    for (const op of pending.operations) {
      const rev = revisions.get(op.opId);
      if (
        !rev ||
        rev.commit_id !== r.commit_id ||
        compareDecimal(String(rev.local_seq),String(r.local_seq))>0 ||
        rev.object_id !== op.objectId ||
        rev.parents_json !== canonicalStringify(op.parents) ||
        rev.payload_json !== canonicalStringify(op.revision)
      )
        throw new Error('Outbox/revision mismatch.');
      if (
        op.expectedHeads &&
        canonicalStringify(op.parents) !== canonicalStringify(op.expectedHeads)
      )
        throw new Error('Invalid reviewed heads.');
    }
    if ((r.envelope_json === null) !== (r.envelope_sha256 === null))
      throw new Error('Incomplete envelope.');
    if (r.envelope_json !== null) {
      const envelope = json(r.envelope_json);
      assertCommitEnvelope(envelope);
      assertBase64Url(r.envelope_sha256, 32);
      if (envelopeDigest(String(r.envelope_json)) !== r.envelope_sha256)
        throw new Error('Envelope digest mismatch.');
      if (
        envelope.commitId !== r.commit_id ||
        canonicalStringify(
          envelope.operations.map(
            ({ opId, objectId, parents, expectedHeads }) => ({
              opId,
              objectId,
              parents,
              ...(expectedHeads ? { expectedHeads } : {}),
            }),
          ),
        ) !==
          canonicalStringify(
            pending.operations.map(
              ({ opId, objectId, parents, expectedHeads }) => ({
                opId,
                objectId,
                parents,
                ...(expectedHeads ? { expectedHeads } : {}),
              }),
            ),
          )
      )
        throw new Error('Envelope/revision mismatch.');
      if (pending.operations.some((o) => !origins.has(o.opId)))
        throw new Error('Missing prepared origin.');
    } else if (!['pending', 'retry'].includes(String(r.state)) && !(r.state==='blocked'&&['key_rotated','batch_too_large','rotation_resolution_review'].includes(String(r.last_error))))
      throw new Error('Missing prepared envelope.');
    if (r.receipt_json !== null) {
      const receipt = json(r.receipt_json);
      assertCommitReceipt(receipt);
      const envelope = json(r.envelope_json);
      assertCommitEnvelope(envelope);
      sameScope(receipt, envelope);
      if (
        receipt.deviceId !== envelope.deviceId ||
        receipt.deviceSeq !== envelope.deviceSeq
      )
        throw new Error('Receipt header mismatch.');
      if (
        receipt.commitId !== r.commit_id ||
        receipt.envelopeSha256 !== r.envelope_sha256 ||
        r.state !== 'acknowledged'
      )
        throw new Error('Receipt mismatch.');
      assertDecimal64(receipt.logPosition, true);
    } else if (r.state === 'acknowledged') throw new Error('Missing receipt.');
    outbox.add(String(r.commit_id));
  }
  const inbox = new Set<string>(),
    positions = new Set<string>();
  for (const r of data.sync_inbox) {
    assertUuid(r.commit_id, '4');
    assertDecimal64(r.log_position, true);
    assertDecimal64(r.accepted_registry_version, true);
    const e = json(r.envelope_json) as CommitEnvelope;
    assertUuid(e.commitId, '4');
    for (const key of ['serverId', 'serverEpoch', 'vaultId'] as const)
      assertUuid(e[key], '4');
    if (state.binding_id !== null) {
      const b = bindings.get(String(state.binding_id));
      if (
        !b ||
        e.serverId !== b.server_id ||
        e.serverEpoch !== b.server_epoch ||
        e.vaultId !== b.vault_id
      )
        throw new Error('Inbox binding mismatch.');
    }
    if (
      e.commitId !== r.commit_id ||
      inbox.has(String(r.commit_id)) ||
      positions.has(String(r.log_position)) ||
      !['received', 'applied', 'quarantined'].includes(String(r.state)) ||
      compareDecimal(String(r.log_position), String(state.received_cursor)) > 0
    )
      throw new Error('Invalid inbox.');
    if (r.state === 'applied') {
      assertCommitEnvelope(e);
      if (e.operations.some((o) => !revisions.has(o.opId)))
        throw new Error('Missing applied revision.');
    }
    inbox.add(String(r.commit_id));
    positions.add(String(r.log_position));
  }
  for (const r of revisions.values())
    if (!outbox.has(String(r.commit_id)) && !inbox.has(String(r.commit_id)))
      throw new Error('Missing commit history.');
  const conflicts = new Set<string>(),
    open = new Set<string>();
  for (const r of data.sync_conflicts) {
    assertUuid(r.conflict_id, '4');
    if (
      !identities.has(String(r.object_id)) ||
      conflicts.has(String(r.conflict_id))
    )
      throw new Error('Invalid conflict.');
    const ids = json(r.heads_json);
    if (
      !Array.isArray(ids) ||
      ids.length < 2 ||
      ids.some(
        (id, i) =>
          !revisions.has(id) ||
          revisions.get(id)!.object_id !== r.object_id ||
          (i && ids[i - 1] >= id),
      )
    )
      throw new Error('Invalid conflict heads.');
    for (const key of ['base_revision_id', 'resolution_id'])
      if (
        r[key] !== null &&
        revisions.get(String(r[key]))?.object_id !== r.object_id
      )
        throw new Error('Invalid conflict reference.');
    if (r.resolution_id === null) {
      if (
        open.has(String(r.object_id)) ||
        canonicalStringify(
          data.sync_heads
            .filter((h) => h.object_id === r.object_id)
            .map((h) => h.revision_id)
            .sort(),
        ) !== r.heads_json
      )
        throw new Error('Conflict heads mismatch.');
      open.add(String(r.object_id));
    }
    conflicts.add(String(r.conflict_id));
  }
}
