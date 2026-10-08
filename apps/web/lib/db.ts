import { getCloudflareContext } from "@opennextjs/cloudflare";
import { Pool, type PoolClient } from "pg";
import { requestDatabaseClient } from "./request-database-client";
import {
  assertRequestActive,
  requestSignal,
  startRequestPhase,
  waitForSignal,
} from "./request-lifecycle";
import { startOperation } from "./trace-context";
import { tracedDatabaseClient } from "./traced-database-client";
import { independentDatabaseWork, scopedDatabaseClient } from "./database-scope";

const requestPools = new WeakMap<object, Pool>();
const configuredMax = Number(process.env.DATABASE_POOL_MAX ?? 5);
const poolMax = Number.isInteger(configuredMax) && configuredMax > 0 ? configuredMax : 5;
// A scoped tool may need to commit provider credential rotation independently.
// Reserve a separate Node connection so five outer tool transactions cannot
// occupy the whole pool while each waits for a nested renewal connection.
let credentialPool: Pool | undefined;
function nodeCredentialPool() {
  if (!credentialPool) {
    credentialPool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 1,
      idleTimeoutMillis: 1000,
      allowExitOnIdle: true,
      connectionTimeoutMillis: 10_000,
      query_timeout: 10_000,
    });
    credentialPool.on("error", () =>
      console.error(JSON.stringify({ event: "credential_database_pool_error" })),
    );
  }
  return credentialPool;
}
type ConnectCallback = Parameters<Pool["connect"]>[0];

function workerPool() {
  let context: ReturnType<typeof getCloudflareContext>;
  try {
    context = getCloudflareContext();
  } catch {
    // Next.js development and build run outside the deployed Worker.
    return null;
  }

  const hyperdrive = (
    context.env as CloudflareEnv & {
      HYPERDRIVE?: { connectionString: string };
    }
  ).HYPERDRIVE;
  if (!hyperdrive) throw new Error("HYPERDRIVE binding is missing from the Worker.");
  const requestContext = context.ctx;
  if (typeof requestContext !== "object" || requestContext === null) {
    throw new Error("Cloudflare request context is unavailable.");
  }

  let pool = requestPools.get(requestContext);
  if (!pool) {
    pool = new Pool({
      connectionString: hyperdrive.connectionString,
      max: poolMax,
      maxUses: 1,
      connectionTimeoutMillis: 10_000,
      query_timeout: 10_000,
    });
    // Idle connection failures must not become unhandled EventEmitter errors.
    pool.on("error", () => console.error(JSON.stringify({ event: "database_pool_error" })));
    requestPools.set(requestContext, pool);
  }
  return pool;
}

class WorkerAwarePool extends Pool {
  connect(): Promise<PoolClient>;
  connect(callback: ConnectCallback): void;
  connect(callback?: ConnectCallback): Promise<PoolClient> | void {
    assertRequestActive();
    const scoped = scopedDatabaseClient();
    if (scoped) {
      if (callback) {
        queueMicrotask(() => callback(undefined, scoped, scoped.release));
        return;
      }
      return Promise.resolve(scoped);
    }
    const pool = workerPool() ?? (independentDatabaseWork() ? nodeCredentialPool() : null);
    const signal = requestSignal();
    const finish = startRequestPhase("database_connect");
    const operation = startOperation("database.connect");
    // Capture the signal now; pg invokes its callback from a socket context.
    const work = operation.run(
      () =>
        new Promise<PoolClient>((resolve, reject) => {
          const connected: ConnectCallback = (error, client) => {
            finish();
            if (error || !client) {
              reject(error ?? new Error("Database connection unavailable."));
              return;
            }
            if (signal?.aborted) {
              client.release(true);
              reject(signal.reason);
              return;
            }
            try {
              resolve(requestDatabaseClient(tracedDatabaseClient(client), signal));
            } catch (error) {
              reject(error);
            }
          };
          try {
            if (pool) pool.connect(connected);
            else super.connect(connected);
          } catch (error) {
            finish();
            reject(error);
          }
        }),
    );
    const result = (signal ? waitForSignal(work, signal) : work).then(
      (client) => {
        operation.end();
        return client;
      },
      (error) => {
        operation.end(error);
        throw error;
      },
    );
    if (!callback) return result;
    void result.then(
      (client) => callback(undefined, client, client.release),
      (error) => callback(error, undefined, () => {}),
    );
  }
}

const development = globalThis as typeof globalThis & { bellaDevelopmentPool?: WorkerAwarePool };
export const db =
  (process.env.NODE_ENV === "development" ? development.bellaDevelopmentPool : undefined) ??
  new WorkerAwarePool({
    connectionString: process.env.DATABASE_URL,
    max: poolMax,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 10_000,
    query_timeout: 10_000,
  });
if (process.env.NODE_ENV === "development") development.bellaDevelopmentPool = db;
