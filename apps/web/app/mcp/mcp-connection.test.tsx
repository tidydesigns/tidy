import { expect, mock, test } from "bun:test";
import React from "react";
import { renderToReadableStream, renderToStaticMarkup } from "react-dom/server";
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
      <McpConnection
        clients={clients}
        resourceUrl="https://example.test/api/mcp"
        organizationId="org-selected"
      />
    </DeferredFeatureFlagsProvider>,
  );
  const reader = stream.getReader();
  const first = new TextDecoder().decode((await reader.read()).value);
  expect(first).toContain("Connect your agent");
  expect(first).toContain("Copy setup prompt");
  expect(first).toContain("Manual setup");
  expect(first).not.toContain("Loading authorized agents");
  expect(first).not.toContain("Check server access");
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

test("authorized agents replace the setup hero and retain separate grants with the same name", () => {
  const html = renderToStaticMarkup(
    <McpConnection
      clients={[
        { clientId: "codex-1", name: "Codex" },
        { clientId: "codex-2", name: "Codex" },
      ]}
      resourceUrl="https://example.test/api/mcp"
      organizationId="org-selected"
    />,
  );
  expect(html).toContain("Your agents");
  expect(html.match(/>Codex<\/p>/g)).toHaveLength(2);
  expect(html.match(/>Authorized<\/span>/g)).toHaveLength(2);
  expect(html).toContain("Connect another agent");
  expect(html).not.toContain("Copy setup prompt");
  expect(html).not.toContain("Bring your agent");
  expect(html).not.toContain("Waiting for sign-in");
  expect(html).not.toContain("Check server access");
  expect(html).not.toContain("Verified");
  expect(html).toContain("Revoke Codex access?");
});
