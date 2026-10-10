import { expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { EditorSkeleton } from "./editor-skeleton";

test("file loading uses the saved toolbar placement in its initial server markup", () => {
  const left = renderToStaticMarkup(<EditorSkeleton initialToolbarPlacement="left" />);
  const bottom = renderToStaticMarkup(<EditorSkeleton initialToolbarPlacement="bottom" />);
  expect(left).toContain('data-orientation="vertical"');
  expect(bottom).toContain('data-orientation="horizontal"');
  expect(left).toContain("Loading file");
  expect(bottom).toContain("Loading file");
});

test("open-by-default panels keep loading tools vertical regardless of the minimised placement", () => {
  const markup = renderToStaticMarkup(
    <EditorSkeleton initialPanelsOpen initialToolbarPlacement="bottom" />,
  );
  expect(markup).toContain('data-orientation="vertical"');
  expect(markup).not.toContain('data-orientation="horizontal"');
  expect(markup).not.toContain("data-skeleton-file-bar");
});
