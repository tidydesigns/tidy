import { test, expect } from "bun:test";
import { blankDesignDocument, buildDrawnNode, parseDesignDocument } from "./document";
import { nodeStyle } from "./node-style";
import { applyDocumentPatch, diffDocument, invertPatch } from "./document-patch";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ThumbnailRenderer } from "@/app/files/thumbnail-renderer";
import { DesignSnapshot } from "@/components/github/design-snapshot";

test("grid tracks and child spans survive validation, patches, and one-step undo", () => {
  const parent = {
    ...buildDrawnNode("grid", "container", null, { x: 0, y: 0, width: 400, height: 300 }),
    layout: "grid",
    gridColumns: 2,
    gridColumnTracks: [
      { unit: "px", value: 100 },
      { unit: "fr", value: 2 },
    ],
    gridRowTracks: [{ unit: "px", value: 80 }, { unit: "auto" }],
  };
  const child = {
    ...buildDrawnNode("child", "container", "grid", { x: 0, y: 0, width: 100, height: 80 }),
    gridColumnSpan: 2,
    gridRowSpan: 2,
    widthMode: "fill",
  };
  const document = parseDesignDocument({ ...blankDesignDocument(), nodes: [parent, child] });
  const parentStyle = nodeStyle(document.nodes[0], "absolute", {});
  const childStyle = nodeStyle(document.nodes[1], "grid", {}, document.nodes[0]);
  expect(parentStyle.gridTemplateColumns).toBe("100px minmax(0, 2fr)");
  expect(parentStyle.gridTemplateRows).toBe("80px auto");
  expect(childStyle.gridColumn).toBe("span 2");
  expect(childStyle.gridRow).toBe("span 2");
  expect(childStyle.width).toBe("100%");
  const thumbnail = renderToStaticMarkup(
    createElement(ThumbnailRenderer, {
      fileId: "grid-file",
      snapshot: { document: { content: document }, frames: [], rectangles: [] },
    }),
  );
  const review = renderToStaticMarkup(
    createElement(DesignSnapshot, {
      reviewId: "review",
      content: document,
      frameId: "grid",
      selectedNode: null,
      onSelect: () => {},
    }),
  );
  for (const html of [thumbnail, review]) {
    expect(html).toContain("grid-template-columns:100px minmax(0, 2fr)");
    expect(html).toContain("grid-template-rows:80px auto");
    expect(html).toContain("grid-column:span 2");
  }
  const before = blankDesignDocument();
  const patch = diffDocument(before, document);
  expect(applyDocumentPatch(before, patch)).toEqual(document);
  expect(applyDocumentPatch(document, invertPatch(patch))).toEqual(before);
});

test("grid track and span values reject invalid document data", () => {
  const parent = buildDrawnNode("grid", "container", null, { x: 0, y: 0, width: 400, height: 300 });
  const document = blankDesignDocument();
  expect(() =>
    parseDesignDocument({
      ...document,
      nodes: [{ ...parent, gridColumnTracks: [{ unit: "fr", value: 0 }] }],
    }),
  ).toThrow();
  expect(() =>
    parseDesignDocument({ ...document, nodes: [{ ...parent, gridRowSpan: 13 }] }),
  ).toThrow();
  expect(() =>
    parseDesignDocument({
      ...document,
      nodes: [{ ...parent, gridColumnTracks: [{ unit: "calc", value: 1 }] }],
    }),
  ).toThrow();
});
