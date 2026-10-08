import type { PoolClient } from "pg";
import { AgentError } from "./protocol";

export const AGENT_RUN_LIMITS = {
  messages: 1000,
  messageBytes: 8_000_000,
  operations: 500,
  resultBytes: 1_000_000,
  retainedResultBytes: 16_000_000,
} as const;

/** All message writers serialize on the run, including user steering and streamed replacements. */
export async function admitAgentMessage(
  client: PoolClient,
  runId: string,
  content: string,
  replacingId?: string,
) {
  const run = await client.query('select "id" from "agentRun" where "id"=$1 for update', [runId]);
  if (!run.rowCount) throw new AgentError("not_found", "Run no longer exists.", 404);
  const usage = (
    await client.query<{ count: number; bytes: string }>(
      `select count(*)::int as count,
    coalesce(sum(octet_length("content")),0)::text as bytes from "agentMessage"
    where "runId"=$1 and ($2::uuid is null or "id"<>$2)`,
      [runId, replacingId ?? null],
    )
  ).rows[0];
  if (
    usage.count >= AGENT_RUN_LIMITS.messages ||
    Number(usage.bytes) + Buffer.byteLength(content, "utf8") > AGENT_RUN_LIMITS.messageBytes
  ) {
    throw new AgentError(
      "history_limit",
      "This run has reached its message history limit. Stop it before starting another run.",
      409,
    );
  }
}

/** Caller holds the run lock. Check before invoking tools; retries bypass admission. */
export async function admitAgentOperation(client: PoolClient, runId: string) {
  const count = (
    await client.query<{ count: number }>(
      'select count(*)::int as count from "agentToolOperation" where "runId"=$1',
      [runId],
    )
  ).rows[0].count;
  if (count >= AGENT_RUN_LIMITS.operations)
    throw new AgentError(
      "history_limit",
      "This run has reached its tool operation limit. Stop it before starting another run.",
      409,
    );
}

/** Measure the actual JSONB text representation and reject before commit. The
 * surrounding tool transaction rolls back product writes and its receipt. */
export async function admitAgentResult(client: PoolClient, runId: string, serialized: string) {
  const usage = (
    await client.query<{ incoming: number; stored: string }>(
      `select octet_length($2::jsonb::text) as incoming,
    coalesce(sum(octet_length("result"::text)),0)::text as stored from "agentToolOperation" where "runId"=$1`,
      [runId, serialized],
    )
  ).rows[0];
  if (
    usage.incoming > AGENT_RUN_LIMITS.resultBytes ||
    Number(usage.stored) + usage.incoming > AGENT_RUN_LIMITS.retainedResultBytes
  ) {
    throw new AgentError(
      "history_limit",
      "This tool result exceeds the run's history limit. Request a smaller result or stop this run.",
      409,
    );
  }
}
