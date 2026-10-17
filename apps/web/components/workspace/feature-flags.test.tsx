import { expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SearchParamsContext } from "next/dist/shared/lib/hooks-client-context.shared-runtime";
import { blankDesignDocument } from "@/lib/design/document";
import { FLAGS_OFF, type FunctionalFlags } from "@/lib/feature-flags";
import { FeatureFlagsProvider } from "@/lib/use-feature-flag";

mock.module("server-only", () => ({}));
const { McpConnection } = await import("@/app/mcp/mcp-connection");
const { EditorReviewControl } = await import("@/app/files/[uid]/editor-review-control");
const { SettingsSkeleton } = await import("./page-skeletons");
const { ConnectorSettings } = await import("@/components/connectors/connector-settings");

const enabled: FunctionalFlags = {
  "mcp-pi-gemini": true,
  "github-connector": true,
  "settings-connectors": true,
};

test("MCP setup and review deep links hide unreleased features in initial markup", () => {
  const mcp = renderToStaticMarkup(
    <McpConnection
      clients={[]}
      resourceUrl="https://app.example/api/mcp"
      organizationId="fixture-org"
    />,
  );
  expect(mcp).toContain("Codex");
  expect(mcp).not.toContain("Gemini");
  expect(mcp).not.toContain("Add Tidy to Pi");
  expect(mcp).not.toContain("Other MCP client");
  // An unresolved preload or a ?review deep link must not mount review UI.
  const reviews = renderToStaticMarkup(
    <EditorReviewControl
      fileId="fixture"
      document={blankDesignDocument()}
      revision={1}
      selectedIds={[]}
      initial={new Promise(() => {})}
      viewerId="fixture-user"
      disabled={false}
      initialReviewId="fixture-review"
    />,
  );
  expect(reviews).toBe("");
});

test("server flags reveal connector and review UI without requiring a browser consent client", () => {
  function render(flags: FunctionalFlags) {
    return renderToStaticMarkup(
      <FeatureFlagsProvider flags={flags}>
        <ConnectorSettings
          organizationId="fixture-org"
          canManage
          selected="github"
          github={{
            configured: true,
            ready: true,
            login: null,
            connections: [],
            installations: [],
            error: null,
            installUrl: "https://github.com/apps/fixture/installations/new",
          }}
          linear={{ configured: true, ready: true, connections: [], error: null }}
        />
        <EditorReviewControl
          fileId="fixture-file"
          document={blankDesignDocument()}
          revision={1}
          selectedIds={[]}
          initial={{ ready: true, reviews: [] }}
          viewerId="fixture-user"
          disabled={false}
        />
      </FeatureFlagsProvider>,
    );
  }
  const all = render(enabled);
  expect(all).toContain("Connect GitHub");
  expect(all).toContain("Connect Linear");
  expect(all).toContain("Pull requests");
  expect(all).toContain("GitHub connection settings");
  const githubOff = render({ ...enabled, "github-connector": false });
  expect(githubOff).toContain("Connect Linear");
  expect(githubOff).not.toContain("GitHub");
  expect(githubOff).not.toContain("Pull requests");
  const connectorsOff = render({ ...enabled, "settings-connectors": false });
  expect(connectorsOff).toContain("Pull requests");
  expect(connectorsOff).not.toContain("GitHub connection settings");
  expect(connectorsOff).not.toContain("Connect Linear");
  expect(render(FLAGS_OFF)).toBe("");
});

test("direct connector and legacy GitHub URLs cannot expose connectors in loading UI", () => {
  for (const query of [
    "tab=connectors&connector=linear",
    "tab=github",
    "tab=connectors&github=ok",
  ]) {
    const html = renderToStaticMarkup(
      <SearchParamsContext.Provider value={new URLSearchParams(query)}>
        <SettingsSkeleton />
      </SearchParamsContext.Provider>,
    );
    expect(html).not.toContain("Connectors");
    expect(html).not.toContain("GitHub");
    expect(html).not.toContain("Linear");
    expect(html).toContain("Profile");
  }
});
