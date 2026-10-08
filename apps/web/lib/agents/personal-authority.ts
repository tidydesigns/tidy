import "server-only";
import type { PoolClient } from "pg";
import { db } from "@/lib/db";
import { withoutDatabaseScope, inDatabaseScope, scopedDatabaseClient } from "@/lib/database-scope";
import { requireVerifiedUser, UserAccessError } from "@/lib/security/user-authority";
import { AgentError } from "./protocol";

export const agentPersonalLockKey = (userId: string) => `agent-personal:${userId}`;
export async function verifiedAgentUser(
  client: Pick<PoolClient, "query">,
  userId: string,
  lock = false,
) {
  try {
    await requireVerifiedUser(client, userId, lock);
  } catch (error) {
    if (error instanceof UserAccessError)
      throw new AgentError(
        "access_denied",
        "Account access denied. Sign in with a verified email.",
        403,
      );
    throw error;
  }
}
export async function lockAgentUser(client: PoolClient, userId: string) {
  await client.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [
    agentPersonalLockKey(userId),
  ]);
  await verifiedAgentUser(client, userId, true);
}

/** Retain a transaction-level personal gate while a separate transaction commits
 * the durable fence. This works with transaction pooling: no session locks or
 * pooled connection state survives COMMIT. The existing independent pool lets
 * the fence progress when ordinary connections are all occupied by gates. */
export async function withAgentDisconnectLock<T>(userId: string, work: () => Promise<T>) {
  if (scopedDatabaseClient())
    throw new AgentError("scope_denied", "Connection changes require Settings.", 403);
  const gate = await db.connect();
  let released = false;
  try {
    await gate.query("begin");
    await gate.query("set local idle_in_transaction_session_timeout='45s'");
    await gate.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [
      agentPersonalLockKey(userId),
    ]);
    const result = await inDatabaseScope(gate, () => withoutDatabaseScope(work));
    await gate.query("rollback");
    released = true;
    return result.value;
  } finally {
    if (!released) {
      try {
        await gate.query("rollback");
        released = true;
      } catch {
        /* Dropping the connection releases the gate. */
      }
    }
    gate.release(!released);
  }
}
