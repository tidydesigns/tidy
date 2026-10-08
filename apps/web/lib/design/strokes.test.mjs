import { test, expect } from "bun:test";
import sharp from "sharp";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  blankDesignDocument,
  buildDrawnNode,
  designNodeChangesSchema,
  parseDesignDocument,
} from "./document";
import { strokeGeometry, strokeSvg, strokeStyle, nodeStrokePaints } from "./strokes";
import { nodeStyle } from "./node-style";
import { renameColorToken, removeColorToken } from "./tokens";
import { selectionColors } from "./selection-colors";
import { copyProperties, readDesignClipboard, pasteProperties } from "./clipboard";
import { diffDocument, applyDocumentPatch, invertPatch } from "./document-patch";
import { DocumentPreview } from "@/app/files/thumbnail-renderer";
import { DesignSnapshot } from "@/components/github/design-snapshot";
import { TidyDesign } from "./code-runtime";
import { FillInspector } from "@/app/files/[uid]/fill-inspector";
import { webCaptureSchema } from "@bella/design/web-capture";
const base = buildDrawnNode("frame", "artboard", null, { x: 0, y: 0, width: 100, height: 100 });
const solid = (id, color, opacity = 1) => ({ id, type: "solid", color, opacity, visible: true });

test("stroke placement changes ink bounds while retaining per-side layout widths", () => {
  for (const [strokePosition, fraction] of [
    ["inside", 0],
    ["center", 0.5],
    ["outside", 1],
  ]) {
    const node = {
      ...base,
      style: {
        borderTopWidth: 4,
        borderRightWidth: 8,
        borderBottomWidth: 12,
        borderLeftWidth: 16,
        strokePosition,
      },
    };
    const geometry = strokeGeometry(node.style, node.box),
      style = nodeStyle(node, "absolute", {});
    expect(geometry.outset).toEqual([4, 8, 12, 16].map((width) => width * fraction));
    expect(geometry.inset).toEqual([4, 8, 12, 16].map((width) => width * (1 - fraction)));
    expect([
      style.borderTopWidth,
      style.borderRightWidth,
      style.borderBottomWidth,
      style.borderLeftWidth,
    ]).toEqual([4, 8, 12, 16]);
    expect([style.width, style.height]).toEqual([100, 100]);
  }
  expect(strokeStyle(base, {}).borderImageSource).toBeUndefined();
  expect(
    nodeStrokePaints({
      ...base,
      style: { borderWidth: 4, borderColorToken: "brand", borderColor: "#ff0000" },
    })[0].token,
  ).toBe("brand");
  expect(nodeStrokePaints({ ...base, style: { borderWidth: 4, strokePaints: [] } })).toEqual([]);
});

test("stroke stacks preserve opacity/order and generate only stroke pixels", async () => {
  const node = {
    ...base,
    style: {
      borderWidth: 10,
      strokePosition: "outside",
      strokePaints: [solid("red", "#ff0000", 0.5), solid("blue", "#0000ff")],
    },
  };
  const { data, info } = await sharp(Buffer.from(strokeSvg(node, {})))
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const pixel = (x, y) => [
    ...data.subarray((y * info.width + x) * 4, (y * info.width + x) * 4 + 4),
  ];
  expect([info.width, info.height]).toEqual([120, 120]);
  const edge = pixel(3, 60);
  expect(edge[0]).toBeGreaterThanOrEqual(127);
  expect(edge[0]).toBeLessThanOrEqual(128);
  expect(edge[2]).toBeGreaterThanOrEqual(127);
  expect(edge[2]).toBeLessThanOrEqual(128);
  expect(edge[3]).toBe(255);
  expect(pixel(60, 60)[3]).toBe(0);
  const hidden = strokeSvg(
    {
      ...node,
      style: {
        ...node.style,
        strokePaints: node.style.strokePaints.map((paint) => ({ ...paint, visible: false })),
      },
    },
    {},
  );
  const hiddenPixels = await sharp(Buffer.from(hidden)).ensureAlpha().raw().toBuffer();
  expect([...hiddenPixels].every((value) => value === 0)).toBe(true);
});

test("stroke gradient tokens survive rename, removal, selection palettes and appearance paste", () => {
  const gradient = {
    id: "gradient",
    type: "linear",
    angle: 90,
    visible: true,
    opacity: 1,
    stops: [
      { id: "start", position: 0, color: "#ff0000", token: "brand" },
      { id: "end", position: 1, color: "#0000ff" },
    ],
  };
  const source = parseDesignDocument({
    ...blankDesignDocument(),
    tokens: { brand: "#00ff00" },
    nodes: [{ ...base, style: { borderWidth: 5, strokePaints: [gradient] } }],
  });
  expect(strokeSvg(source.nodes[0], source.tokens)).toContain('stop-color="#00ff00"');
  expect(selectionColors(source.nodes, source.tokens)).toContain("#00ff00");
  const renamed = renameColorToken(source, "brand", "accent"),
    removed = removeColorToken(renamed, "accent");
  expect(renamed.nodes[0].style.strokePaints[0].stops[0].token).toBe("accent");
  expect(removed.nodes[0].style.strokePaints[0].stops[0]).toMatchObject({
    color: "#00ff00",
    token: undefined,
  });
  const target = {
    ...blankDesignDocument(),
    tokens: { brand: "#ffffff" },
    nodes: [{ ...base, id: "target" }],
  };
  const pasted = pasteProperties(
    target,
    readDesignClipboard(copyProperties(source.nodes[0], source, "source")),
    ["target"],
  );
  expect(pasted.tokens.brand).toBe("#ffffff");
  expect(pasted.nodes[0].style.strokePaints[0].stops[0].token).toBe("brand_2");
});

test("stroke and corner schemas reject invalid geometry or duplicate paints", () => {
  for (const style of [
    { strokePosition: "invalid" },
    { cornerSmoothing: 1.01 },
    { cornerSmoothing: -0.1 },
    { strokePaints: [solid("one", "#ff0000"), solid("one", "#0000ff")] },
    { strokePaints: [{ id: "image", type: "image", visible: true, opacity: 1 }] },
  ])
    expect(designNodeChangesSchema.safeParse({ style }).success).toBe(false);
  const node = {
    ...base,
    style: { radius: 5000, cornerSmoothing: 1, borderWidth: 40, strokePosition: "outside" },
  };
  expect(strokeSvg(node, {})).not.toMatch(/NaN|Infinity/);
  expect(strokeSvg(node, {})).toContain('width="180"');
});

test("stroke rendering agrees in previews, review and portable markup and survives import/undo", () => {
  const before = parseDesignDocument({ ...blankDesignDocument(), nodes: [base] });
  const after = parseDesignDocument({
    ...before,
    nodes: [
      {
        ...base,
        style: {
          borderWidth: 4,
          radius: 24,
          cornerSmoothing: 0.7,
          strokePosition: "center",
          strokePaints: [solid("stroke", "#123456")],
        },
      },
    ],
  });
  for (const component of [
    createElement(DocumentPreview, { content: after }),
    createElement(DesignSnapshot, { reviewId: "review", content: after, frameId: "frame" }),
    createElement(TidyDesign, { document: after, rootId: "frame", assets: {} }),
  ]) {
    const html = renderToStaticMarkup(component);
    expect(html).toContain("border-image-outset:2px 2px 2px 2px");
    expect(html).toContain("corner-shape:superellipse(1.7)");
    expect(html).toContain("data-stroke-measure");
  }
  const patch = diffDocument(before, after);
  expect(applyDocumentPatch(before, patch)).toEqual(after);
  expect(applyDocumentPatch(after, invertPatch(patch))).toEqual(before);
  const capture = webCaptureSchema.parse({
    title: "Strokes",
    url: "https://example.com/",
    mode: "element",
    document: after,
    assets: [],
  });
  expect(parseDesignDocument(JSON.parse(JSON.stringify(capture.document)))).toEqual(after);
  const inspector = renderToStaticMarkup(
    createElement(FillInspector, {
      mode: "stroke",
      selected: after.nodes,
      tokens: {},
      onPatch: () => {},
    }),
  );
  expect(inspector).toContain("Add stroke");
  expect(inspector).toContain("Stroke color");
  expect(inspector).not.toContain("Add fill");
});

test("dashed and dotted strokes retain painted segments and gaps", async () => {
  for (const borderStyle of ["dashed", "dotted"]) {
    const node = {
      ...base,
      style: { borderWidth: 6, borderStyle, strokePaints: [solid("stroke", "#ff0000")] },
    };
    const { data, info } = await sharp(Buffer.from(strokeSvg(node, {})))
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const row = Array.from(
      { length: 80 },
      (_, index) => data[(3 * info.width + index + 10) * 4 + 3],
    );
    expect(row.some((alpha) => alpha === 255)).toBe(true);
    expect(row.some((alpha) => alpha === 0)).toBe(true);
  }
});

test("review and thumbnail bounds include visible outside strokes", () => {
  const document = parseDesignDocument({
    ...blankDesignDocument(),
    nodes: [
      {
        ...base,
        style: {
          borderWidth: 40,
          strokePosition: "outside",
          strokePaints: [solid("stroke", "#ff0000")],
        },
      },
    ],
  });
  const review = renderToStaticMarkup(
    createElement(DesignSnapshot, { reviewId: "review", content: document, frameId: "frame" }),
  );
  expect(review).toContain("left:40px;top:40px;width:100px;height:100px");
  expect(review).toContain("width:180px;height:180px");
  const thumbnail = renderToStaticMarkup(createElement(DocumentPreview, { content: document }));
  expect(thumbnail).toContain('viewBox="-64 -64 228 228"');
});
