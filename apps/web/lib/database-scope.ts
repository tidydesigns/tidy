import { AsyncLocalStorage } from "node:async_hooks";
import type { PoolClient } from "pg";

type Scope = {
  client: PoolClient;
  active: boolean;
  next: number;
  afterCommit: Map<string, () => Promise<void>>;
};
// Next route and service bundles can instantiate this module separately. Share
// async context so nested services borrow the enclosing transaction's client.
const scopeKey = Symbol.for("tidy.database.scope");
const independentKey = Symbol.for("tidy.database.independent");
const globals = globalThis as typeof globalThis & {
  [scopeKey]?: AsyncLocalStorage<Scope | undefined>;
  [independentKey]?: AsyncLocalStorage<boolean>;
};
const storage = (globals[scopeKey] ??= new AsyncLocalStorage<Scope | undefined>());

/** Credential rotation must commit independently of a later rejected tool. */
const independent = (globals[independentKey] ??= new AsyncLocalStorage<boolean>());
export const independentDatabaseWork = () => independent.getStore() === true;
export function withoutDatabaseScope<T>(work: () => Promise<T>) {
  if (!storage.getStore()) return work();
  return independent.run(true, () => storage.run(undefined, work));
}

/** Opt-in transaction composition for shared services. Existing callers keep
 * their normal pool semantics; scoped callers borrow a savepoint, never commit
 * or release the enclosing transaction. */
export async function inDatabaseScope<T>(client: PoolClient, work: () => Promise<T>) {
  const scope: Scope = { client, active: true, next: 0, afterCommit: new Map() };
  let value: T;
  try {
    value = await storage.run(scope, work);
  } finally {
    // Promise.all can reject before sibling work settles. Its async descendants
    // must never reuse a connection after rollback/release or a later checkout.
    scope.active = false;
  }
  return {
    value,
    afterCommit: async () => {
      for (const callback of scope.afterCommit.values()) await callback();
    },
  };
}

export function afterDatabaseCommit(key: string, callback: () => Promise<void>) {
  const scope = storage.getStore();
  if (!scope) return false;
  if (!scope.active) throw new Error("Database transaction scope has ended.");
  scope.afterCommit.set(key, callback);
  return true;
}

export function scopedDatabaseClient(): PoolClient | undefined {
  const scope = storage.getStore();
  if (!scope) return;
  if (!scope.active) throw new Error("Database transaction scope has ended.");
  const name = `tidy_scope_${++scope.next}`;
  let begun = false;
  return new Proxy(scope.client, {
    get(target, property) {
      if (property === "release") return () => {};
      if (property === "query")
        return ((...args: unknown[]) => {
          if (!scope.active) throw new Error("Database transaction scope has ended.");
          // Services issue transaction control as plain strings. pg callbacks and
          // query configs retain their original behaviour for all data queries.
          const sql =
            typeof args[0] === "string" ? args[0].trim().replace(/;$/, "").toLowerCase() : "";
          if ((sql === "commit" || sql === "rollback") && !begun)
            throw new Error("No nested transaction is active.");
          if (sql === "begin") {
            begun = true;
            args[0] = `savepoint ${name}`;
          }
          if (sql === "commit" && begun) {
            begun = false;
            args[0] = `release savepoint ${name}`;
          }
          if (sql === "rollback" && begun) {
            begun = false;
            args[0] = `rollback to savepoint ${name}`;
          }
          return Reflect.apply(target.query, target, args);
        }) as PoolClient["query"];
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
