import { expect, test } from "bun:test";
import { blankDesignDocument, buildDrawnNode, type DesignNode } from "./document";
import { copyLayers, pasteLayers, readDesignClipboard } from "./clipboard";
import { reparentLayer, relocateLayer } from "./document-operations";
import { applyDocumentPatch, diffDocument, invertPatch } from "./document-patch";
import { rotatePoint } from "./resize-box";
import { resolveVariantNodes } from "./component-variants";
import { editLayers } from "./edit-document";

const layer = (id: string, parentId: string | null = null) =>
  buildDrawnNode(id, "container", parentId, { x: 30, y: 40, width: 100, height: 50 });
// Independent forward projection of each corner through the rendered ancestors.
function corners(
  nodes: DesignNode[],
  node: DesignNode,
  measured = new Map<string, DesignNode["box"]>(),
) {
  const box = measured.get(node.id) ?? node.box;
  return [
    [0, 0],
    [box.width, 0],
    [box.width, box.height],
    [0, box.height],
  ].map(([x, y]) => {
    let point = { x, y },
      current: DesignNode | undefined = node;
    while (current) {
      const b = measured.get(current.id) ?? current.box;
      point = rotatePoint(
        {
          x: (point.x - b.width / 2) * (current.style.flipX ? -1 : 1),
          y: (point.y - b.height / 2) * (current.style.flipY ? -1 : 1),
        },
        current.style.rotation ?? 0,
      );
      point = { x: point.x + b.x + b.width / 2, y: point.y + b.y + b.height / 2 };
      current = nodes.find((item) => item.id === current?.parentId);
      if (current)
        point = {
          x: point.x + (current.style.borderLeftWidth ?? current.style.borderWidth ?? 0),
          y: point.y + (current.style.borderTopWidth ?? current.style.borderWidth ?? 0),
        };
    }
    return point;
  });
}
function sameCorners(a: ReturnType<typeof corners>, b: ReturnType<typeof corners>, offset = 0) {
  a.forEach((point, i) => {
    expect(b[i].x).toBeCloseTo(point.x + offset, 6);
    expect(b[i].y).toBeCloseTo(point.y + offset, 6);
  });
}

test("nested rotated/flipped clipboard roots preserve all visual corners across pages and files", () => {
  for (const angle of [0, 37, 90, -130])
    for (const flip of [false, true]) {
      const outer = { ...layer("outer"), style: { rotation: angle, flipX: flip, borderWidth: 3 } };
      const inner = { ...layer("inner", "outer"), style: { rotation: -25, flipY: true } };
      const node = { ...layer("copied", "inner"), style: { rotation: 13, fill: "#123456" } };
      const source = { ...blankDesignDocument(), nodes: [outer, inner, node] };
      const payload = readDesignClipboard(copyLayers(source, [node.id], "source"))!;
      const parent = {
        ...layer("destination"),
        style: { rotation: -60, flipY: flip, borderLeftWidth: 7, borderTopWidth: 2 },
      };
      const target = { ...blankDesignDocument(), nodes: [parent] };
      for (const inPlace of [true, false]) {
        const pasted = pasteLayers(target, payload, {
          fileId: "target",
          pageId: "page-1",
          parentId: parent.id,
          inPlace,
          createId: () => "paste",
        });
        sameCorners(
          corners(source.nodes, node),
          corners(pasted.document.nodes, pasted.document.nodes[1]),
          inPlace ? 0 : 24,
        );
        const patch = diffDocument(target, pasted.document);
        expect(applyDocumentPatch(pasted.document, invertPatch(patch))).toEqual(target);
      }
    }
});

test("measured flow/fill placement survives copy, same-file paste and reparent into a flow", () => {
  const parent = { ...layer("parent"), layout: "flex-column" as const, style: { rotation: 35 } };
  const child = { ...layer("child", parent.id), widthMode: "fill" as const };
  const target = { ...layer("target"), layout: "flex-row" as const, style: { rotation: -20 } };
  const source = { ...blankDesignDocument(), nodes: [parent, child, target] };
  const measurements = new Map([
    [parent.id, { x: 100, y: 200, width: 400, height: 300 }],
    [child.id, { x: 24, y: 90, width: 352, height: 60 }],
    [target.id, { x: 600, y: 40, width: 500, height: 250 }],
  ]);
  const payload = readDesignClipboard(copyLayers(source, [child.id], "file", measurements))!;
  const pasted = pasteLayers(source, payload, {
    fileId: "file",
    pageId: "page-1",
    parentId: target.id,
    inPlace: true,
    boxes: measurements,
    createId: () => "pasted",
  });
  const node = pasted.document.nodes.at(-1)!;
  expect(node).toMatchObject({
    positionMode: "absolute",
    widthMode: "fixed",
    box: { width: 352, height: 60 },
  });
  sameCorners(
    corners(source.nodes, child, measurements),
    corners(pasted.document.nodes, node, measurements),
  );
  const moved = reparentLayer(source, child.id, target.id, measurements);
  const movedMeasurements = new Map(measurements);
  movedMeasurements.delete(child.id);
  sameCorners(
    corners(source.nodes, child, measurements),
    corners(moved.nodes, moved.nodes[1], movedMeasurements),
  );
  expect(applyDocumentPatch(moved, invertPatch(diffDocument(source, moved)))).toEqual(source);
});

test("tree reparent rejects hidden ancestry and cycles and preserves transformed geometry", () => {
  const parent = { ...layer("parent"), style: { rotation: 90 } },
    child = layer("child", parent.id);
  const other = { ...layer("other"), style: { rotation: -45, flipY: true } };
  const source = { ...blankDesignDocument(), nodes: [parent, child, other] };
  const moved = relocateLayer(source, child.id, other.id, "inside");
  sameCorners(
    corners(source.nodes, child),
    corners(
      moved.nodes,
      moved.nodes.find((node) => node.id === child.id)!,
    ),
  );
  expect(() => reparentLayer(source, parent.id, child.id)).toThrow("itself");
  expect(() =>
    reparentLayer(
      {
        ...source,
        nodes: source.nodes.map((node) =>
          node.id === other.id ? { ...node, visible: false } : node,
        ),
      },
      child.id,
      other.id,
    ),
  ).toThrow("unlocked");
});

test("clipboard preserves the selected component variant and explicit overrides in a transformed parent", () => {
  const parent = { ...layer("parent"), style: { rotation: 70, flipY: true } };
  const master: DesignNode = {
    ...layer("master"),
    isComponent: true,
    variants: {
      default: "regular",
      options: {
        regular: {},
        alternate: {
          root: { style: { rotation: 25, flipY: true, fill: "#ff0000" }, box: { width: 150 } },
        },
      },
    },
  };
  const instance: DesignNode = {
    ...layer("instance", parent.id),
    instanceOf: master.id,
    componentSourceId: master.id,
    variant: "alternate",
    instanceOverrides: ["style.fill"],
    style: { fill: "#0000ff" },
  };
  const source = { ...blankDesignDocument(), nodes: [parent, master, instance] };
  const rendered = resolveVariantNodes(source.nodes),
    visible = rendered[2];
  const payload = readDesignClipboard(
    copyLayers(source, [instance.id], "file", new Map([[instance.id, visible.box]])),
  )!;
  const pasted = pasteLayers(source, payload, {
    fileId: "file",
    pageId: "page-1",
    parentId: null,
    inPlace: true,
    createId: () => "pasted",
  });
  const after = resolveVariantNodes(pasted.document.nodes);
  sameCorners(corners(rendered, visible), corners(after, after.at(-1)!));
  expect(after.at(-1)?.style.fill).toBe("#0000ff");
  const edited = editLayers(pasted.document, [master.id], { style: { fill: "#00ff00" } });
  expect(resolveVariantNodes(edited.nodes).at(-1)?.style.fill).toBe("#0000ff");
  const detached = pasteLayers(blankDesignDocument(), payload, {
    fileId: "another",
    pageId: "page-1",
    parentId: null,
    inPlace: true,
    createId: () => "detached",
  });
  sameCorners(
    corners(rendered, visible),
    corners(detached.document.nodes, detached.document.nodes[0]),
  );
  expect(detached.document.nodes[0].instanceOf).toBeUndefined();
  const reparented = reparentLayer(source, instance.id, null);
  const moved = resolveVariantNodes(reparented.nodes);
  sameCorners(corners(rendered, visible), corners(moved, moved[2]));
});

test("paste uses the destination's selected variant transform", () => {
  const source = { ...blankDesignDocument(), nodes: [layer("source")] };
  const parent: DesignNode = {
    ...layer("target"),
    isComponent: true,
    variants: {
      default: "rotated",
      options: {
        rotated: { root: { style: { rotation: 65, flipX: true } } },
      },
    },
  };
  const target = { ...blankDesignDocument(), nodes: [parent] };
  const payload = readDesignClipboard(copyLayers(source, ["source"], "source-file"))!;
  const pasted = pasteLayers(target, payload, {
    fileId: "target-file",
    pageId: "page-1",
    parentId: parent.id,
    inPlace: true,
    createId: () => "paste",
  });
  const rendered = resolveVariantNodes(pasted.document.nodes);
  sameCorners(corners(source.nodes, source.nodes[0]), corners(rendered, rendered[1]));
});
