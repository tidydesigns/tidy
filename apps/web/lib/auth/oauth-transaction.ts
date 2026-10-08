import "server-only";
import type { PoolClient } from "pg";
import { APIError, isAPIError } from "better-auth/api";
import { db } from "@/lib/db";
import { inDatabaseScope } from "@/lib/database-scope";
import { McpGrantError } from "@/lib/mcp/authorizations";
import { assertRequestActive } from "@/lib/request-lifecycle";
import { UserAccessError } from "@/lib/security/user-authority";

export const invalidOAuthGrant = () =>
  new APIError("BAD_REQUEST", {
    error: "invalid_grant",
    error_description: "Authorization has ended. Authorize again to reconnect.",
  });

export function oauthFailure(error: unknown): never {
  if (error instanceof McpGrantError) throw invalidOAuthGrant();
  if (error instanceof UserAccessError) throw new APIError("FORBIDDEN", { message: error.message });
  if (isAPIError(error)) throw error;
  throw new APIError("INTERNAL_SERVER_ERROR", {
    error: "server_error",
    error_description: "Authorization is temporarily unavailable. Try again shortly.",
  });
}

export async function oauthAccountGate(userId: string) {
  await db.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [`mcp-consent:${userId}`]);
}

/** Own a transaction, or borrow a savepoint when composed with provider work.
 * Release before deferred notifications, and project unexpected errors safely. */
export async function oauthTransaction<T>(work: () => Promise<T>) {
  let client: PoolClient | undefined;
  let result: Awaited<ReturnType<typeof inDatabaseScope<T>>>;
  try {
    client = await db.connect();
    await client.query("begin");
    result = await inDatabaseScope(client, work);
    assertRequestActive();
    await client.query("commit");
  } catch (error) {
    try {
      await client?.query("rollback");
    } catch {
      // Cancellation can already have closed the connection.
    }
    oauthFailure(error);
  } finally {
    client?.release();
  }
  await result.afterCommit();
  return result.value;
}
