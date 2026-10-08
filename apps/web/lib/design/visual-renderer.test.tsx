import { expect, test, mock } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TidyDesign } from "@tidy/design-renderer/design";

mock.module("server-only", () => ({}));
const { composeComponent, componentTreeSchema } = await import("./compose-component");
const { buttonExample } = await import("../mcp/design-tools");

test("pinned preview states use shared paint rules and leave ordinary interactions unchanged", () => {
  const document = composeComponent(componentTreeSchema.parse(buttonExample)).document;
  const render = (state?: "default" | "hover" | "pressed" | "focus" | "disabled") =>
    renderToStaticMarkup(
      createElement(TidyDesign, { document, rootId: "new-thread", assets: {}, state }),
    );
  expect(render()).toContain("background:#282a28");
  expect(render("default")).toBe(render());
  expect(render("hover")).toContain("background:#324c3e");
  expect(render("pressed")).toContain("background:#293e33");
  expect(render("focus")).toContain("outline:2px solid #90b7a1");
  expect(render("disabled")).toContain("disabled");
});

test("read-only review omits destinations before T3's document-level link bridge sees them", () => {
  const document = composeComponent(componentTreeSchema.parse(buttonExample)).document;
  document.nodes[0].semantics = { element: "a", href: "https://example.test/checkout" };
  const props = { document, rootId: "new-thread", assets: {} };
  expect(renderToStaticMarkup(createElement(TidyDesign, props))).toContain(
    'href="https://example.test/checkout"',
  );
  expect(
    renderToStaticMarkup(createElement(TidyDesign, { ...props, readOnly: true })),
  ).not.toContain("href=");
  document.nodes[0].semantics = { element: "button", buttonType: "submit" };
  expect(renderToStaticMarkup(createElement(TidyDesign, props))).toContain('type="submit"');
  expect(renderToStaticMarkup(createElement(TidyDesign, { ...props, readOnly: true }))).toContain(
    'type="button"',
  );
});
