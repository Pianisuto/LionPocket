import { captureFinancial, type SqlRow } from '@lionpocket/sync-local';
import type { Connection, Query } from './planningRepository';
let uuidProvider: (() => Promise<() => string>) | undefined;
export function setSyncUuidProvider(provider: () => Promise<() => string>) {
  uuidProvider = provider;
}
const listeners = new WeakMap<object, Set<() => void>>();
export function onLocalSyncWrite(db: object, listener: () => void): () => void {
  let set = listeners.get(db);
  if (!set) {
    set = new Set();
    listeners.set(db, set);
  }
  set.add(listener);
  return () => set.delete(listener);
}
function committed(db: object) {
  for (const listener of listeners.get(db) ?? []) {
    try {
      listener();
    } catch {
      /* Scheduling cannot change a successful SQLite commit. */
    }
  }
}
const wrapped = new WeakMap<object, Connection>();
/** Execute on the native transaction handle. Reads and cache materialization use the same queue. */
export function captureConnection<T extends Connection>(
  db: T,
  explicitUuid?: () => string,
): T {
  const known = wrapped.get(db);
  if (known) return known as T;
  const flush = async (tx: Query) => {
    if (
      !(
        await tx.executeAsync(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='sync_local_state'",
        )
      ).rows._array.length
    )
      return;
    const [state] = (
      await tx.executeAsync<SqlRow>(
        'SELECT mode FROM sync_local_state WHERE id=1',
      )
    ).rows._array;
    if (state?.mode !== 'financial') return;
    const [control] = (
      await tx.executeAsync<SqlRow>(
        'SELECT applying FROM sync_control WHERE id=1',
      )
    ).rows._array;
    if (
      control.applying ||
      !(await tx.executeAsync('SELECT local_id FROM sync_dirty LIMIT 1')).rows
        ._array.length
    )
      return;
    const uuid = explicitUuid ?? (await uuidProvider?.());
    if (!uuid) throw new Error('Native CSPRNG unavailable.');
    const before = (
      await tx.executeAsync<SqlRow>(
        'SELECT local_seq FROM sync_local_state WHERE id=1',
      )
    ).rows._array[0].local_seq;
    const workflow = captureFinancial(uuid);
    let step = workflow.next();
    while (!step.done) {
      const q = step.value;
      step = workflow.next(
        (await tx.executeAsync<SqlRow>(q.sql, q.params)).rows._array,
      );
    }
    return (
      before !==
      (
        await tx.executeAsync<SqlRow>(
          'SELECT local_seq FROM sync_local_state WHERE id=1',
        )
      ).rows._array[0].local_seq
    );
  };
  const transaction = async <R>(
    action: (tx: Query) => Promise<R>,
  ): Promise<R> => {
    let changed = false;
    const result = await db.transaction(async (tx) => {
      const result = await action(tx);
      changed = !!(await flush(tx));
      return result;
    });
    if (changed) committed(db); // Native transaction has resolved: COMMIT succeeded.
    return result;
  };
  const proxy = new Proxy(db, {
    get(target, key) {
      if (key === 'transaction') return transaction;
      if (key === 'executeAsync')
        return async (sql: string, params?: (string | number | null)[]) => {
          if (!/^\s*(INSERT|UPDATE|DELETE)\b/i.test(sql))
            return target.executeAsync(sql, params);
          return transaction((tx) => tx.executeAsync(sql, params));
        };
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as T;
  wrapped.set(db, proxy);
  wrapped.set(proxy, proxy);
  return proxy;
}
