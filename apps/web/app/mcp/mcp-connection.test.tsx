import { expect, mock, test } from "bun:test";
import React from "react";
import { renderToReadableStream, renderToStaticMarkup } from "react-dom/server";
import { DeferredFeatureFlagsProvider } from "@/lib/use-feature-flag";

mock.module("server-only", () => ({}));
const { McpConnection } = await import("./mcp-connection");
const { McpSkeleton } = await import("@/components/workspace/page-skeletons");

test("cold workspace loading uses the MCP header without assuming setup is needed", () => {
  const html = renderToStaticMarkup(<McpSkeleton />);
  expect(html).toContain(">MCP</h1>");
  expect(html).toContain("Use your coding agents with your Tidy files.");
  expect(html).toContain("data-mcp-connections-skeleton");
  expect(html).not.toContain("Connect your agent");
  expect(html).not.toContain("Copy setup prompt");
});

test("pending authorizations never show the empty setup state before connected agents", async () => {
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
  expect(first).toContain("MCP");
  expect(first).toContain("Loading authorized agents");
  expect(first).toContain("data-mcp-connections-skeleton");
  expect(first).not.toContain("Connect your agent");
  expect(first).not.toContain("Copy setup prompt");
  expect(first).not.toContain("Manual setup");
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
  expect(rest).not.toContain("Copy setup prompt");
});

test("setup is available after the authorization check confirms no connected agents", () => {
  const html = renderToStaticMarkup(
    <McpConnection
      clients={[]}
      resourceUrl="https://example.test/api/mcp"
      organizationId="org-selected"
    />,
  );
  expect(html).toContain("Connect your agent");
  expect(html).toContain("Copy setup prompt");
  expect(html).toContain("Manual setup");
  expect(html).not.toContain("data-mcp-connections-skeleton");
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
  expect(html).not.toContain("data-mcp-connections-skeleton");
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
