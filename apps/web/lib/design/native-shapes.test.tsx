import { test, expect } from "bun:test";
import sharp from "sharp";
import { renderToStaticMarkup } from "react-dom/server";
import { buildNativeShape, nativeShapePath, shapeKinds } from "@bella/design/native-shapes";
import {
  blankDesignDocument,
  parseDesignDocument,
  designNodeChangesSchema,
  documentAssetIds,
} from "./document";
import { vectorSvg } from "./vector-path";
import { diffDocument, applyDocumentPatch, invertPatch } from "./document-patch";
import { mergeImport } from "./merge-import";
import { copyLayers, readDesignClipboard, pasteLayers } from "./clipboard";
import { createComponentInstance, makeComponent } from "./document-operations";
import { syncComponentEdit } from "./component-sync";
import { DocumentPreview } from "@/app/files/thumbnail-renderer";
import { DesignSnapshot } from "@/components/github/design-snapshot";
import { TidyDesign } from "./code-runtime";

const box = { x: 0, y: 0, width: 100, height: 100 };
for (const kind of shapeKinds) {
  test(`${kind}: geometry survives reopen, clipboard, patches, resize/rotation and undo without assets`, () => {
    const empty = blankDesignDocument();
    const node = buildNativeShape(kind, { kind }, null, box);
    const document = parseDesignDocument({ ...empty, nodes: [node] });
    expect(documentAssetIds(document)).toEqual([]);
    const imported = mergeImport(
      empty,
      {
        ...document,
        nodes: document.nodes.map((item) => ({
          ...item,
          importKey: "shapes:/",
          sourceKey: item.id,
        })),
      },
      "import",
    );
    expect(imported.nodes[0].vectorPath).toEqual(node.vectorPath);
    expect(parseDesignDocument(JSON.parse(JSON.stringify(document)))).toEqual(document);
    const creation = diffDocument(empty, document);
    expect(applyDocumentPatch(document, invertPatch(creation))).toEqual(empty);
    const changed = parseDesignDocument({
      ...document,
      nodes: [
        {
          ...document.nodes[0],
          box: { ...box, width: 200, height: 80 },
          style: { ...node.style, rotation: 37 },
        },
      ],
    });
    const gesture = diffDocument(document, changed);
    expect(applyDocumentPatch(document, gesture)).toEqual(changed);
    expect(applyDocumentPatch(changed, invertPatch(gesture))).toEqual(document);
    const clipboard = readDesignClipboard(copyLayers(changed, [kind], "source"));
    if (!clipboard || clipboard.kind !== "layers") throw new Error("Missing layers");
    const pasted = pasteLayers(empty, clipboard, {
      fileId: "target",
      pageId: "page-1",
      parentId: null,
      createId: () => "copy",
    });
    expect(pasted.document.nodes[0].vectorPath).toEqual(node.vectorPath);
  });

  test(`${kind}: shared preview, review and export render native geometry with decoded pixels`, async () => {
    const node = buildNativeShape(kind, { kind }, null, box);
    const document = parseDesignDocument({ ...blankDesignDocument(), nodes: [node] });
    const svg = vectorSvg(node, {});
    const uri = `data:image/svg+xml,${encodeURIComponent(svg)}`;
    for (const element of [
      <DocumentPreview key="preview" content={document} />,
      <DesignSnapshot
        key="review"
        content={document}
        frameId={kind}
        reviewId="review"
        selectedNode={null}
        onSelect={() => {}}
      />,
      <TidyDesign key="export" document={document} rootId={kind} assets={{}} />,
    ]) {
      expect(renderToStaticMarkup(element)).toContain(uri);
    }
    const { data, info } = await sharp(Buffer.from(svg))
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const alpha = (x: number, y: number) => data[(y * info.width + x) * 4 + 3];
    expect(alpha(Math.floor(info.width / 2), Math.floor(info.height / 2))).toBeGreaterThan(0);
    expect(alpha(0, 0)).toBe(0);
    for (const format of ["png", "webp"] as const) {
      const encoded = await sharp(Buffer.from(svg))[format]().toBuffer();
      const decoded = await sharp(encoded).metadata();
      expect(decoded.width).toBe(info.width);
      expect(decoded.height).toBe(info.height);
    }
  });
}

test("shape parameters propagate to instances while explicit overrides survive", () => {
  const node = buildNativeShape("star", { kind: "star" }, null, box);
  const master = makeComponent({ ...blankDesignDocument(), nodes: [node] }, node.id);
  const instance = createComponentInstance(master, node.id, () => "instance");
  const patch = designNodeChangesSchema.parse({
    vectorPath: nativeShapePath({ kind: "star", points: 8, innerRadius: 0.25 }),
  });
  const updated = syncComponentEdit(instance.document.nodes, node.id, patch);
  expect(updated[1].vectorPath?.shape?.points).toBe(8);
  const override = syncComponentEdit(updated, "instance", {
    vectorPath: nativeShapePath({ kind: "star", points: 4 }),
  });
  const next = syncComponentEdit(override, node.id, {
    vectorPath: nativeShapePath({ kind: "star", points: 6 }),
  });
  expect(next[1].vectorPath?.shape?.points).toBe(4);
  expect(() =>
    designNodeChangesSchema.parse({ vectorPath: nativeShapePath({ kind: "star", points: 100 }) }),
  ).toThrow();
});

test("line geometry respects drawing direction and exact horizontal/vertical axes", () => {
  expect(nativeShapePath({ kind: "arrow", reverseX: true }).d).toBe("M100 0L0 100");
  expect(nativeShapePath({ kind: "line" }, { ...box, height: 1 }).d).toBe("M0 0.5L100 0.5");
  expect(nativeShapePath({ kind: "line" }, { ...box, width: 1 }).d).toBe("M0.5 0L0.5 100");
  const node = buildNativeShape("star", { kind: "star" }, null, box);
  const updated = {
    ...node,
    vectorPath: { ...node.vectorPath!, shape: { kind: "star" as const, points: 8 } },
  };
  expect(vectorSvg(updated, {})).toContain(nativeShapePath({ kind: "star", points: 8 }).d);
});
