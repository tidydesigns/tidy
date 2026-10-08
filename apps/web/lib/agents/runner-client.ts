import "server-only";
import { createHmac } from "node:crypto";
import { AgentError } from "./protocol";
import { readLimited } from "@/lib/connectors/http";
import { requestSignal, waitForSignal } from "@/lib/request-lifecycle";

export function runnerConfigured() {
  return Boolean(
    process.env.AGENT_RUNNER_URL &&
    process.env.AGENT_RUNNER_SECRET?.length &&
    process.env.AGENT_RUNNER_SECRET.length >= 32,
  );
}
export async function runnerRequest<T>(
  userId: string,
  action: string,
  body: Record<string, unknown> = {},
): Promise<T> {
  if (!runnerConfigured())
    throw new AgentError("runner_unavailable", "Codex connections are not available yet.", 503);
  const base = new URL(process.env.AGENT_RUNNER_URL!);
  if (base.protocol !== "https:" && !["127.0.0.1", "localhost"].includes(base.hostname))
    throw new Error("Runner requires HTTPS.");
  const secret = process.env.AGENT_RUNNER_SECRET!;
  const owner = createHmac("sha256", secret).update(`tidy:runner:owner:${userId}`).digest("hex");
  const parent = requestSignal();
  const signal = AbortSignal.any([AbortSignal.timeout(20_000), ...(parent ? [parent] : [])]);
  let response: Response;
  try {
    response = await waitForSignal(
      fetch(new URL(`/v1/accounts/${owner}/${action}`, base), {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}` },
        body: JSON.stringify(body),
        signal,
        redirect: "error",
      }),
      signal,
    );
  } catch {
    throw new AgentError("runner_unavailable", "Codex is reconnecting. Try again shortly.", 503);
  }
  if (!response.ok) {
    void response.body?.cancel().catch(() => {});
    throw new AgentError(
      "runner_error",
      "Codex could not complete this request. Try again shortly.",
      502,
    );
  }
  try {
    return JSON.parse(await readLimited(response, 1024 * 1024, signal)) as T;
  } catch {
    throw new AgentError(
      "runner_error",
      "Codex did not return a supported response. Try again shortly.",
      502,
    );
  }
}
