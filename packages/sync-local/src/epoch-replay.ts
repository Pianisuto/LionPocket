import { canonicalStringify, type CommitEnvelope } from '@lionpocket/sync-protocol';
import { financialTableTypes, syncTables, syncColumns } from './schema';
import { applyCommit, sql, type DecodedOperation, type ProjectionDialect } from './transport-state';
import type { SqlRow, SqlWorkflow } from './manual';

export interface BaselineOperation extends DecodedOperation { commitId: string; isHead: boolean }

/** Disposable TEMP schema shadows ordinary tables on this connection. Main financial tables,
 * bindings and outbox are never replay targets. Rollback drops all TEMP state, including on error.
 * Runs the existing applyCommit/projectObject, without signing, encryption or new secrets. */
export function* verifyBaselineReplay(args: (string | number | null)[], operationsA: BaselineOperation[],
  operationsB: BaselineOperation[], mapping: ReadonlyMap<string, string>): SqlWorkflow {
  const tables = [...syncTables, ...Object.keys(financialTableTypes)];
  const schemas = yield sql(`SELECT name,sql FROM main.sqlite_master WHERE type='table' AND name IN (${tables.map(() => '?').join(',')})`, tables);
  if (schemas.length !== tables.length) throw new Error('replay_schema_unavailable');
  const dialect: ProjectionDialect = (yield sql('PRAGMA main.table_info(transactions)')).some(r => r.name === 'planned_cents') ? 'desktop' : 'android';
  const inverse = new Map([...mapping].map(([a, b]) => [b, a]));
  const normalize = (id: string, b: boolean) => b ? inverse.get(id) ?? id : id;
  const observations: string[] = [];
  for (const [pass, operations] of [operationsA, operationsB].entries()) {
    yield sql('SAVEPOINT epoch_replay');
    try {
      for (const table of tables) {
        if ((yield sql('SELECT name FROM sqlite_temp_master WHERE name=?', [table])).length) throw new Error('replay_temp_collision');
        const schema = schemas.find(r => r.name === table)!;
        yield sql(String(schema.sql).replace(/^CREATE TABLE/i, 'CREATE TEMP TABLE'));
      }
      for (const table of ['sync_identity', 'sync_slots', 'sync_series', 'sync_import_provenance', 'sync_aliases', 'sync_local_state', 'sync_control']) {
        const columns = syncColumns[table].join(',');
        yield sql(`INSERT INTO temp.${table} SELECT ${columns} FROM main.recovery_archive_${table} WHERE vault_id_scope=? AND epoch_scope=?`, args);
      }
      yield sql('UPDATE sync_control SET applying=1');
      // A's unresolved branches must not gain local automerge permission in the oracle.
      // B intentionally uses one anchor device, exercising the restore-head guard.
      const anchorDevice = String((yield sql('SELECT device_id FROM sync_local_state WHERE id=1'))[0].device_id);
      const external = anchorDevice === 'ffffffff-ffff-4fff-bfff-ffffffffffff'
        ? 'eeeeeeee-eeee-4eee-beee-eeeeeeeeeeee' : 'ffffffff-ffff-4fff-bfff-ffffffffffff';
      let counter = 0;
      const uuid = () => `ffffffff-ffff-4fff-afff-${(++counter).toString(16).padStart(12, '0')}`;
      const deviceId = pass ? anchorDevice : external;
      // One commit per planned revision, through the normal importer. Both evaluations share
      // a fixed projection clock; this clock never selects a revision or orders an edge.
      for (const [index, op] of operations.entries()) {
        const envelope = { commitId: op.commitId, deviceId, deviceSeq: String(index + 1) } as CommitEnvelope;
        yield* applyCommit(envelope, String(index + 1), '1', [op], dialect, uuid, '1970-01-01T00:00:00.000Z');
      }
      const sort = (rows: unknown[]) => rows.map(r => canonicalStringify(r)).sort();
      const financialProjection: Record<string, string[]> = {};
      for (const table of Object.keys(financialTableTypes)) financialProjection[table] = sort(yield sql(`SELECT * FROM temp.${table}`));
      const objectHeads = sort((yield sql('SELECT * FROM sync_heads')).map(r => ({ objectId: r.object_id, revisionId: normalize(String(r.revision_id), !!pass) })));
      const conflicts = sort((yield sql('SELECT * FROM sync_conflicts WHERE resolution_id IS NULL')).map(r => ({
        objectId: r.object_id, heads: (JSON.parse(String(r.heads_json)) as string[]).map(id => normalize(id, !!pass)).sort(),
        base: r.base_revision_id === null ? null : normalize(String(r.base_revision_id), !!pass),
      })));
      const tombstones = sort((yield sql('SELECT * FROM sync_tombstones')).map(r => ({ ...r, revision_id: normalize(String(r.revision_id), !!pass) })));
      const expectedHeads = sort(operations.filter(o => o.isHead).map(o => ({ objectId: o.objectId, revisionId: normalize(o.opId, !!pass) })));
      if (canonicalStringify(objectHeads) !== canonicalStringify(expectedHeads)) throw new Error('replay_heads_changed');
      const sidecars: Record<string, SqlRow[]> = {};
      for (const table of ['sync_identity', 'sync_slots', 'sync_series', 'sync_import_provenance', 'sync_aliases'])
        sidecars[table] = yield sql(`SELECT * FROM temp.${table} ORDER BY ${syncColumns[table].join(',')}`);
      const dependencyGraph = sort(operations.map(o => ({ revisionId: normalize(o.opId, !!pass), objectId: o.objectId,
        parents: o.parents.map(id => normalize(id, !!pass)).sort(),
        dependencies: o.revision.dependencies.map(d => ({ ...d, revisionId: normalize(d.revisionId, !!pass) })),
      })));
      observations.push(canonicalStringify({ financialProjection, objectHeads, conflicts, tombstones, sidecars, dependencyGraph }));
    } finally {
      yield sql('ROLLBACK TO epoch_replay');
      yield sql('RELEASE epoch_replay');
    }
  }
  if (observations[0] !== observations[1]) throw new Error('semantic_replay_mismatch');
}
