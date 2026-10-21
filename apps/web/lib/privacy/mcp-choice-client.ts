import { MCP_NOTICE_VERSION } from "./consent";

async function choice(response: Response) {
  if (!response.ok) throw new Error("Your MCP privacy choice could not be confirmed.");
  const result = await response.json();
  if (
    !result ||
    typeof result !== "object" ||
    !("enabled" in result) ||
    typeof result.enabled !== "boolean"
  )
    throw new Error("Invalid MCP privacy choice.");
  return result as { enabled: boolean; signedIn?: boolean; pending?: boolean };
}
export async function recordMcpChoice(enabled: boolean) {
  return choice(
    await fetch("/api/privacy/mcp-analytics", {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      headers: { "Content-Type": "application/json", "x-tidy-privacy": "1" },
      body: JSON.stringify({ enabled, noticeVersion: MCP_NOTICE_VERSION }),
      signal: AbortSignal.timeout(10_000),
    }),
  );
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
