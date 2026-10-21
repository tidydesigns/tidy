import { MCP_NOTICE_VERSION } from "./consent";
import { z } from "zod";
import { readJsonResponse } from "@/lib/http/json-response";

async function choice(response: Response) {
  return readJsonResponse({
    response,
    schema: z.object({
      enabled: z.boolean(),
      signedIn: z.boolean().optional(),
      pending: z.boolean().optional(),
    }),
    message: "Your MCP privacy choice could not be confirmed.",
  });
}
let writes: Promise<unknown> = Promise.resolve();
export function recordMcpChoice(enabled: boolean) {
  // Preserve click order without blocking controls or racing intent cookies.
  const task = writes
    .catch(() => {})
    .then(async () =>
      choice(
        await fetch("/api/privacy/mcp-analytics", {
          method: "POST",
          credentials: "same-origin",
          cache: "no-store",
          keepalive: true,
          headers: { "Content-Type": "application/json", "x-tidy-privacy": "1" },
          body: JSON.stringify({ enabled, noticeVersion: MCP_NOTICE_VERSION }),
          signal: AbortSignal.timeout(10_000),
        }),
      ),
    );
  writes = task;
  return task;
}
export async function loadMcpChoice() {
  const current = await choice(
    await fetch("/api/privacy/mcp-analytics", {
      credentials: "same-origin",
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    }),
  );
  if (!current.signedIn || !current.pending) return current;
  return choice(
    await fetch("/api/privacy/mcp-analytics", {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      headers: { "Content-Type": "application/json", "x-tidy-privacy": "1" },
      body: JSON.stringify({ applyPending: true }),
      signal: AbortSignal.timeout(10_000),
    }),
  );
}
