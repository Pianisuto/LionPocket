import type { LocalSyncDatabase, SqlRow } from '@lionpocket/sync-local';
import type { NitroSQLiteConnection } from 'react-native-nitro-sqlite';
export function mobileSyncDatabase(
  db: NitroSQLiteConnection,
): LocalSyncDatabase {
  return {
    read: async (sql, params) =>
      (await db.executeAsync<SqlRow>(sql, params)).rows._array,
    run: async (workflow) => {
      await db.transaction(async (tx) => {
        let step = workflow.next();
        while (!step.done) {
          const { sql, params } = step.value;
          step = workflow.next(
            (await tx.executeAsync<SqlRow>(sql, params)).rows._array,
          );
        }
      });
    },
  };
}
