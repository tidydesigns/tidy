import "server-only";
import { auth } from "@/lib/auth";
import { AgentError } from "./protocol";
import { agentsEnabled } from "./config";
import { agentsSchemaReady } from "./store";
import { boundedRequest, RequestBodyError } from "@/lib/http/request-body";
import { UserAccessError } from "@/lib/security/user-authority";
import { PersonalBudgetError } from "@/lib/security/personal-budget";
import { ZodError } from "zod";

export async function agentSession(request: Request) {
  if (!agentsEnabled()) throw new AgentError("not_available", "Agents are not enabled.", 404);
  if (
    !["GET", "HEAD"].includes(request.method) &&
    request.headers.get("origin") !== new URL(process.env.BETTER_AUTH_URL ?? request.url).origin
  )
    throw new AgentError("invalid_origin", "Request origin denied.", 403);
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) throw new AgentError("unauthorized", "Sign in to Tidy to continue.", 401);
  if (!(await agentsSchemaReady()))
    throw new AgentError("not_ready", "Agents are not available yet.", 503);
  return session;
}
export async function agentBody(request: Request, maximumBytes = 128 * 1024): Promise<unknown> {
  if (!request.body) throw new AgentError("invalid_body", "A request body is required.");
  if (!request.headers.get("content-type")?.includes("application/json"))
    throw new AgentError("invalid_body", "Expected JSON.", 415);
  try {
    const bounded = await boundedRequest(request, maximumBytes, 5000);
    try {
      return JSON.parse(await bounded.text());
    } catch {
      throw new AgentError("invalid_body", "Send a valid JSON request.");
    }
  } catch (error) {
    if (error instanceof RequestBodyError)
      throw new AgentError("invalid_body", error.message, error.status);
    throw error;
  }
}

export function agentJson(value: unknown, status = 200) {
  return Response.json(value, { status, headers: { "Cache-Control": "private, no-store" } });
}
export function agentFailure(error: unknown) {
  if (error instanceof UserAccessError)
    return agentJson({ error: error.message, code: "access_denied" }, 403);
  if (error instanceof PersonalBudgetError)
    return agentJson({ error: error.message, code: "account_rate_limit" }, error.status);
  if (error instanceof AgentError)
    return agentJson({ error: error.message, code: error.code }, error.status);
  if (error instanceof ZodError)
    return agentJson(
      { error: "Check the request fields and try again.", code: "invalid_input" },
      400,
    );
  // Neither SQL details nor provider error payloads belong in shared UI or logs.
  return agentJson(
    { error: "Could not complete the request. Try again.", code: "request_failed" },
    500,
  );
}
