import type { PoolClient } from "pg";
import { startOperation } from "./trace-context";

/** Observe pg's promise, callback and Query APIs without recording SQL or values. */
export function tracedDatabaseClient(client: PoolClient): PoolClient {
  return new Proxy(client, {
    get(target, key) {
      const value = Reflect.get(target, key);
      if (key !== "query") return typeof value === "function" ? value.bind(target) : value;
      return (...args: unknown[]) => {
        const operation = startOperation("database.query");
        const callback = args.at(-1);
        if (typeof callback === "function") {
          args[args.length - 1] = function (this: unknown, ...result: unknown[]) {
            operation.end(result[0] ?? undefined);
            return Reflect.apply(callback, this, result);
          };
        }
        try {
          const result = operation.run(() => Reflect.apply(target.query, target, args));
          if (result && typeof result.then === "function") {
            return result.then(
              (value: unknown) => {
                operation.end();
                return value;
              },
              (error: unknown) => {
                operation.end(error);
                throw error;
              },
            );
          }
          if (typeof callback !== "function") {
            result?.once?.("end", () => operation.end());
            result?.once?.("error", (error: unknown) => operation.end(error));
          }
          return result;
        } catch (error) {
          operation.end(error);
          throw error;
        }
      };
    },
  });
}
