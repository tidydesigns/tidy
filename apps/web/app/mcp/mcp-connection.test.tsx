import { expect, mock, test } from "bun:test";
import React from "react";
import { renderToReadableStream } from "react-dom/server";
import { DeferredFeatureFlagsProvider } from "@/lib/use-feature-flag";

mock.module("server-only", () => ({}));
const { McpConnection } = await import("./mcp-connection");

test("MCP setup and copy controls render while authorization and flags are pending", async () => {
  let resolveClients!: (clients: { clientId: string; name: string }[]) => void;
  const clients = new Promise<{ clientId: string; name: string }[]>((resolve) => {
    resolveClients = resolve;
  });
  const stream = await renderToReadableStream(
    <DeferredFeatureFlagsProvider flags={new Promise(() => {})}>
      <McpConnection clients={clients} resourceUrl="https://example.test/api/mcp" />
    </DeferredFeatureFlagsProvider>,
  );
  const reader = stream.getReader();
  const first = new TextDecoder().decode((await reader.read()).value);
  expect(first).toContain("Connect your agent");
  expect(first).toContain("Copy command");
  expect(first.replaceAll("<!-- -->", "")).toContain("Loading authorized agents");
  expect(first).not.toContain("data-page-skeleton");
  resolveClients([{ clientId: "test-client", name: "Test agent" }]);
  let rest = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    rest += new TextDecoder().decode(value);
  }
  expect(rest).toContain("Test agent");
  expect(rest).toContain("Revoke access");
});
