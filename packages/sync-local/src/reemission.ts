import {
  canonicalStringify,
  type RevisionPlaintext,
} from '@lionpocket/sync-protocol';
import { incrementDecimal64, type SqlWorkflow } from './manual';
import { sql } from './transport-state';
/** Archive immutable old envelopes; allocate new operation IDs and keep an explicit lineage record. */
export function* reissueForKeyVersion(
  keyVersion: number,
  uuid: () => string,
): SqlWorkflow {
  const markers = yield sql(
    "SELECT payload_json FROM sync_review WHERE reason='active_key_version'",
  );
  if (
    keyVersion <= 1 ||
    markers.some(
      (m) => JSON.parse(String(m.payload_json)).keyVersion === keyVersion,
    )
  )
    return;
  const [state] = yield sql('SELECT * FROM sync_local_state WHERE id=1');
  let seq = String(state.local_seq);
  const outbox = yield sql(
    "SELECT * FROM sync_outbox WHERE state!='acknowledged' AND (state!='blocked' OR last_error='key_version_mismatch') ORDER BY length(local_seq),local_seq",
  );
  const mapped = new Map<string, string>();
  for (const old of outbox) {
    const pending = JSON.parse(String(old.payload_json)) as {
      operations: {
        opId: string;
        objectId: string;
        parents: string[];
        revision: RevisionPlaintext;
        expectedHeads?: string[];
      }[];
    };
    const accepted = yield sql(
      'SELECT revision_id FROM sync_revision_origin WHERE revision_id=? AND log_position IS NOT NULL',
      [pending.operations[0].opId],
    );
    if (accepted.length) {
      yield sql(
        "UPDATE sync_outbox SET state='blocked',last_error='remote_accepted_before_rotation' WHERE commit_id=?",
        [old.commit_id],
      );
      continue;
    }
    if (pending.operations.some((op) => op.expectedHeads)) {
      yield sql(
        "UPDATE sync_outbox SET state='blocked',last_error='rotation_resolution_review' WHERE commit_id=?",
        [old.commit_id],
      );
      yield sql('INSERT INTO sync_review VALUES(?,?,?,?)', [
        uuid(),
        pending.operations[0].objectId,
        'rotation_resolution_review',
        old.payload_json,
      ]);
      continue;
    }
    const commit = uuid();
    const operations = [];
    for (const op of pending.operations) {
      seq = incrementDecimal64(seq);
      const id = uuid(),
        parents = op.parents.map((p) => mapped.get(p) ?? p).sort(),
        revision = JSON.parse(
          canonicalStringify(op.revision),
        ) as RevisionPlaintext;
      revision.dependencies = revision.dependencies.map((d) => ({
        ...d,
        revisionId: mapped.get(d.revisionId) ?? d.revisionId,
      }));
      yield sql('INSERT INTO sync_revisions VALUES(?,?,?,?,?,?,?,?)', [
        id,
        op.objectId,
        commit,
        seq,
        revision.action,
        revision.authoredAt,
        canonicalStringify(parents),
        canonicalStringify(revision),
      ]);
      const heads = yield sql(
        'SELECT revision_id FROM sync_heads WHERE object_id=? AND revision_id=?',
        [op.objectId, op.opId],
      );
      if (heads.length) {
        yield sql(
          'DELETE FROM sync_heads WHERE object_id=? AND revision_id=?',
          [op.objectId, op.opId],
        );
        yield sql('INSERT INTO sync_heads VALUES(?,?)', [op.objectId, id]);
      }
      yield sql("INSERT OR IGNORE INTO sync_rejected VALUES(?,'key_rotated')", [
        op.opId,
      ]);
      if (revision.action === 'delete') {
        yield sql('DELETE FROM sync_tombstones WHERE revision_id=?', [op.opId]);
        yield sql('INSERT INTO sync_tombstones VALUES(?,?,?)', [
          op.objectId,
          id,
          revision.deletedAt ?? revision.authoredAt,
        ]);
      }
      mapped.set(op.opId, id);
      operations.push({ opId: id, objectId: op.objectId, parents, revision });
      yield sql('INSERT INTO sync_review VALUES(?,?,?,?)', [
        uuid(),
        op.objectId,
        'reemission_provenance',
        canonicalStringify({
          oldRevisionId: op.opId,
          newRevisionId: id,
          oldCommitId: old.commit_id,
          newCommitId: commit,
          keyVersion,
        }),
      ]);
    }
    yield sql(
      "UPDATE sync_outbox SET state='blocked',last_error='key_rotated' WHERE commit_id=?",
      [old.commit_id],
    );
    yield sql(
      "INSERT INTO sync_outbox(commit_id,local_seq,state,payload_json) VALUES(?,?,'pending',?)",
      [
        commit,
        seq,
        canonicalStringify({
          formatVersion: 1,
          commitId: commit,
          localSeq: seq,
          operations,
        }),
      ],
    );
  }
  yield sql('UPDATE sync_local_state SET local_seq=? WHERE id=1', [seq]);
  yield sql('INSERT INTO sync_review VALUES(?,NULL,?,?)', [
    uuid(),
    'active_key_version',
    canonicalStringify({ keyVersion }),
  ]);
}
