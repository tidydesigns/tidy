import { test, expect } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { blankDesignDocument, buildDrawnNode, parseDesignDocument } from "./document";
import { responsiveNode } from "./responsive-layout";
import { nodeStyle } from "./node-style";
import { applyDocumentPatch, diffDocument, invertPatch } from "./document-patch";
import { ThumbnailRenderer } from "@/app/files/thumbnail-renderer";
import { DesignSnapshot } from "@/components/github/design-snapshot";
import { webCaptureSchema } from "@bella/design/web-capture";

const wideId = "00000000-0000-4000-8000-000000000201";
const narrowId = "00000000-0000-4000-8000-000000000202";
const frame = buildDrawnNode("frame", "artboard", null, { x: 0, y: 0, width: 800, height: 600 });
const panel = {
  ...buildDrawnNode("panel", "container", "frame", { x: 20, y: 20, width: 600, height: 300 }),
  layout: "grid",
  gridColumns: 2,
  gridColumnTracks: [
    { unit: "fr", value: 1 },
    { unit: "fr", value: 1 },
  ],
  responsiveBreakpoints: [
    { id: wideId, frameMaxWidth: 900, gridColumns: 1, gap: 12, padding: 16 },
    { id: narrowId, frameMaxWidth: 600, layout: "flex-column", gap: 8 },
  ],
};

test("frame-width breakpoints cascade from wide to narrow and clear superseded grid tracks", () => {
  expect(responsiveNode(panel, 1200)).toBe(panel);
  const tablet = responsiveNode(panel, 800);
  expect(tablet.layout).toBe("grid");
  expect(tablet.gridColumnTracks).toBeUndefined();
  expect(nodeStyle(tablet, "absolute", {}).gridTemplateColumns).toBe("repeat(1, minmax(0, 1fr))");
  const mobile = responsiveNode(panel, 500);
  expect(mobile.layout).toBe("flex-column");
  expect(mobile.gap).toBe(8);
  expect(mobile.padding).toBe(16);
  expect(nodeStyle(mobile, "absolute", {}).gridTemplateColumns).toBeUndefined();
});

test("breakpoint edits patch and undo, and thumbnails/reviews render the frame rule", () => {
  const before = parseDesignDocument({
    ...blankDesignDocument(),
    nodes: [frame, { ...panel, responsiveBreakpoints: [] }],
  });
  const document = parseDesignDocument({ ...before, nodes: [frame, panel] });
  const patch = diffDocument(before, document);
  expect(applyDocumentPatch(before, patch)).toEqual(document);
  expect(applyDocumentPatch(document, invertPatch(patch))).toEqual(before);
  const thumbnail = renderToStaticMarkup(
    createElement(ThumbnailRenderer, {
      fileId: "responsive",
      snapshot: { document: { content: document }, frames: [], rectangles: [] },
    }),
  );
  const review = renderToStaticMarkup(
    createElement(DesignSnapshot, {
      reviewId: "review",
      content: document,
      frameId: "frame",
      selectedNode: null,
      onSelect: () => {},
    }),
  );
  for (const html of [thumbnail, review]) {
    expect(html).toContain("grid-template-columns:repeat(1, minmax(0, 1fr))");
    expect(html).toContain("padding-top:16px");
  }
});

test("breakpoint thresholds and identities are unique and bounded", () => {
  const document = blankDesignDocument();
  expect(() =>
    parseDesignDocument({
      ...document,
      nodes: [
        {
          ...panel,
          responsiveBreakpoints: [
            { id: wideId, frameMaxWidth: 900 },
            { id: narrowId, frameMaxWidth: 900 },
          ],
        },
      ],
    }),
  ).toThrow("Duplicate responsive breakpoint");
  expect(() =>
    parseDesignDocument({
      ...document,
      nodes: [{ ...panel, responsiveBreakpoints: [{ id: wideId, frameMaxWidth: 0 }] }],
    }),
  ).toThrow();
});

test("a narrower grid rule can clear inherited row tracks", () => {
  const source = {
    ...panel,
    gridRowTracks: [{ unit: "px", value: 60 }],
    responsiveBreakpoints: [{ id: wideId, frameMaxWidth: 900, gridRowTracks: [] }],
  };
  const document = parseDesignDocument({ ...blankDesignDocument(), nodes: [frame, source] });
  expect(responsiveNode(document.nodes[1], 1200).gridRowTracks).toEqual([
    { unit: "px", value: 60 },
  ]);
  expect(responsiveNode(document.nodes[1], 800).gridRowTracks).toBeUndefined();
});

test("web import retains breakpoint rules on responsive design documents", () => {
  const document = parseDesignDocument({ ...blankDesignDocument(), nodes: [frame, panel] });
  const capture = webCaptureSchema.parse({
    title: "Responsive fixture",
    url: "https://example.com/layout",
    mode: "element",
    document,
    assets: [],
  });
  expect(capture.document.nodes[1].responsiveBreakpoints).toEqual(panel.responsiveBreakpoints);
  expect(responsiveNode(capture.document.nodes[1], 500).layout).toBe("flex-column");
});

test("uniform breakpoint padding replaces inherited sides; explicit sides win", () => {
  const source = {
    ...panel,
    padding: 40,
    paddingTop: 50,
    paddingLeft: 70,
    responsiveBreakpoints: [
      { id: wideId, frameMaxWidth: 900, padding: 20, paddingRight: 30 },
      { id: narrowId, frameMaxWidth: 600, padding: 8, paddingBottom: 12 },
    ],
  };
  const sides = (width) => {
    const style = nodeStyle(responsiveNode(source, width), "absolute", {});
    return [style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft];
  };
  expect(sides(1000)).toEqual([50, 40, 40, 70]);
  expect(sides(800)).toEqual([20, 30, 20, 20]);
  expect(sides(500)).toEqual([8, 8, 12, 8]);
  expect(source.paddingTop).toBe(50);
});

test("clearing an override inherits identically before and after persistence", () => {
  const source = {
    ...panel,
    responsiveBreakpoints: [
      {
        id: wideId,
        frameMaxWidth: 900,
        layout: "flex-row",
        padding: 24,
        minWidth: 80,
        wrap: true,
        gap: 16,
      },
      {
        id: narrowId,
        frameMaxWidth: 600,
        layout: undefined,
        padding: undefined,
        minWidth: undefined,
        wrap: undefined,
        gap: undefined,
      },
    ],
  };
  const live = responsiveNode(source, 500),
    reopened = responsiveNode(JSON.parse(JSON.stringify(source)), 500);
  for (const key of ["layout", "padding", "minWidth", "wrap", "gap"])
    expect(live[key]).toEqual(reopened[key]);
  expect([live.layout, live.padding, live.minWidth, live.wrap, live.gap]).toEqual([
    "flex-row",
    24,
    80,
    true,
    16,
  ]);
});

test("validation rejects conflicting inherited limits at any breakpoint, including patches", () => {
  const source = {
    ...panel,
    minWidth: 100,
    maxWidth: 800,
    minHeight: 50,
    maxHeight: 400,
    responsiveBreakpoints: [
      { id: wideId, frameMaxWidth: 900, minWidth: 300, maxHeight: 200 },
      { id: narrowId, frameMaxWidth: 600, maxWidth: 400, minHeight: 100 },
    ],
  };
  const before = parseDesignDocument({ ...blankDesignDocument(), nodes: [frame, source] });
  for (const changes of [{ maxWidth: 200 }, { minHeight: 250 }]) {
    const after = {
      ...before,
      nodes: [
        frame,
        {
          ...source,
          responsiveBreakpoints: [
            source.responsiveBreakpoints[0],
            { ...source.responsiveBreakpoints[1], ...changes },
          ],
        },
      ],
    };
    expect(() => parseDesignDocument(after)).toThrow("at frame width 600px");
    expect(() => applyDocumentPatch(before, diffDocument(before, after))).toThrow(
      "at frame width 600px",
    );
  }
});

test("signed gaps overlap only non-wrapping flex children; wrapped flex and grid use nonnegative gutters", () => {
  const child = buildDrawnNode("child", "container", "panel", {
    x: 0,
    y: 0,
    width: 20,
    height: 20,
  });
  for (const layout of ["flex-row", "flex-column", "grid"])
    for (const wrap of [false, true]) {
      const parent = { ...panel, layout, wrap, gap: -12, responsiveBreakpoints: undefined };
      const parentStyle = nodeStyle(parent, "absolute", {}),
        first = nodeStyle(child, layout, {}, parent, 0),
        second = nodeStyle(child, layout, {}, parent, 1);
      expect(parentStyle.columnGap).toBe(0);
      expect(parentStyle.rowGap).toBe(0);
      expect(first.marginLeft).toBeUndefined();
      expect(first.marginTop).toBeUndefined();
      expect(second.marginLeft).toBe(!wrap && layout === "flex-row" ? -12 : undefined);
      expect(second.marginTop).toBe(!wrap && layout === "flex-column" ? -12 : undefined);
      const overlay = nodeStyle({ ...child, positionMode: "absolute" }, layout, {}, parent, 1);
      expect(overlay.marginLeft).toBeUndefined();
      expect(overlay.marginTop).toBeUndefined();
    }
});

test("nested responsive fixtures agree across canvas, thumbnail, review, and portable export", async () => {
  const { CanvasArtwork } = await import("@/app/files/[uid]/canvas-artwork");
  const { DocumentPreview } = await import("@/app/files/thumbnail-renderer");
  const { TidyDesign } = await import("./code-runtime");
  const { containingFrameWidth } = await import("./responsive-layout");
  const row = {
    ...panel,
    layout: "flex-row",
    widthMode: "fill",
    align: "baseline",
    padding: 30,
    paddingLeft: 50,
    style: { borderTopWidth: 2, borderRightWidth: 3, borderBottomWidth: 4, borderLeftWidth: 5 },
    responsiveBreakpoints: [
      { id: wideId, frameMaxWidth: 900, layout: "grid", gridColumns: 2, gap: 14, padding: 18 },
      {
        id: narrowId,
        frameMaxWidth: 600,
        layout: "flex-column",
        gap: 6,
        padding: 8,
        paddingBottom: 12,
      },
    ],
  };
  const stack = {
    ...buildDrawnNode("stack", "container", "panel", { x: 0, y: 0, width: 160, height: 200 }),
    layout: "flex-column",
    widthMode: "fill",
    minWidth: 80,
    maxWidth: 400,
    gridColumnSpan: 2,
    gap: -7,
  };
  const a = buildDrawnNode("a", "text", "stack", { x: 0, y: 0, width: 80, height: 30 });
  const hidden = { ...a, id: "hidden", visible: false };
  const overlay = {
    ...a,
    id: "overlay",
    positionMode: "absolute",
    box: { x: 11, y: 17, width: 20, height: 20 },
  };
  const b = {
    ...a,
    id: "b",
    widthMode: "fill",
    responsiveBreakpoints: [{ id: narrowId, frameMaxWidth: 600, minHeight: 35 }],
  };
  for (const width of [1200, 800, 400]) {
    const document = parseDesignDocument({
      ...blankDesignDocument(),
      nodes: [{ ...frame, box: { ...frame.box, width } }, row, stack, a, hidden, overlay, b],
    });
    expect(containingFrameWidth(b, document.nodes)).toBe(width);
    const childrenById = new Map();
    for (const node of document.nodes)
      childrenById.set(node.parentId, [...(childrenById.get(node.parentId) ?? []), node]);
    const canvas = createElement(CanvasArtwork, {
      nodesById: new Map(document.nodes.map((node) => [node.id, node])),
      childrenById,
      visibleRootIds: new Set(["frame"]),
      tokens: {},
      selectedIds: [],
      prototypeMode: false,
    });
    const thumbnail = createElement(DocumentPreview, { content: document });
    const review = createElement(DesignSnapshot, {
      reviewId: "review",
      content: document,
      frameId: "frame",
      selectedNode: null,
      onSelect: () => {},
    });
    const portable = createElement(TidyDesign, {
      document,
      rootId: "frame",
      assets: {},
      frameWidth: width,
    });
    for (const component of [canvas, thumbnail, review, portable]) {
      const html = renderToStaticMarkup(component);
      expect(html).toContain(`padding-left:${width === 1200 ? 50 : width === 800 ? 18 : 8}px`);
      expect(html).toContain(`padding-bottom:${width === 1200 ? 30 : width === 800 ? 18 : 12}px`);
      expect(html).toContain("border-left-width:5px");
      expect(html).toContain("min-width:80px;max-width:400px");
      expect(html).toContain("margin-top:-7px");
      expect(html).toContain("left:11px;top:17px");
      if (width === 1200) expect(html).toContain("align-items:baseline");
      if (width === 800) expect(html).toContain("grid-column:span 2");
      if (width === 400) expect(html).toContain("min-height:35px");
    }
    const captured = webCaptureSchema.parse({
      title: "Nested layout",
      url: "https://example.com/layout",
      mode: "element",
      document,
      assets: [],
    });
    expect(parseDesignDocument(JSON.parse(JSON.stringify(captured.document)))).toEqual(document);
    const patch = diffDocument(blankDesignDocument(), document);
    expect(applyDocumentPatch(blankDesignDocument(), patch)).toEqual(document);
    expect(applyDocumentPatch(document, invertPatch(patch))).toEqual(blankDesignDocument());
  }
});

test("breakpoint inspector exposes sizing for leaf layers and container-only spacing controls", async () => {
  const { ResponsiveBreakpoints } = await import("@/app/files/[uid]/responsive-breakpoints");
  for (const type of ["text", "image", "vector", "container"]) {
    const node = { ...panel, type };
    const html = renderToStaticMarkup(
      createElement(ResponsiveBreakpoints, {
        node,
        document: { nodes: [frame, node] },
        onPatch: () => {},
      }),
    );
    expect(html).toContain("Breakpoint width");
    expect(html).toContain("Breakpoint min width");
    expect(html.includes("Breakpoint flow")).toBe(type === "container");
    expect(html.includes("Padding by side")).toBe(type === "container");
  }
});

test("child spacing controls follow the parent's active breakpoint layout", async () => {
  const { SelectionInspector } = await import("@/app/files/[uid]/selection-inspector");
  const child = buildDrawnNode("child", "container", "panel", {
    x: 0,
    y: 0,
    width: 100,
    height: 100,
  });
  const parent = {
    ...panel,
    layout: "absolute",
    responsiveBreakpoints: panel.responsiveBreakpoints.map((rule, index) =>
      index === 0 ? { ...rule, layout: "grid" } : rule,
    ),
  };
  for (const width of [1200, 800, 400]) {
    const document = {
      ...blankDesignDocument(),
      nodes: [{ ...frame, box: { ...frame.box, width } }, parent, child],
    };
    const html = renderToStaticMarkup(
      createElement(SelectionInspector, { document, selected: [child] }),
    );
    expect(html.includes("Column span")).toBe(width === 800);
    expect(html.includes("Gap adjustment")).toBe(width === 400);
    expect(html.includes("Horizontal constraint")).toBe(width === 1200);
  }
});

test("breakpoint edits replace specific overrides and normalize overlap when enabling wrap", async () => {
  const { ResponsiveBreakpoints } = await import("@/app/files/[uid]/responsive-breakpoints");
  let current = {
    ...panel,
    layout: "flex-row",
    responsiveBreakpoints: [
      { id: wideId, frameMaxWidth: 900, gap: -10, columnGap: 4, padding: 20, paddingLeft: 30 },
    ],
  };
  function field(label) {
    const tree = ResponsiveBreakpoints({
      node: current,
      document: { nodes: [frame, current] },
      onPatch: (patch) => {
        current = { ...current, ...patch(current) };
      },
    });
    function find(element) {
      if (!element || typeof element !== "object") return;
      if (element.props?.label === label) return element.props;
      for (const child of [element.props?.children].flat(Infinity)) {
        const found = find(child);
        if (found) return found;
      }
    }
    return find(tree);
  }
  field("Breakpoint gap").onCommit("-8");
  expect(responsiveNode(current, 800).columnGap).toBeUndefined();
  field("Breakpoint padding").onCommit("12");
  expect(nodeStyle(responsiveNode(current, 800), "absolute", {}).paddingLeft).toBe(12);
  field("Breakpoint wrap").onChange("true");
  expect(responsiveNode(current, 800).gap).toBe(0);
  expect(field("Breakpoint gap").min).toBe(0);
  field("Breakpoint flow").onChange("grid");
  current.responsiveBreakpoints[0].gridColumnTracks = [{ unit: "px", value: 50 }];
  field("Breakpoint columns").onCommit("3");
  expect(nodeStyle(responsiveNode(current, 800), "absolute", {}).gridTemplateColumns).toBe(
    "repeat(3, minmax(0, 1fr))",
  );
});
