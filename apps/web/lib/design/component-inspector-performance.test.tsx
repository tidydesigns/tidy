import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ComponentPropertiesInspector } from "../../../../packages/editor/src/editor/component-properties-inspector";
import { componentPerformanceDocument } from "./examples/performance";

test("component property targets collect the hierarchy once per render", () => {
  const source = componentPerformanceDocument(1000);
  let parentReads = 0;
  const document = {
    ...source,
    nodes: source.nodes.map((node) => ({
      ...node,
      get parentId() {
        parentReads++;
        return node.parentId;
      },
    })),
  };
  const node = document.nodes.find((node) => node.id === "frame-0");
  if (!node) throw new Error("Missing component master");
  const markup = renderToStaticMarkup(
    createElement(ComponentPropertiesInspector, {
      node,
      document,
      onDocument: () => {},
    }),
  );
  expect(markup).toContain("Property layer");
  expect(markup).toContain("Caption");
  expect(parentReads).toBeLessThan(document.nodes.length * 10);
});
