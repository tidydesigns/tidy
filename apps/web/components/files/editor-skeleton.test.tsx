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

for (const placement of ["left", "bottom"] as const) {
  test(`open-by-default loading respects the ${placement} toolbar preference`, () => {
    const markup = renderToStaticMarkup(
      <EditorSkeleton initialPanelsOpen initialToolbarPlacement={placement} />,
    );
    expect(markup).toContain(
      `data-orientation="${placement === "left" ? "vertical" : "horizontal"}"`,
    );
    expect(markup.includes("data-skeleton-docked-tools")).toBe(placement === "left");
    expect(markup).toContain("data-skeleton-file-bar");
    expect(markup).toContain("editor-floating-tools");
  });
}
