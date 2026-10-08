import "server-only";
import { db } from "@/lib/db";
import { inDatabaseScope } from "@/lib/database-scope";
import { assertRequestActive } from "@/lib/request-lifecycle";
import { actionError } from "@/lib/action-error";
import { PublicActionError } from "@/lib/security/public-error";
import { McpGrantError, requireMcpGrant } from "./authorizations";
import type { McpGrant } from "./grant-context";
import { retainMcpTargets } from "./usage";
import type { PoolClient } from "pg";

class RejectedOperation extends Error {
  constructor(readonly result: unknown) {
    super("MCP operation rejected");
  }
}

/** Quota admission commits separately before entering this scope. Product
 * services borrow savepoints; independent credential renewals keep their own
 * commit. A rejected tool cannot publish partial product changes. */
export async function withMcpGrantOperation<T>(
  grant: McpGrant,
  userId: string,
  organizationId: string | void,
  input: Record<string, unknown>,
  work: () => Promise<T>,
): Promise<T> {
  if (!organizationId) throw new McpGrantError();
  let client: PoolClient;
  try {
    client = await db.connect();
  } catch {
    throw new PublicActionError("Could not complete the MCP operation. Try again.");
  }
  let committed: (() => Promise<void>) | undefined;
  let result: T;
  try {
    await client.query("begin");
    // Acquire the same workspace gate as composed product services before
    // retaining membership, identity or parents. Never invert this lock order.
    await client.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [organizationId]);
    await requireMcpGrant(client, grant, userId);
    await retainMcpTargets(client, userId, organizationId, input);
    const scoped = await inDatabaseScope(client, work);
    result = scoped.value;
    if (result && typeof result === "object" && "isError" in result && result.isError === true)
      throw new RejectedOperation(result);
    assertRequestActive();
    // Retained rows prevent revocation racing publication. Clock-based session
    // and token expiry still require a fresh check after external provider I/O.
    await requireMcpGrant(client, grant, userId);
    await client.query("commit");
    committed = scoped.afterCommit;
  } catch (error) {
    try {
      await client.query("rollback");
    } catch {
      /* Cancellation may already have destroyed the socket. */
    }
    if (!(error instanceof RejectedOperation)) {
      if (error instanceof McpGrantError) throw error;
      throw new PublicActionError(
        actionError(error, "Could not complete the MCP operation. Try again."),
      );
    }
    result = error.result as T;
  } finally {
    client.release();
  }
  try {
    await committed?.();
  } catch {
    throw new PublicActionError(
      "The MCP operation completed, but its live update could not be delivered. Read the current state before retrying.",
    );
  }
  return result;
}
