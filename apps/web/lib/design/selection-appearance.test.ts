import { describe, expect, test } from "bun:test";
import { blankDesignDocument, buildDrawnNode, type DesignNode } from "./document";
import { editLayers, moveLayers, duplicateLayers, trackDocumentChanges } from "./edit-document";
import { createComponentInstance, makeComponent, alignLayers } from "./document-operations";
import { nodeStyle, imageStyle } from "./node-style";

const rectangle = (id: string, parentId: string | null = null) =>
  buildDrawnNode(id, "container", parentId, { x: 10, y: 20, width: 100, height: 60 });
const fixture = () => ({ ...blankDesignDocument(), nodes: [rectangle("one"), rectangle("two")] });
describe("selection and appearance", () => {
  test("selected ancestors move and duplicate once; locked descendants stay protected", () => {
    const parent = rectangle("parent");
    const child = rectangle("child", "parent");
    const locked = { ...rectangle("locked"), locked: true };
    const content = { ...blankDesignDocument(), nodes: [parent, child, locked] };
    const moved = moveLayers(content, ["parent", "child", "locked"], 10, 5);
    expect(moved.nodes[0].box).toMatchObject({ x: 20, y: 25 });
    expect(moved.nodes[1].box).toEqual(child.box);
    expect(moved.nodes[2].box).toEqual(locked.box);
    let index = 0;
    const copied = duplicateLayers(content, ["parent", "child", "locked"], () => `copy-${++index}`);
    expect(copied.ids).toHaveLength(1);
    expect(copied.document.nodes).toHaveLength(5);
    expect(
      editLayers({ ...content, nodes: [{ ...parent, locked: true }, child] }, ["child"], {
        style: { radius: 20 },
      }).nodes[1].style.radius,
    ).toBeUndefined();
  });

  test("bulk edits preserve independent dimensions and component overrides", () => {
    let content = makeComponent(
      { ...blankDesignDocument(), nodes: [rectangle("master")] },
      "master",
    );
    let id = 0;
    const copy = createComponentInstance(content, "master", () => `instance-${++id}`);
    content = editLayers(copy.document, [copy.rootId], { style: { radiusTopLeft: 6 } });
    content = editLayers(content, ["master"], {
      style: { radiusTopLeft: 16, radiusBottomLeft: 8 },
    });
    expect(content.nodes.find((node) => node.id === copy.rootId)!.style).toMatchObject({
      radiusTopLeft: 6,
      radiusBottomLeft: 8,
    });
    expect(content.nodes.find((node) => node.id === copy.rootId)!.box.x).toBe(34);
    expect(editLayers(content, ["master"], { box: { width: 200 } }).nodes[0].box).toMatchObject({
      x: 10,
      y: 20,
      width: 200,
      height: 60,
    });
  });

  test("existing styles remain compatible while independent controls override only their side", () => {
    const node: DesignNode = {
      ...rectangle("one"),
      padding: 12,
      paddingLeft: 24,
      style: {
        radius: 8,
        radiusTopLeft: 16,
        borderWidth: 0,
        borderBottomWidth: 1,
        borderColor: "#ff0000",
        shadows: [
          { x: 0, y: 2, blur: 8, spread: -1, color: "#00000033", inset: false, visible: true },
        ],
      },
    };
    const style = nodeStyle(node, "absolute", {});
    expect(style.borderRadius).toBe("16px 8px 8px 8px");
    expect(style.borderTopWidth).toBe(0);
    expect(style.borderBottomWidth).toBe(1);
    expect(style).toMatchObject({
      paddingTop: 12,
      paddingRight: 12,
      paddingBottom: 12,
      paddingLeft: 24,
    });
    expect(style.boxShadow).toBe("0px 2px 8px -1px #00000033");
    expect(
      imageStyle({
        ...node,
        style: { objectFit: "cover", objectPositionX: 20, objectPositionY: 70, objectScale: 2 },
      }),
    ).toMatchObject({ objectPosition: "20% 70%", transform: "scale(2)" });
  });

  test("fill grows on the parent's main axis and stretches on its cross axis", () => {
    const node: DesignNode = {
      ...rectangle("child", "parent"),
      widthMode: "fill",
      heightMode: "fill",
    };
    expect(nodeStyle(node, "flex-column", {})).toMatchObject({
      flex: "1 1 0px",
      alignSelf: "stretch",
      minHeight: 0,
    });
    expect(nodeStyle(node, "flex-row", {})).toMatchObject({
      flex: "1 1 0px",
      alignSelf: "stretch",
      minWidth: 0,
    });
    expect(nodeStyle({ ...node, positionMode: "absolute" }, "flex-column", {})).toMatchObject({
      position: "absolute",
      left: 10,
      top: 20,
    });
  });

  test("parent alignment respects independent padding", () => {
    const parent = {
      ...rectangle("parent"),
      box: { x: 0, y: 0, width: 300, height: 200 },
      padding: 12,
      paddingLeft: 24,
    };
    const document = { ...blankDesignDocument(), nodes: [parent, rectangle("child", "parent")] };
    expect(alignLayers(document, ["child"], "left").nodes[1].box.x).toBe(24);
    expect(alignLayers(document, ["child"], "center-x").nodes[1].box.x).toBe(106);
  });

  test("bulk edits and deletion retain imported ownership", () => {
    const before = {
      ...fixture(),
      nodes: fixture().nodes.map((node) => ({ ...node, importKey: "import", sourceKey: node.id })),
    };
    const after = {
      ...editLayers(before, ["one"], { style: { radius: 8 } }),
      nodes: editLayers(before, ["one"], { style: { radius: 8 } }).nodes.filter(
        (node) => node.id !== "two",
      ),
    };
    const tracked = trackDocumentChanges(before, after);
    expect(tracked.editedNodeIds).toEqual(["one"]);
    expect(tracked.deletedSourceKeys).toEqual([{ importKey: "import", sourceKey: "two" }]);
  });
});
test("moving a layer converts world movement through rotated and flipped ancestors", () => {
  const parent = { ...rectangle("parent"), style: { rotation: 90, flipX: true } };
  const child = rectangle("child", "parent");
  const doc = { ...fixture(), nodes: [parent, child] };
  const next = moveLayers(doc, ["child"], 10, 20).nodes.find((node) => node.id === "child")!;
  expect(next.box.x).toBeCloseTo(child.box.x - 20, 8);
  expect(next.box.y).toBeCloseTo(child.box.y - 10, 8);
});
