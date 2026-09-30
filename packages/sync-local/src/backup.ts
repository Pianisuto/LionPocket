import {
  assertCommitEnvelope,
  assertDecimal64,
  assertManualTransactionRevision,
  assertUuid,
  canonicalStringify,
} from '@lionpocket/sync-protocol';
import { foundationColumns as syncColumns, foundationTables as syncTables } from './schema';
import { validateTransportBackup } from './transport-backup';
import type { SqlRow } from './manual';
/** This is local backup validation, not an untrusted network decoder. */
export function validateSyncBackup(data: Record<string, SqlRow[]>, version = data.sync_bindings ? 7 : 6): void {
  if (version >= 7) return validateTransportBackup(data);
  for (const table of syncTables) {
    if (!Array.isArray(data[table]))
      throw new Error(`Missing sync table: ${table}`);
    for (const row of data[table]) {
      const columns = syncColumns[table];
      if (
        Object.keys(row).length !== columns.length ||
        columns.some((c) => !Object.hasOwn(row, c))
      )
        throw new Error(`Invalid sync columns: ${table}`);
      if (
        Object.values(row).some(
          (v) => v !== null && typeof v !== 'string' && typeof v !== 'number',
        )
      )
        throw new Error('Invalid sync backup value.');
    }
  }
  const states = data.sync_local_state;
  if (states.length !== 1 || states[0].id !== 1)
    throw new Error('Invalid local sync state.');
  const state = states[0];
  if (!['disabled', 'synthetic_manual'].includes(String(state.mode)))
    throw new Error('Invalid local sync mode.');
  if (state.local_scope_id !== null) assertUuid(state.local_scope_id, '4');
  if (state.mode === 'synthetic_manual' && state.local_scope_id === null)
    throw new Error('Missing local lineage.');
  for (const key of [
    'local_seq',
    'device_seq',
    'received_cursor',
    'applied_cursor',
  ])
    assertDecimal64(state[key]);
  // This first slice cannot establish a remote binding or restore an installation.
  for (const key of ['server_id', 'server_epoch', 'vault_id', 'device_id'])
    if (state[key] !== null)
      throw new Error('Remote bindings are not supported yet.');
  if (
    state.device_seq !== '0' ||
    state.received_cursor !== '0' ||
    state.applied_cursor !== '0'
  )
    throw new Error('Remote counters are not supported yet.');
  const identities = new Map<string, SqlRow>(),
    localIds = new Set<string>();
  for (const row of data.sync_identity) {
    if (
      row.entity_type !== 'manualTransaction' ||
      typeof row.local_id !== 'string' ||
      !row.local_id ||
      localIds.has(row.local_id)
    )
      throw new Error('Invalid sync identity.');
    assertUuid(row.object_id, '4');
    if (identities.has(row.object_id))
      throw new Error('Duplicate global identity.');
    identities.set(row.object_id, row);
    localIds.add(row.local_id);
  }
  const revisions = new Map<string, SqlRow>(),
    sequences = new Set<string>(),
    commits = new Map<string, SqlRow>();
  const json = (value: unknown): unknown => {
    if (typeof value !== 'string') throw new Error('Missing sync payload.');
    const parsed: unknown = JSON.parse(value);
    if (canonicalStringify(parsed) !== value)
      throw new Error('Noncanonical sync payload.');
    return parsed;
  };
  const payloads = new Map<string, unknown>(),
    parents = new Map<string, string[]>();
  for (const row of data.sync_revisions) {
    assertUuid(row.revision_id, '4');
    assertUuid(row.commit_id, '4');
    assertDecimal64(row.local_seq, true);
    if (
      !identities.has(String(row.object_id)) ||
      revisions.has(row.revision_id) ||
      sequences.has(row.local_seq) ||
      commits.has(row.commit_id)
    )
      throw new Error('Invalid revision identity.');
    const sequence = String(row.local_seq),
      last = String(state.local_seq);
    if (
      sequence.length > last.length ||
      (sequence.length === last.length && sequence > last)
    )
      throw new Error('Revision counter exceeds local state.');
    const payload = json(row.payload_json);
    assertManualTransactionRevision(payload);
    if (
      payload.provenance.localScopeId !== state.local_scope_id ||
      payload.action !== row.action ||
      payload.authoredAt !== row.authored_at
    )
      throw new Error('Revision metadata mismatch.');
    const parentIds = json(row.parents_json);
    if (!Array.isArray(parentIds) || parentIds.length > 1)
      throw new Error('Invalid manual parents.');
    for (const id of parentIds) {
      assertUuid(id, '4');
      if (id === row.revision_id) throw new Error('Self parent.');
    }
    revisions.set(row.revision_id, row);
    sequences.add(row.local_seq);
    commits.set(row.commit_id, row);
    payloads.set(row.revision_id, payload);
    parents.set(row.revision_id, parentIds);
  }
  const referenced = new Set<string>();
  for (const [id, ids] of parents)
    for (const parentId of ids) {
      const child = revisions.get(id),
        parent = revisions.get(parentId);
      if (!child || !parent || child.object_id !== parent.object_id)
        throw new Error('Missing or foreign parent.');
      const a = String(parent.local_seq),
        b = String(child.local_seq);
      if (a.length > b.length || (a.length === b.length && a >= b))
        throw new Error('Cyclic or reversed local history.');
      referenced.add(parentId);
    }
  const checkLink = (row: SqlRow) => {
    const revision = revisions.get(String(row.revision_id));
    if (!revision || revision.object_id !== row.object_id)
      throw new Error('Invalid sync revision reference.');
    return revision;
  };
  const heads = new Set<string>();
  for (const row of data.sync_heads) {
    checkLink(row);
    if (
      heads.has(String(row.revision_id)) ||
      referenced.has(String(row.revision_id))
    )
      throw new Error('Invalid head.');
    heads.add(String(row.revision_id));
  }
  for (const id of revisions.keys())
    if (!referenced.has(id) && !heads.has(id)) throw new Error('Missing head.');
  const tombstones = new Set<string>();
  for (const row of data.sync_tombstones) {
    const revision = checkLink(row),
      payload = payloads.get(String(row.revision_id)) as { deletedAt?: string };
    if (
      revision.action !== 'delete' ||
      payload.deletedAt !== row.deleted_at ||
      tombstones.has(String(row.revision_id))
    )
      throw new Error('Invalid tombstone.');
    tombstones.add(String(row.revision_id));
  }
  for (const [id, row] of revisions)
    if (row.action === 'delete' && !tombstones.has(id))
      throw new Error('Missing tombstone.');
  const outbox = new Set<string>();
  for (const row of data.sync_outbox) {
    const revision = commits.get(String(row.commit_id));
    if (
      !revision ||
      outbox.has(String(row.commit_id)) ||
      row.local_seq !== revision.local_seq ||
      row.state !== 'pending' ||
      row.envelope_json !== null ||
      row.envelope_sha256 !== null ||
      row.last_error !== null
    )
      throw new Error('Invalid local outbox.');
    const expected = {
      formatVersion: 1,
      commitId: row.commit_id,
      localSeq: row.local_seq,
      operations: [
        {
          opId: revision.revision_id,
          objectId: revision.object_id,
          parents: parents.get(String(revision.revision_id)),
          revision: payloads.get(String(revision.revision_id)),
        },
      ],
    };
    if (
      canonicalStringify(json(row.payload_json)) !==
      canonicalStringify(expected)
    )
      throw new Error('Outbox/revision mismatch.');
    outbox.add(String(row.commit_id));
  }
  if (outbox.size !== commits.size) throw new Error('Missing pending commit.');
  for (const row of data.sync_inbox) {
    assertUuid(row.commit_id, '4');
    assertDecimal64(row.log_position, true);
    const envelope = json(row.envelope_json);
    assertCommitEnvelope(envelope);
    if (
      envelope.commitId !== row.commit_id ||
      !['received', 'applied', 'quarantined'].includes(String(row.state))
    )
      throw new Error('Invalid inbox.');
  }
}
/** Restore preserves lineage/history/pending payloads but never resumes a device/session. */
export const disableRestoredSync =
  "UPDATE sync_local_state SET mode = 'disabled' WHERE id = 1";
