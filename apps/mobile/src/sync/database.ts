import type { LocalSyncDatabase, SqlRow } from '@lionpocket/sync-local';
import type { NitroSQLiteConnection } from 'react-native-nitro-sqlite';
const adapters = new WeakMap<object, LocalSyncDatabase>();
export function mobileSyncDatabase(
  db: NitroSQLiteConnection,
): LocalSyncDatabase {
  const known = adapters.get(db);
  if (known) return known;
  const adapter: LocalSyncDatabase = {
    read: async (sql, params) =>
      (await db.executeAsync<SqlRow>(sql, params)).rows._array,
    run: async (workflow) => {
      await db.transaction(async (tx) => {
        let step = workflow.next();
        while (!step.done) {
          const { sql, params } = step.value;
          let rows: SqlRow[];
          try { rows = (await tx.executeAsync<SqlRow>(sql, params)).rows._array; }
          catch (error) { step = workflow.throw(error); continue; }
          step = workflow.next(rows);
        }
      });
    },
  };
  adapters.set(db, adapter);
  return adapter;
}
