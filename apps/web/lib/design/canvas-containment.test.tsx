import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CanvasArtwork } from "@tidy/editor/editor/canvas-artwork";
import { buildDrawnNode, type DesignNode } from "./document";

function frameMarkup({
  style = {},
  heightMode = "fixed",
  childStyle = {},
}: {
  style?: DesignNode["style"];
  heightMode?: DesignNode["heightMode"];
  childStyle?: DesignNode["style"];
} = {}) {
  const root = {
    ...buildDrawnNode("frame", "artboard", null, { x: 0, y: 0, width: 500, height: 500 }),
    style,
    heightMode,
  };
  const child = {
    ...buildDrawnNode("child", "container", "frame", { x: 20, y: 20, width: 100, height: 100 }),
    style: childStyle,
  };
  const noop = () => {};
  const markup = renderToStaticMarkup(
    createElement(CanvasArtwork, {
      nodesById: new Map([
        [root.id, root],
        [child.id, child],
      ]),
      childrenById: new Map([
        [null, [root]],
        [root.id, [child]],
      ]),
      visibleRootIds: new Set([root.id]),
      tokens: {},
      selectedIds: [],
      prototypeMode: false,
      prototypeArtboardId: null,
      cropId: null,
      editingTextId: null,
      registerElement: noop,
      onMenu: noop,
      onDoubleClick: noop,
      onPointerDown: noop,
      onPointerMove: noop,
      onPointerUp: noop,
      onPointerCancel: noop,
      onTextDraft: noop,
      onTextFinish: noop,
    }),
  );
  const tag = markup.match(/<div[^>]*data-node-id="frame"[^>]*>/)?.[0];
  if (!tag) throw new Error("Missing rendered frame");
  return tag;
}

test("fixed clipped artboards isolate paint without changing overflow or hug layout", () => {
  expect(frameMarkup()).toContain("contain:layout paint style");
  expect(frameMarkup({ style: { overflow: "visible" } })).not.toContain("contain:");
  expect(frameMarkup({ style: { overflow: "auto" } })).not.toContain("contain:");
  expect(frameMarkup({ heightMode: "hug" })).not.toContain("contain:");
});

test("frame paint containment preserves external blend and backdrop effects", () => {
  expect(frameMarkup({ childStyle: { blendMode: "multiply" } })).not.toContain("contain:");
  expect(frameMarkup({ childStyle: { backdropBlur: 8 } })).not.toContain("contain:");
  expect(frameMarkup({ style: { blendMode: "screen" } })).not.toContain("contain:");
});
