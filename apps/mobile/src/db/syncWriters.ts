import { captureFinancial, type SqlRow } from "@lionpocket/sync-local";
import type { Connection, Query } from "./planningRepository";
let uuidProvider: (() => Promise<() => string>) | undefined;
export function setSyncUuidProvider(provider: () => Promise<() => string>) {
  uuidProvider = provider;
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
        "SELECT mode FROM sync_local_state WHERE id=1",
      )
    ).rows._array;
    if (state?.mode !== "financial") return;
    const [control] = (
      await tx.executeAsync<SqlRow>(
        "SELECT applying FROM sync_control WHERE id=1",
      )
    ).rows._array;
    if (
      control.applying ||
      !(await tx.executeAsync("SELECT local_id FROM sync_dirty LIMIT 1")).rows
        ._array.length
    )
      return;
    const uuid = explicitUuid ?? (await uuidProvider?.());
    if (!uuid) throw new Error("Native CSPRNG unavailable.");
    const workflow = captureFinancial(uuid);
    let step = workflow.next();
    while (!step.done) {
      const q = step.value;
      step = workflow.next(
        (await tx.executeAsync<SqlRow>(q.sql, q.params)).rows._array,
      );
    }
  };
  const proxy = new Proxy(db, {
    get(target, key) {
      if (key === "transaction")
        return async <R>(action: (tx: Query) => Promise<R>): Promise<R> =>
          target.transaction(async (tx) => {
            const result = await action(tx);
            await flush(tx);
            return result;
          });
      if (key === "executeAsync")
        return async (sql: string, params?: (string | number | null)[]) => {
          if (!/^\s*(INSERT|UPDATE|DELETE)\b/i.test(sql))
            return target.executeAsync(sql, params);
          return target.transaction(async (tx) => {
            const result = await tx.executeAsync(sql, params);
            await flush(tx);
            return result;
          });
        };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as T;
  wrapped.set(db, proxy);
  wrapped.set(proxy, proxy);
  return proxy;
}
