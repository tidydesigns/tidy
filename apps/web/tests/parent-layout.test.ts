import { expect, test } from "bun:test";
import { buildDrawnNode } from "@tidy/design/document";
import { createParentLayouts } from "../../../packages/editor/src/editor/parent-layout";

const parent = buildDrawnNode("frame", "artboard", null, { x: 20, y: 30, width: 600, height: 400 });

test("parent render context excludes position and paint while retaining layout dependencies", () => {
  const cache = createParentLayouts();
  const before = cache.get(parent, 600);
  expect(
    cache.get(
      { ...parent, box: { ...parent.box, x: 150 }, style: { rotation: 45, fill: "#ffffff" } },
      600,
    ),
  ).toBe(before);
  for (const changed of [
    { ...parent, box: { ...parent.box, width: 700 } },
    { ...parent, style: { borderLeftWidth: 8 } },
    { ...parent, layout: "flex-row" as const },
    { ...parent, wrap: true, columnGap: 12 },
    { ...parent, vectorBoolean: "union" as const },
    { ...parent, mask: { enabled: true, sourceId: "source", mode: "alpha" as const } },
  ])
    expect(cache.get(changed, 600)).not.toBe(before);
});

test("responsive parent rules follow the containing frame width", () => {
  const cache = createParentLayouts();
  const responsive = {
    ...parent,
    responsiveBreakpoints: [
      { id: "narrow", frameMaxWidth: 500, layout: "flex-column" as const, gap: 12 },
    ],
  };
  expect(cache.get(responsive, 400)?.layout).toBe("flex-column");
  expect(cache.get(responsive, 800)?.layout).toBe("absolute");
  expect(cache.get(responsive, 400)?.gap).toBe(12);
  cache.remove(parent.id);
  expect(cache.get(undefined, 400)).toBeUndefined();
});
