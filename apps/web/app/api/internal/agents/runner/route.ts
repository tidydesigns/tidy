import { timingSafeEqual } from "node:crypto";
import { agentsEnabled } from "@/lib/agents/config";
import { agentBody, agentFailure, agentJson } from "@/lib/agents/http";
import { executionRequestSchema } from "@/lib/agents/execution-protocol";
import { claimExecution, executeRequest } from "@/lib/agents/execution";

export async function POST(request: Request) {
  const secret = process.env.AGENT_RUNNER_SECRET;
  const actual = Buffer.from(request.headers.get("authorization") ?? "");
  const expected = Buffer.from(`Bearer ${secret}`);
  if (
    !agentsEnabled() ||
    !secret ||
    secret.length < 32 ||
    actual.length !== expected.length ||
    !timingSafeEqual(actual, expected)
  )
    return agentJson({ error: "Unauthorized." }, 401);
  try {
    const input = executionRequestSchema.parse(await agentBody(request, 4 * 1024 * 1024));
    return agentJson(
      input.action === "claim"
        ? { run: await claimExecution(input.runnerId) }
        : await executeRequest(input),
    );
  } catch (error) {
    return agentFailure(error);
  }
}
