// Test-only native adapter. Real SQLite; rejects accidental connection use inside tx.
import { AsyncLocalStorage } from 'node:async_hooks';
import { DatabaseSync } from 'node:sqlite';
import type { NitroSQLiteConnection } from 'react-native-nitro-sqlite';
export function sqliteTestConnection(path = ':memory:') {
  const sqlite = new DatabaseSync(path);
  sqlite.exec('PRAGMA foreign_keys = ON');
  const transactionContext = new AsyncLocalStorage<boolean>();
  let queue = Promise.resolve();
  const executeAsync = async (sql: string, params: (string | number | null)[] = []) => {
    const rows = sqlite.prepare(sql).all(...params);
    const changes = sqlite.prepare('SELECT changes() AS changes').get();
    return { rows: { _array: rows }, rowsAffected: Number(changes?.changes ?? 0) };
  };
  const db = {
    executeAsync: async (sql: string, params?: (string | number | null)[]) => {
      if (transactionContext.getStore())
        throw new Error('Use the transaction handle inside transaction callbacks.');
      await queue;
      return executeAsync(sql, params);
    },
    transaction: <T>(action: (tx: { executeAsync: typeof executeAsync }) => Promise<T>) => {
      const operation = queue.then(async () => {
        sqlite.exec('BEGIN');
        try {
          const result = await transactionContext.run(true, () => action({ executeAsync }));
          sqlite.exec('COMMIT');
          return result;
        } catch (cause) {
          sqlite.exec('ROLLBACK');
          throw cause;
        }
      });
      queue = operation.then(
        () => undefined,
        () => undefined,
      );
      return operation;
    },
  } as unknown as NitroSQLiteConnection;
  return { db, sqlite };
}
