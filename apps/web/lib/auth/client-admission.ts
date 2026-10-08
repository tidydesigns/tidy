import { tryGetCurrentAuthEndpointContext } from "@better-auth/core/context";
import type { BetterAuthPlugin } from "better-auth";
import { APIError } from "better-auth/api";
import { db } from "@/lib/db";
import { inDatabaseScope } from "@/lib/database-scope";
import { OAUTH_CLIENT_LIMITS } from "./client-registration-budget";
export { OAUTH_CLIENT_LIMITS } from "./client-registration-budget";

async function clientTransaction<T>(write: () => Promise<T>) {
  const client = await db.connect();
  try {
    await client.query("begin");
    const result = await inDatabaseScope(client, write);
    await client.query("commit");
    await result.afterCommit();
    return result.value;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

async function admitClient<T>(data: unknown, write: () => Promise<T>) {
  if (
    new TextEncoder().encode(JSON.stringify(data)).byteLength > OAUTH_CLIENT_LIMITS.metadataBytes
  ) {
    throw new APIError("BAD_REQUEST", {
      error: "invalid_client_metadata",
      error_description: "Client metadata is too large.",
    });
  }
  return clientTransaction(async () => {
    await db.query("select pg_advisory_xact_lock(hashtextextended('oauth-client-admission',0))");
    const usage = (
      await db.query<{ retained: number; recent: number }>(`select count(*)::int as retained,
      count(*) filter (where "createdAt">now()-interval '1 hour')::int as recent from "oauthClient"`)
    ).rows[0];
    if (
      usage.retained >= OAUTH_CLIENT_LIMITS.retained ||
      usage.recent >= OAUTH_CLIENT_LIMITS.hourly
    ) {
      throw new APIError("TOO_MANY_REQUESTS", {
        error: "temporarily_unavailable",
        error_description:
          "Client registration capacity has been reached. Existing clients can still sign in.",
      });
    }
    return write();
  });
}

/** Bound every runtime OAuth-client insert, including server API calls. Never
 * evict clients automatically: removing a client also removes its user grants. */
export const clientAdmissionPlugin = {
  id: "oauth-client-admission",
  init(context) {
    const adapter = context.adapter;
    const transaction = adapter.transaction.bind(adapter);
    adapter.transaction = (callback) => {
      const path = tryGetCurrentAuthEndpointContext()?.path ?? "";
      if (!/^\/(admin\/)?oauth2\//.test(path)) return transaction(callback);
      // The provider otherwise clones its adapter for transactions, losing init
      // decorators. Use the decorated adapter within one scoped pg transaction,
      // including resource links and any nested admission savepoint.
      return clientTransaction(() => callback(adapter));
    };
    const create = adapter.create;
    Object.defineProperty(adapter, "create", {
      ...Object.getOwnPropertyDescriptor(adapter, "create"),
      value: async (...args: unknown[]) => {
        const input = args[0] as { model?: string; data?: unknown } | undefined;
        const write = () => Reflect.apply(create, adapter, args);
        return input?.model === "oauthClient" ? admitClient(input.data, write) : write();
      },
    });
  },
} satisfies BetterAuthPlugin;
