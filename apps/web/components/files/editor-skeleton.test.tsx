import { expect, test } from "bun:test";
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

test("open-by-default loading includes compact mobile chrome and docked desktop tools", () => {
  const markup = renderToStaticMarkup(
    <EditorSkeleton initialPanelsOpen initialToolbarPlacement="bottom" />,
  );
  expect(markup).toContain('data-orientation="vertical"');
  expect(markup).toContain("data-skeleton-docked-tools");
  expect(markup).toContain("hidden shrink-0 md:flex");
  expect(markup).toContain("data-skeleton-file-bar");
  expect(markup).toContain("editor-floating-tools");
});
