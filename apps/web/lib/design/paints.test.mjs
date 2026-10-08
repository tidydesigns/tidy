import { test, expect } from "bun:test";
import {
  blankDesignDocument,
  buildDrawnNode,
  designNodeChangesSchema,
  documentAssetIds,
  parseDesignDocument,
} from "./document";
import { nodePaints, paintStyle, paintBackground, convertPaint } from "./paints";
import { nodeStyle } from "./node-style";
import { renameColorToken, removeColorToken } from "./tokens";
import { copyProperties, pasteProperties, readDesignClipboard } from "./clipboard";
import { webCaptureSchema } from "@bella/design/web-capture";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NodeFills } from "@/components/design/node-fills";
const node = () =>
  buildDrawnNode("node", "container", null, { x: 0, y: 0, width: 100, height: 100 });
const solid = (id = "solid") => ({
  id,
  type: "solid",
  color: "#ff0000",
  opacity: 1,
  visible: true,
});
const gradient = () => ({
  id: "gradient",
  type: "linear",
  angle: 90,
  opacity: 0.5,
  visible: true,
  stops: [
    { id: "b", color: "#0000ff", position: 1 },
    { id: "a", color: "#ff0000", position: 0, token: "brand" },
  ],
});
test("legacy fills and gradients migrate only when edited and explicit empty stacks remain empty", () => {
  expect(
    nodePaints({ ...node(), style: { fill: "#112233", fillToken: "brand" } })[0],
  ).toMatchObject({ type: "solid", color: "#112233", token: "brand" });
  expect(
    nodePaints({
      ...node(),
      style: { gradientFrom: "#ff0000", gradientTo: "#0000ff", gradientAngle: 30 },
    })[0],
  ).toMatchObject({ type: "linear", angle: 30 });
  expect(nodePaints({ ...node(), style: { paints: [], fill: "#ffffff" } })).toEqual([]);
  expect(paintStyle([solid()])).toMatchObject({
    paints: [solid()],
    fill: undefined,
    gradientFrom: undefined,
  });
});
test("gradient rendering sorts stops, resolves tokens, and supports independent radial geometry", () => {
  expect(paintBackground(gradient(), { brand: "#00ff00" })).toBe(
    "linear-gradient(90deg, #00ff00 0%, #0000ff 100%)",
  );
  expect(
    paintBackground({ ...convertPaint(gradient(), "radial"), centerX: 0.25, radiusX: 0.8 }, {}),
  ).toBe("radial-gradient(ellipse 80% 50% at 25% 50%, #ff0000 0%, #0000ff 100%)");
  expect(gradient().stops[0].position).toBe(1);
});
test("changing paint types preserves identity, opacity, visibility and reusable stops", () => {
  const radial = convertPaint(gradient(), "radial");
  expect(radial).toMatchObject({
    id: "gradient",
    opacity: 0.5,
    visible: true,
    stops: gradient().stops,
  });
  expect(convertPaint(gradient(), "solid")).toMatchObject({ color: "#ff0000", token: "brand" });
  expect(convertPaint(radial, "linear").stops).toEqual(radial.stops);
  expect(convertPaint(radial, "image")).toMatchObject({
    id: "gradient",
    type: "image",
    opacity: 0.5,
    fit: "cover",
  });
});
test("single opaque fills use the shared background renderer and stacked/translucent fills isolate layers", () => {
  expect(nodeStyle({ ...node(), style: { paints: [solid()] } }, "absolute", {}).background).toBe(
    "#ff0000",
  );
  expect(
    nodeStyle({ ...node(), style: { paints: [solid(), gradient()] } }, "absolute", {}),
  ).toMatchObject({ isolation: "isolate", background: undefined });
  expect(
    nodeStyle({ ...node(), style: { paints: [{ ...solid(), opacity: 0.5 }] } }, "absolute", {})
      .background,
  ).toBeUndefined();
});
test("each fill keeps its own blend mode through schema, conversion, and layered rendering", () => {
  const blended = { ...solid(), blendMode: "multiply" };
  const layer = { ...node(), style: { paints: [blended] } };
  expect(designNodeChangesSchema.safeParse({ style: layer.style }).success).toBe(true);
  expect(
    designNodeChangesSchema.safeParse({
      style: { paints: [{ ...blended, blendMode: "unsupported" }] },
    }).success,
  ).toBe(false);
  expect(nodeStyle(layer, "absolute", {}).background).toBeUndefined();
  expect(renderToStaticMarkup(createElement(NodeFills, { node: layer, tokens: {} }))).toContain(
    "mix-blend-mode:multiply",
  );
  expect(convertPaint(blended, "linear").blendMode).toBe("multiply");
});
test("image fills retain a bounded source crop and render it without changing the asset", () => {
  const image = {
    ...convertPaint(solid(), "image"),
    assetId: "00000000-0000-4000-8000-000000000001",
    crop: { x: 0.5, y: 0, width: 0.5, height: 1, sourceWidth: 800, sourceHeight: 400 },
  };
  const layer = { ...node(), style: { paints: [image] } };
  expect(designNodeChangesSchema.safeParse({ style: layer.style }).success).toBe(true);
  expect(
    designNodeChangesSchema.safeParse({
      style: { paints: [{ ...image, crop: { ...image.crop, x: 0.6 } }] },
    }).success,
  ).toBe(false);
  expect(renderToStaticMarkup(createElement(NodeFills, { node: layer, tokens: {} }))).toContain(
    'viewBox="400 0 400 400"',
  );
  expect(documentAssetIds({ ...blankDesignDocument(), nodes: [layer] })).toEqual([image.assetId]);
});
test("token rename and removal preserve solid and gradient-stop bindings and bake rendered colors", () => {
  const document = {
    ...blankDesignDocument(),
    tokens: { brand: "#00ff00" },
    nodes: [{ ...node(), style: { paints: [{ ...solid(), token: "brand" }, gradient()] } }],
  };
  const renamed = renameColorToken(document, "brand", "accent");
  expect(renamed.nodes[0].style.paints[0].token).toBe("accent");
  expect(renamed.nodes[0].style.paints[1].stops[1].token).toBe("accent");
  const removed = removeColorToken(renamed, "accent");
  expect(removed.nodes[0].style.paints[0]).toMatchObject({ token: undefined, color: "#00ff00" });
  expect(removed.nodes[0].style.paints[1].stops[1]).toMatchObject({
    token: undefined,
    color: "#00ff00",
  });
});
test("appearance clipboard remaps nested paint tokens without changing destination colors", () => {
  const source = {
    ...blankDesignDocument(),
    tokens: { brand: "#00ff00" },
    nodes: [{ ...node(), style: { paints: [gradient()] } }],
  };
  const target = {
    ...blankDesignDocument(),
    tokens: { brand: "#000000" },
    nodes: [{ ...node(), id: "target" }],
  };
  const result = pasteProperties(
    target,
    readDesignClipboard(copyProperties(source.nodes[0], source, "source")),
    ["target"],
  );
  expect(result.tokens.brand).toBe("#000000");
  expect(result.nodes[0].style.paints[0].stops[1].token).toBe("brand_2");
});
test("asset collection includes hidden image fills for authorization and snapshots", () => {
  const asset = "00000000-0000-4000-8000-000000000001",
    other = "00000000-0000-4000-8000-000000000002";
  const image = { ...convertPaint(solid(), "image"), assetId: asset, visible: false };
  expect(
    documentAssetIds({
      ...blankDesignDocument(),
      nodes: [{ ...node(), assetId: other, style: { paints: [image, { ...image, id: "other" }] } }],
    }),
  ).toEqual([other, asset]);
});
test("strict paint schemas bound stacks, reject duplicate identities and validate every stop", () => {
  expect(
    designNodeChangesSchema.safeParse({ style: { paints: [solid(), gradient()] } }).success,
  ).toBe(true);
  for (const paints of [
    [solid(), solid()],
    [{ ...gradient(), stops: [gradient().stops[0]] }],
    [{ ...gradient(), stops: [{ ...gradient().stops[0], position: 2 }, gradient().stops[1]] }],
    Array.from({ length: 21 }, (_, i) => solid(String(i))),
  ]) {
    expect(designNodeChangesSchema.safeParse({ style: { paints } }).success).toBe(false);
  }
  expect(
    parseDesignDocument({ ...blankDesignDocument(), nodes: [node()] }).nodes[0].style.paints,
  ).toBeUndefined();
});
test("web captures cannot omit an image fill's asset payload", () => {
  const frame = {
    ...node(),
    type: "artboard",
    style: {
      paints: [
        { ...convertPaint(solid(), "image"), assetId: "00000000-0000-4000-8000-000000000001" },
      ],
    },
  };
  const capture = {
    title: "Example",
    url: "https://example.com/",
    mode: "page",
    document: { ...blankDesignDocument(), nodes: [frame] },
    assets: [],
  };
  expect(webCaptureSchema.safeParse(capture).success).toBe(false);
  expect(
    webCaptureSchema.safeParse({
      ...capture,
      assets: [{ id: frame.style.paints[0].assetId, mimeType: "image/png", base64: "AAAA" }],
    }).success,
  ).toBe(true);
});

test("rotated radial paints use measured, self-contained SVG backgrounds with token colors", async () => {
  const sharp = (await import("sharp")).default;
  const radial = {
    ...convertPaint(gradient(), "radial"),
    opacity: 1,
    rotation: 90,
    radiusX: 0.4,
    radiusY: 0.1,
  };
  const size = { width: 200, height: 100 },
    background = paintBackground(radial, { brand: "#00ff00" }, size);
  const svg = decodeURIComponent(background.slice('url("data:image/svg+xml,'.length, -2));
  expect(svg).toContain("rotate(90) scale(80 10)");
  expect(svg).toContain('stop-color="#00ff00"');
  const { data, info } = await sharp(Buffer.from(svg))
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const pixel = (x, y) => [
    ...data.subarray((y * info.width + x) * 4, (y * info.width + x) * 4 + 4),
  ];
  const center = pixel(100, 50),
    halfway = pixel(100, 90),
    outside = pixel(120, 50);
  expect(center[1]).toBeGreaterThan(235);
  expect(halfway[1]).toBeGreaterThan(115);
  expect(halfway[1]).toBeLessThan(140);
  expect(halfway[2]).toBeGreaterThan(115);
  expect(halfway[2]).toBeLessThan(140);
  expect(outside).toEqual([0, 0, 255, 255]);
  const layer = { ...node(), box: { x: 0, y: 0, ...size }, style: { paints: [radial] } };
  expect(nodeStyle(layer, "absolute", {}).background).toBeUndefined();
  const html = renderToStaticMarkup(
    createElement(NodeFills, { node: layer, tokens: { brand: "#00ff00" } }),
  );
  expect(html).toContain("data-fill-stack");
  expect(html).toContain("data:image/svg+xml");
  expect(html).toContain("rotate(90)");
});
