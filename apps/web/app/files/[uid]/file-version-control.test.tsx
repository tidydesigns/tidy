import { expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { FileVersionControl } from "./file-version-control";

test("file actions remain available before the asynchronous history list arrives", () => {
  const markup = renderToStaticMarkup(
    <FileVersionControl
      fileId="fixture"
      revision={1}
      canEdit={false}
      disabled={false}
      onRestore={async () => {}}
    />,
  );
  const trigger = markup.match(/<button[^>]*aria-label="File actions"[^>]*>/)?.[0];
  expect(trigger).toContain('aria-haspopup="menu"');
  expect(trigger).not.toContain("disabled");
});
