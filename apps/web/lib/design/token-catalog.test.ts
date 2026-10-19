import { describe, expect, test } from "bun:test";
import { blankDesignDocument, buildDrawnNode, parseDesignDocument } from "./document";
import { createAndBindColor, putDesignToken, unboundPageColors } from "./token-catalog";
import { removeDesignToken, renameDesignToken } from "./tokens";
import { resolvedColorTokens } from "./design-tokens";

const layer = (id: string) => ({
  ...buildDrawnNode(id, "container", null, { x: 0, y: 0, width: 100, height: 50 }),
  style: { fill: "#123456" },
});

describe("colors from design", () => {
  test("links exact unbound fills, strokes, gradient stops and text without replacing existing roles", () => {
    const document = parseDesignDocument({
      ...blankDesignDocument(),
      tokens: { existing: "#123456" },
      nodes: [
        layer("fill"),
        {
          ...layer("gradient"),
          style: {
            paints: [
              {
                id: "gradient",
                type: "linear",
                angle: 180,
                stops: [
                  { id: "a", position: 0, color: "#123456" },
                  { id: "b", position: 1, color: "#abcdef80" },
                ],
              },
            ],
            borderWidth: 2,
            borderColor: "#123456",
          },
        },
        { ...layer("text"), type: "text", text: "Hello", style: { color: "#123456" } },
        { ...layer("bound"), style: { fillToken: "existing" } },
        {
          ...layer("hidden-paint"),
          style: { paints: [{ id: "hidden", type: "solid", color: "#123456", visible: false }] },
        },
        { ...layer("locked"), locked: true },
        { ...layer("child"), parentId: "locked" },
        { ...layer("hidden"), visible: false },
        { ...layer("hidden-child"), parentId: "hidden" },
        layer("out-of-scope"),
      ],
    });
    const nodeIds = new Set(
      document.nodes.filter((node) => node.id !== "out-of-scope").map((node) => node.id),
    );
    expect(unboundPageColors(document, nodeIds)).toEqual([
      { color: "#123456", count: 3 },
      { color: "#abcdef80", count: 1 },
    ]);
    const linked = createAndBindColor({ document, nodeIds, color: "#123456", name: "brand" });
    const [fill, gradient, text, bound] = linked.nodes;
    expect(fill?.style.paints?.[0]).toMatchObject({
      type: "solid",
      color: "#123456",
      token: "brand",
    });
    expect(gradient?.style.paints?.[0]).toMatchObject({
      stops: [{ token: "brand" }, { color: "#abcdef80" }],
    });
    expect(gradient?.style.strokePaints?.[0]).toMatchObject({ token: "brand" });
    expect(text?.style.colorToken).toBe("brand");
    expect(bound).toEqual(document.nodes[3]);
    expect(linked.nodes.slice(4)).toEqual(document.nodes.slice(4));
    expect(unboundPageColors(linked, nodeIds)).toEqual([{ color: "#abcdef80", count: 1 }]);
    expect(document.nodes[0]?.style.paints).toBeUndefined();
    expect(
      createAndBindColor({ document: linked, nodeIds, color: "#123456", name: "unused" }),
    ).toBe(linked);
  });

  test("legacy tokens keep their references when edited, renamed and removed", () => {
    const document = parseDesignDocument({
      ...blankDesignDocument(),
      tokens: { ink: "#123456" },
      designTokens: { text: { type: "color", alias: "ink" } },
      nodes: [{ ...layer("card"), style: { fillToken: "ink" } }],
    });
    const edited = putDesignToken(document, "ink", { type: "color", value: "#22735980" });
    expect(edited.tokens).toEqual({});
    expect(resolvedColorTokens(edited)).toEqual({ ink: "#22735980", text: "#22735980" });
    const renamed = renameDesignToken(edited, "ink", "brand");
    expect(renamed.nodes[0]?.style.fillToken).toBe("brand");
    expect(renamed.designTokens?.text).toEqual({ type: "color", alias: "brand" });
    const removed = removeDesignToken(renamed, "brand");
    expect(removed.nodes[0]?.style.fill).toBe("#22735980");
    expect(removed.nodes[0]?.style.fillToken).toBeUndefined();
    expect(resolvedColorTokens(removed).text).toBe("#22735980");
  });

  test("rejects name collisions and invalid colors without mutating the document", () => {
    const document = parseDesignDocument({
      ...blankDesignDocument(),
      tokens: { ink: "#123456" },
      nodes: [layer("card")],
    });
    const args = { document, nodeIds: new Set(["card"]), color: "#123456", name: "brand" };
    expect(() => createAndBindColor({ ...args, name: "ink" })).toThrow("already exists");
    expect(() => createAndBindColor({ ...args, name: "bad name" })).toThrow("Use a letter");
    expect(() => createAndBindColor({ ...args, color: "red" })).toThrow("hex color");
    expect(document.designTokens).toBeUndefined();
    expect(document.nodes[0]?.style.fill).toBe("#123456");
  });
});
