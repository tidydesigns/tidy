import { describe, expect, test } from "bun:test";
import { buildDrawnNode, type DesignNode } from "./document";
import { vectorMaskSource, vectorMaskSources } from "./vector-relationships";

const node = (id: string, parentId: string | null = null): DesignNode =>
  buildDrawnNode(id, "container", parentId, { x: 0, y: 0, width: 20, height: 20 });

describe("batched vector mask eligibility", () => {
  test("matches single-candidate evaluation for nested, painted, empty, image and vector candidates", () => {
    const root = node("root");
    root.style = {};
    const child = node("child", "root");
    const empty = node("empty");
    empty.style = {};
    const vector = {
      ...node("vector"),
      type: "vector" as const,
      vectorPath: {
        d: "M0 0H20V20Z",
        viewBox: { x: 0, y: 0, width: 20, height: 20 },
        fillRule: "nonzero" as const,
      },
    };
    const image = node("image");
    image.style.paints = [
      {
        id: "image-fill",
        type: "image",
        fit: "cover",
        positionX: 50,
        positionY: 50,
        assetId: "00000000-0000-4000-8000-000000000001",
        opacity: 1,
        visible: true,
      },
    ];
    const invalidRoot = node("invalid-root");
    const text = { ...node("text", "invalid-root"), type: "text" as const, text: "Text" };
    const flow = { ...node("flow"), layout: "flex-row" as const };
    const nodes = [root, child, empty, vector, image, invalidRoot, text, flow];
    const candidates = [flow, vector, invalidRoot, root, empty, child, image];
    expect(vectorMaskSources(candidates, nodes)).toEqual(
      candidates.filter((candidate) => vectorMaskSource(candidate, nodes)),
    );
    expect(vectorMaskSources(candidates, nodes).map((candidate) => candidate.id)).toEqual([
      "vector",
      "root",
      "child",
    ]);
    expect(vectorMaskSources([], nodes)).toEqual([]);
  });
  test("uses rendered candidate styles and reflects mutable inputs on the next call", () => {
    const stored = node("stored");
    stored.style = {};
    const painted = { ...stored, style: { fill: "#123456" } };
    const nodes = [stored];
    expect(vectorMaskSources([painted], nodes)).toEqual([painted]);
    expect(vectorMaskSources([stored], nodes)).toEqual([]);
    nodes.push(node("child", stored.id));
    expect(vectorMaskSources([stored], nodes)).toEqual([stored]);
    nodes[1].type = "text";
    expect(vectorMaskSources([stored], nodes)).toEqual([]);
  });
  test("matches recursive reference results across many small changing hierarchies", () => {
    const nodes = Array.from({ length: 200 }, (_, index) =>
      node(`node-${index}`, index ? `node-${Math.floor((index - 1) / 3)}` : null),
    );
    for (let turn = 0; turn < 60; turn++) {
      const changed = nodes[(turn * 17) % nodes.length];
      changed.style = turn % 2 ? {} : { fill: "#abcdef" };
      changed.type = turn % 3 ? "container" : "text";
      const candidates = nodes.filter((_, index) => (index + turn) % 5 === 0);
      expect(vectorMaskSources(candidates, nodes)).toEqual(
        candidates.filter((candidate) => vectorMaskSource(candidate, nodes)),
      );
    }
  });
});
