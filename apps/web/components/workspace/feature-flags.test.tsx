import { expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SearchParamsContext } from "next/dist/shared/lib/hooks-client-context.shared-runtime";
import { blankDesignDocument } from "@/lib/design/document";

mock.module("server-only", () => ({}));
const { McpConnection } = await import("@/app/mcp/mcp-connection");
const { EditorReviewControl } = await import("@/app/files/[uid]/editor-review-control");
const { SettingsSkeleton } = await import("./page-skeletons");

test("MCP setup and review deep links hide unreleased features in initial markup", () => {
  const mcp = renderToStaticMarkup(
    <McpConnection clients={[]} resourceUrl="https://app.example/api/mcp" />,
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
