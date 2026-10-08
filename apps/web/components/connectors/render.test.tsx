import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ConnectorSettings } from "./connector-settings";
import { LinearSettings } from "./linear-settings";

test("one connector catalog offers GitHub and Linear without setup internals or save buttons", () => {
  const html = renderToStaticMarkup(
    <ConnectorSettings
      organizationId="org"
      canManage
      selected="linear"
      github={{
        ready: true,
        configured: true,
        login: null,
        connections: [],
        installations: [],
        error: null,
        installUrl: "https://github.com/apps/test/installations/new",
      }}
      linear={{ ready: true, configured: true, connections: [], error: null }}
    />,
  );
  expect(html).toContain("Connect GitHub");
  expect(html).toContain("Connect Linear");
  expect(html).toContain('action="/api/linear/connect"');
  expect(html).not.toContain("<select");
  expect(html).not.toContain(">Save<");
  expect(html).not.toContain("client_secret");
});
test("multiple workspaces can be managed independently and missing setup fails gracefully", () => {
  const html = renderToStaticMarkup(
    <LinearSettings
      organizationId="org"
      initial={{
        configured: true,
        ready: true,
        error: null,
        connections: [
          {
            id: "one",
            accountId: "a",
            provider: "linear",
            workspaceName: "Design",
            accountName: "Alice",
            state: "connected",
          },
          {
            id: "two",
            accountId: "b",
            provider: "linear",
            workspaceName: "Engineering",
            accountName: "Alice",
            state: "reconnect",
          },
        ],
      }}
    />,
  );
  expect(html).toContain("Design");
  expect(html).toContain("Engineering");
  expect(html).toContain("Add Linear workspace");
  expect(html).toContain("Reconnect to restore access");
  expect(html.match(/>Disconnect</g)).toHaveLength(2);
  const missing = renderToStaticMarkup(
    <LinearSettings
      organizationId="org"
      initial={{ configured: false, ready: false, error: null, connections: [] }}
    />,
  );
  expect(missing).toContain("Linear is not available yet");
  expect(missing).not.toContain("/api/linear/connect");
});
