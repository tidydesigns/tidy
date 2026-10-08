import { expect, test } from "bun:test";
import sharp from "sharp";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  parsePathContours,
  serializeContours,
  moveVectorPoint,
  splitVectorSegment,
  setVectorPointMode,
} from "@bella/design/vector-geometry";
import {
  blankDesignDocument,
  buildDrawnNode,
  parseDesignDocument,
  designNodeChangesSchema,
} from "./document";
import { diffDocument, applyDocumentPatch, invertPatch } from "./document-patch";
import { editLayers } from "./edit-document";
import { copyLayers, readDesignClipboard, pasteLayers } from "./clipboard";
import { createComponentInstance, makeComponent } from "./document-operations";
import { DocumentPreview } from "@/app/files/thumbnail-renderer";
import { TidyDesign } from "./code-runtime";
import { vectorSvg, vectorViewport, vectorImageStyle } from "./vector-path";

const path = (d = "M10 20 C20 0 80 0 90 20 L90 80 Z") => {
  const contours = parsePathContours(d);
  return {
    ...buildDrawnNode("path", "container", null, { x: 0, y: 0, width: 100, height: 100 }),
    type: "vector",
    vectorPath: {
      contours,
      d: serializeContours(contours),
      viewBox: { x: 0, y: 0, width: 100, height: 100 },
      fillRule: "nonzero",
    },
    style: {
      paints: [{ id: "fill", type: "solid", color: "#ff6600", visible: true, opacity: 1 }],
      strokePaints: [],
      borderWidth: 0,
    },
  };
};

test("SVG command grammar resolves repeated relative, reflected, quadratic and compact arc commands", () => {
  const points = parsePathContours(
    "m10 20 10 0 h10 v10 c0 10 10 10 10 0 s10 -10 10 0 q10 20 20 0 t20 0 a10 10 0 0110 10 z",
  )[0].points;
  expect(points[1]).toMatchObject({ x: 20, y: 20 });
  expect(points[3]).toMatchObject({ x: 30, y: 30 });
  expect(points[4].out).toEqual({ x: 40, y: 20 });
  expect(points[6].out.y).toBeCloseTo(16.6666667);
  expect(points.at(-1)).toMatchObject({ x: 100, y: 40 });
  const afterClose = parsePathContours("M10 10 L20 20 Z l10 0");
  expect(afterClose[1].points).toMatchObject([
    { x: 10, y: 10 },
    { x: 20, y: 10 },
  ]);
  for (const invalid of [
    "L0 0",
    "M0",
    "M0 0 C1 2",
    "M0 0 A1 1 0 2 0 4 4",
    "M0 0 garbage",
    "M0 0 L1e999 2",
  ])
    expect(() => parsePathContours(invalid)).toThrow();
});

test("closed cubic geometry joins the final handle to the first anchor without duplicate points", () => {
  const contours = parsePathContours("M0 0 C20 0 20 20 0 0 Z");
  expect(contours[0].points).toHaveLength(1);
  expect(contours[0].points[0].in).toEqual({ x: 20, y: 20 });
  expect(serializeContours(contours)).toBe("M 0 0 C 20 0 20 20 0 0 Z");
});

test("curve subdivision preserves raster output and moving anchors carries their handles", async () => {
  const node = path(),
    original = node.vectorPath.contours;
  const divided = splitVectorSegment(original, original[0].id, 0, "inserted");
  const raster = async (contours) =>
    sharp(
      Buffer.from(
        vectorSvg(
          { ...node, vectorPath: { ...node.vectorPath, contours, d: serializeContours(contours) } },
          {},
        ),
      ),
    )
      .resize(400, 400)
      .raw()
      .toBuffer();
  expect(await raster(divided)).toEqual(await raster(original));
  const p = original[0].points[0];
  const moved = moveVectorPoint(original, p.id, "anchor", { x: 20, y: 30 })[0].points[0];
  expect(moved.out).toEqual({ x: p.out.x + 10, y: p.out.y + 10 });
  const symmetric = setVectorPointMode(original, p.id, "symmetric");
  const edited = moveVectorPoint(symmetric, p.id, "out", { x: 40, y: 50 })[0].points[0];
  expect(edited.in).toEqual({ x: -20, y: -10 });
});

test("elliptical arc conversion matches SVG pixels within subpixel approximation", async () => {
  const d = "M90 50 A40 30 25 1 1 10 50 A40 30 25 1 1 90 50 Z";
  const contours = parsePathContours(d);
  const raster = (data) =>
    sharp(
      Buffer.from(
        `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200" viewBox="0 0 100 100"><path d="${data}" /></svg>`,
      ),
    )
      .ensureAlpha()
      .raw()
      .toBuffer();
  const a = await raster(d),
    b = await raster(serializeContours(contours));
  let difference = 0;
  for (let i = 3; i < a.length; i += 4) difference += Math.abs(a[i] - b[i]);
  expect(difference / (a.length / 4)).toBeLessThan(0.2);
});

test("assetless paths survive schema, patches, clipboard, component edits, and rendering", () => {
  const node = path(),
    source = parseDesignDocument({ ...blankDesignDocument(), nodes: [node] });
  const contours = moveVectorPoint(node.vectorPath.contours, "p2", "anchor", { x: 80, y: 30 });
  const vectorPath = { ...node.vectorPath, contours, d: serializeContours(contours) };
  expect(designNodeChangesSchema.parse({ vectorPath })).toEqual({ vectorPath });
  const changed = editLayers(source, ["path"], { vectorPath }),
    patch = diffDocument(source, changed);
  expect(applyDocumentPatch(source, patch).nodes[0].vectorPath).toEqual(vectorPath);
  expect(applyDocumentPatch(changed, invertPatch(patch))).toEqual(source);
  const copied = pasteLayers(
    blankDesignDocument(),
    readDesignClipboard(copyLayers(source, ["path"], "file")),
    { fileId: "file", pageId: "page-1", parentId: null, createId: () => "copy" },
  );
  expect(copied.document.nodes[0].vectorPath).toEqual(node.vectorPath);
  const master = makeComponent(source, "path"),
    instance = createComponentInstance(master, "path", () => "instance");
  const synced = editLayers(instance.document, ["path"], { vectorPath });
  expect(synced.nodes.find((n) => n.id === instance.rootId).vectorPath).toEqual(vectorPath);
  for (const component of [
    createElement(DocumentPreview, { content: changed, width: 200, height: 200 }),
    createElement(TidyDesign, { document: changed, rootId: "path" }),
  ])
    expect(renderToStaticMarkup(component)).toContain("data-vector-path");
  expect(() =>
    parseDesignDocument({
      ...source,
      nodes: [{ ...node, vectorPath: { ...node.vectorPath, d: "M0 0" } }],
    }),
  ).toThrow("Path data must match");
  expect(() =>
    parseDesignDocument({
      ...source,
      nodes: [
        {
          ...node,
          vectorPath: {
            ...node.vectorPath,
            contours: [...node.vectorPath.contours, ...node.vectorPath.contours],
          },
        },
      ],
    }),
  ).toThrow("unique contour/point IDs");
});

test("edited points beyond the original viewport remain visible without moving the layer", async () => {
  const node = path("M10 10 L90 10 L90 90 Z");
  const contours = moveVectorPoint(node.vectorPath.contours, "p2", "anchor", { x: 130, y: -20 });
  const edited = {
    ...node,
    vectorPath: { ...node.vectorPath, contours, d: serializeContours(contours) },
  };
  expect(vectorViewport(edited)).toEqual({ x: 0, y: -20, width: 130, height: 120 });
  expect(vectorImageStyle(edited)).toMatchObject({
    left: "0%",
    top: "-20%",
    width: "130%",
    height: "120%",
  });
  const { data, info } = await sharp(Buffer.from(vectorSvg(edited, {})))
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  expect(info.width).toBe(130);
  expect(info.height).toBe(120);
  expect(data[(10 * info.width + 110) * 4 + 3]).toBeGreaterThan(0);
  expect(edited.box).toEqual(node.box);
  const far = moveVectorPoint(contours, "p2", "anchor", { x: 99999, y: 0 });
  expect(() =>
    parseDesignDocument({
      ...blankDesignDocument(),
      nodes: [
        {
          ...edited,
          vectorPath: { ...edited.vectorPath, contours: far, d: serializeContours(far) },
        },
      ],
    }),
  ).toThrow("Editable path extents");
});
