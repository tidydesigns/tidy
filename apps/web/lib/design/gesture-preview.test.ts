import { expect, test } from "bun:test";
import { blankDesignDocument, buildDrawnNode, parseDesignDocument } from "./document";
import { editLayers, moveLayers, previewLayerChanges, previewMoveLayers } from "./edit-document";
import { createComponentInstance, makeComponent } from "./document-operations";

test("gesture previews match canonical movement through transformed ancestors and preserve unrelated nodes", () => {
  const parent = {
    ...buildDrawnNode("parent", "container", null, { x: 0, y: 0, width: 200, height: 100 }),
    style: { rotation: 30, flipX: true },
  };
  const child = buildDrawnNode("child", "container", "parent", {
    x: 10,
    y: 5,
    width: 40,
    height: 20,
  });
  const other = buildDrawnNode("other", "container", null, {
    x: 400,
    y: 0,
    width: 100,
    height: 100,
  });
  const document = parseDesignDocument({ ...blankDesignDocument(), nodes: [parent, child, other] });
  const next = previewMoveLayers(document, ["child"], 25, -12);
  expect(next).toEqual(moveLayers(document, ["child"], 25, -12));
  expect(next.nodes[0]).toBe(document.nodes[0]);
  expect(next.nodes[2]).toBe(document.nodes[2]);
  expect(document.nodes[1].box).toEqual(child.box);
});

test("resize previews retain constraints, component propagation and instance overrides", () => {
  const master = buildDrawnNode("master", "container", null, {
    x: 0,
    y: 0,
    width: 200,
    height: 100,
  });
  const child = {
    ...buildDrawnNode("child", "container", "master", { x: 100, y: 0, width: 40, height: 20 }),
    horizontalConstraint: "end" as const,
  };
  let document = makeComponent({ ...blankDesignDocument(), nodes: [master, child] }, "master");
  let index = 0;
  document = createComponentInstance(document, "master", () => `instance-${++index}`).document;
  const changes = { box: { width: 300 }, widthMode: "fixed" as const };
  const preview = previewLayerChanges(document, ["master"], changes);
  expect(preview).toEqual(editLayers(document, ["master"], changes));
  expect(preview.nodes.find((node) => node.id === "child")?.box.x).toBe(200);
  const instanceId = document.nodes.find(
    (node) => node.instanceOf && node.componentSourceId === "child",
  )!.id;
  const override = previewLayerChanges(document, [instanceId], { style: { fill: "#aabbcc" } });
  expect(override).toEqual(editLayers(document, [instanceId], { style: { fill: "#aabbcc" } }));
});

test("gesture previews reject invalid properties and respect inherited locks", () => {
  const parent = {
    ...buildDrawnNode("parent", "container", null, { x: 0, y: 0, width: 100, height: 100 }),
    locked: true,
  };
  const child = buildDrawnNode("child", "container", "parent", {
    x: 10,
    y: 10,
    width: 20,
    height: 20,
  });
  const document = parseDesignDocument({ ...blankDesignDocument(), nodes: [parent, child] });
  expect(previewMoveLayers(document, ["child"], 10, 20)).toEqual(document);
  expect(() => previewLayerChanges(document, ["parent"], { name: "Changed" } as never)).toThrow(
    "Invalid gesture preview",
  );
  expect(() =>
    previewLayerChanges({ ...document, nodes: [child] }, ["child"], { box: { width: Infinity } }),
  ).toThrow();
});

test("multi-selection previews match validated scaling and resizing", async () => {
  const { scaleLayers, resizeSelectedLayers } = await import("./layout-operations");
  const a = buildDrawnNode("a", "container", null, { x: 0, y: 0, width: 100, height: 100 });
  const b = buildDrawnNode("b", "container", null, { x: 150, y: 0, width: 100, height: 100 });
  const other = buildDrawnNode("other", "container", null, {
    x: 500,
    y: 0,
    width: 100,
    height: 100,
  });
  const document = parseDesignDocument({ ...blankDesignDocument(), nodes: [a, b, other] });
  const scaled = scaleLayers(document, ["a", "b"], 1.25, undefined, true);
  expect(scaled).toEqual(scaleLayers(document, ["a", "b"], 1.25));
  expect(scaled.nodes[2]).toBe(document.nodes[2]);
  const target = { x: 20, y: 10, width: 300, height: 120 };
  const resized = resizeSelectedLayers(document, ["a", "b"], target, undefined, true);
  expect(resized).toEqual(resizeSelectedLayers(document, ["a", "b"], target));
  expect(resized.nodes[2]).toBe(document.nodes[2]);
  expect(() =>
    resizeSelectedLayers(document, ["a", "b"], { ...target, width: Infinity }, undefined, true),
  ).toThrow();
});
