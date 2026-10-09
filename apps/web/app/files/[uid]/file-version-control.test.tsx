import { expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { FileVersionControl } from "./file-version-control";

test("history has a stable header control before its asynchronous list arrives", () => {
  const markup = renderToStaticMarkup(
    <FileVersionControl
      fileId="fixture"
      revision={1}
      canEdit={false}
      disabled={false}
      onRestore={async () => {}}
    />,
  );
  expect(markup).toMatch(/<button[^>]*aria-label="Version history"/);
  expect(markup).toContain("History</button>");
});
