import { expect, test } from "bun:test";
import type { McpServer, ServerContext } from "@modelcontextprotocol/server";
import { mcpClientDiagnostics, normalizeMcpClient } from "./client-diagnostics";

test.each([
  ["codex", "codex"],
  ["codex-mcp-client", "codex"],
  ["codex_cli_rs", "codex"],
  [" Claude Code ", "claude_code"],
  ["claude-code", "claude_code"],
  ["OpenCode", "opencode"],
  ["pi", "pi"],
  ["gemini-cli", "gemini_cli"],
])("normalizes %s to a fixed product label", (name, expected) => {
  const client = normalizeMcpClient({ name, version: "v1.2.3-RC.4", title: "PRIVATE TITLE" });
  expect(client).toEqual({ name: expected, version: "1.2.3-rc.4" });
  expect(normalizeMcpClient(client)).toEqual(client);
});

test("missing and custom clients discard identity strings and versions", () => {
  for (const value of [undefined, null, [], {}, "codex", { name: " " }, { name: 123 }]) {
    expect(normalizeMcpClient(value)).toEqual({ name: "unknown" });
  }
  for (const name of [
    "Sean's codex",
    "codex@private.example",
    "x".repeat(1000),
    "constructor",
    "claude",
    "other",
  ]) {
    expect(normalizeMcpClient({ name, version: "1.2.3" })).toEqual({ name: "other" });
  }
});

test("only bounded release formats survive, with no arbitrary build metadata", () => {
  for (const version of ["1", "1.2", "1.2.3", "1.2.3-beta.4", "1.2.3-nightly.20261016"]) {
    expect(normalizeMcpClient({ name: "codex", version })).toEqual({ name: "codex", version });
  }
  for (const version of [
    undefined,
    123,
    "1.2.3+sean",
    "1.2.3-sean",
    "/Users/sean/build",
    "1.2.3\n",
    "1.2.3-rc.123456789",
    "1234567.2.3",
    "1.2.3.4",
    "x".repeat(1000),
  ]) {
    expect(normalizeMcpClient({ name: "codex", version })).toEqual({ name: "codex" });
  }
});

test("request identity wins as a whole over legacy connection identity", () => {
  const server = {
    server: { getClientVersion: () => ({ name: "codex", version: "1.2.3" }) },
  } as McpServer;
  const context = {
    mcpReq: { envelope: { "io.modelcontextprotocol/clientInfo": { name: "opencode" } } },
  } as unknown as ServerContext;
  expect(mcpClientDiagnostics(server, context)).toEqual({ name: "opencode" });
  expect(mcpClientDiagnostics(server, undefined)).toEqual({ name: "codex", version: "1.2.3" });
  expect(mcpClientDiagnostics({} as McpServer, undefined)).toEqual({ name: "unknown" });
});
