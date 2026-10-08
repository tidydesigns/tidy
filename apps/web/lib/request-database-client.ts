import type { PoolClient } from "pg";
import { requestSignal, startRequestPhase, waitForSignal } from "./request-lifecycle";

/** Destroy checked-out sockets when their invocation ends; never reuse them. */
export function requestDatabaseClient(client: PoolClient, signal = requestSignal()) {
  if (!signal) return client;
  let released = false;
  const release = (error?: Error | boolean) => {
    if (released) return;
    released = true;
    signal.removeEventListener("abort", canceled);
    client.release(error);
  };
  const canceled = () => release(true);
  signal.addEventListener("abort", canceled, { once: true });
  if (signal.aborted) {
    canceled();
    signal.throwIfAborted();
  }
  return new Proxy(client, {
    get(target, key) {
      if (key === "release") return release;
      if (key !== "query") return Reflect.get(target, key);
      return (...args: unknown[]) => {
        signal.throwIfAborted();
        if (released) throw new Error("Database client has been released.");
        const finish = startRequestPhase("database_query");
        const callback = args.at(-1);
        let complete = false;
        let cancelQuery = () => {};
        if (typeof callback === "function") {
          const done = (...values: unknown[]) => {
            if (complete) return;
            complete = true;
            signal.removeEventListener("abort", cancelQuery);
            finish();
            Reflect.apply(callback, undefined, values);
          };
          cancelQuery = () =>
            done(signal.reason ?? new DOMException("Request canceled", "AbortError"));
          signal.addEventListener("abort", cancelQuery, { once: true });
          args[args.length - 1] = done;
        }
        try {
          const result = Reflect.apply(target.query, target, args);
          if (result && typeof result.then === "function")
            return waitForSignal(result, signal).then(
              (value: unknown) => {
                finish();
                return value;
              },
              (error: unknown) => {
                finish();
                throw error;
              },
            );
          if (typeof callback !== "function") {
            result?.once?.("end", finish);
            result?.once?.("error", finish);
          }
          return result;
        } catch (error) {
          signal.removeEventListener("abort", cancelQuery);
          finish();
          throw error;
        }
      };
    },
  });
}
