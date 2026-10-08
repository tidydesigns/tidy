import { test, expect } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { blankDesignDocument, buildDrawnNode, parseDesignDocument } from "./document";
import {
  nodeEffects,
  nodeShadows,
  effectStyle,
  shadowStyle,
  moveEffect,
} from "@bella/design/effects";
import { diffDocument, applyDocumentPatch, invertPatch } from "./document-patch";
import { DocumentPreview } from "@/app/files/thumbnail-renderer";
import { DesignSnapshot } from "@/components/github/design-snapshot";
import { TidyDesign } from "./code-runtime";
import { nodeStyle } from "./node-style";
import { scaleLayers } from "./layout-operations";
import { webCaptureSchema } from "@bella/design/web-capture";

const frame = {
  ...buildDrawnNode("frame", "artboard", null, { x: 0, y: 0, width: 200, height: 200 }),
  style: { shadow: "0 2px 8px #00000033", blur: 4, brightness: 120, contrast: 80 },
};
test("ordered effects and shadow visibility agree in shared renderers and survive capture, patch and undo", () => {
  const before = parseDesignDocument({ ...blankDesignDocument(), nodes: [frame] });
  const effects = moveEffect(nodeEffects(frame.style), "legacy-contrast", -1);
  const shadows = nodeShadows(frame.style).map((shadow) => ({ ...shadow, visible: false }));
  const after = parseDesignDocument({
    ...before,
    nodes: [
      {
        ...frame,
        style: { ...frame.style, ...effectStyle(effects), ...shadowStyle(frame.style, shadows) },
      },
    ],
  });
  expect(nodeStyle(after.nodes[0], "absolute", {}).filter).toBe(
    "blur(4px) contrast(80%) brightness(120%)",
  );
  expect(nodeStyle(after.nodes[0], "absolute", {}).boxShadow).toBeUndefined();
  for (const component of [
    createElement(DocumentPreview, { content: after }),
    createElement(DesignSnapshot, {
      reviewId: "review",
      content: after,
      frameId: "frame",
      selectedNode: null,
    }),
    createElement(TidyDesign, { document: after, rootId: "frame", assets: {} }),
  ]) {
    const html = renderToStaticMarkup(component);
    expect(html).toContain("filter:blur(4px) contrast(80%) brightness(120%)");
    expect(html).not.toContain("box-shadow:");
  }
  const patch = diffDocument(before, after);
  expect(applyDocumentPatch(before, patch)).toEqual(after);
  expect(applyDocumentPatch(after, invertPatch(patch))).toEqual(before);
  const capture = webCaptureSchema.parse({
    title: "Effects",
    url: "https://example.com/",
    mode: "element",
    document: after,
    assets: [],
  });
  expect(parseDesignDocument(JSON.parse(JSON.stringify(capture.document)))).toEqual(after);
  const scaled = scaleLayers(after, ["frame"], 2);
  expect(scaled.nodes[0].style.effects.map((effect) => effect.amount)).toEqual([8, 80, 120]);
});
