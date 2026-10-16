import type { McpServer, ServerContext } from "@modelcontextprotocol/server";

// Exact aliases only: never emit arbitrary client names, titles or vendor strings.
const clientNames = new Map([
  ["codex", "codex"],
  ["codex-mcp-client", "codex"],
  ["codex_cli_rs", "codex"],
  ["claude-code", "claude_code"],
  ["claude code", "claude_code"],
  ["claude_code", "claude_code"],
  ["opencode", "opencode"],
  ["pi", "pi"],
  ["gemini-cli", "gemini_cli"],
  ["gemini cli", "gemini_cli"],
  ["gemini_cli", "gemini_cli"],
]);

export type McpClientDiagnostics = { name: string; version?: string };

export function normalizeMcpClient(value: unknown): McpClientDiagnostics {
  if (!value || typeof value !== "object") return { name: "unknown" };
  const { name, version } = value as { name?: unknown; version?: unknown };
  if (typeof name !== "string" || !name.trim()) return { name: "unknown" };
  const client = name.length <= 80 ? clientNames.get(name.trim().toLowerCase()) : undefined;
  if (!client) return { name: name === "unknown" ? "unknown" : "other" };

  // Public numeric releases and a small set of release channels are sufficient
  // for compatibility debugging. Reject paths, hashes, custom builds and free text.
  const release =
    typeof version === "string" && version.length <= 40 && version.trim() === version
      ? /^v?(\d{1,6}(?:\.\d{1,6}){0,2}(?:-(?:alpha|beta|rc|canary|dev|preview|nightly)(?:[.-]\d{1,8})?)?)$/i.exec(
          version,
        )?.[1]
      : undefined;
  return { name: client, ...(release ? { version: release.toLowerCase() } : {}) };
}

export function mcpClientDiagnostics(
  server: McpServer,
  context: ServerContext | undefined,
): McpClientDiagnostics {
  try {
    // The installed SDK exposes the envelope at runtime but types it as {}.
    const envelope = context?.mcpReq?.envelope as Record<string, unknown> | undefined;
    // Prefer the current request; never combine one client's name with another
    // source's version. The legacy accessor is only useful on initialized servers.
    const client = envelope?.["io.modelcontextprotocol/clientInfo"];
    return normalizeMcpClient(client ?? server.server.getClientVersion());
  } catch {
    // Diagnostics must not change tool availability or expose accessor errors.
    return { name: "unknown" };
  }
}
