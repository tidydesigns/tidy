import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ConnectionStatus } from "@/lib/github/connection-contract";
import { GitHubSettings } from "./connection-settings";

test("GitHub settings render nullable installation accounts without crashing", () => {
  const initial: ConnectionStatus = {
    configured: true,
    ready: true,
    login: "alice",
    connections: [],
    installations: [
      { id: 1, app_id: 12345, account: null, suspended_at: null },
      { id: 2, app_id: 12345, account: {}, suspended_at: null },
      { id: 3, app_id: 12345, account: { login: "tidydesigns" }, suspended_at: null },
    ],
    error: null,
    installUrl: "https://github.com/apps/tidy/installations/new",
  };
  const html = renderToStaticMarkup(
    createElement(GitHubSettings, { organizationId: "org", canManage: true, initial }),
  );
  expect(html).toContain("Unknown GitHub account");
  expect(html).toContain("tidydesigns");
});
