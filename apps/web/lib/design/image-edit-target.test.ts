import { imageAdjustmentsSchema } from "./document";
import { describe, expect, test } from "bun:test";
import { buildDrawnNode, parseDesignDocument, blankDesignDocument } from "./document";
import { imageEditChanges, imageEditNode } from "./image-edit-target";
import { imageAdjustmentFilter } from "@bella/design/image-adjustments";
const assetId = "00000000-0000-4000-8000-000000000001";
const node = {
  ...buildDrawnNode("photo", "container", null, { x: 0, y: 0, width: 100, height: 100 }),
  assetId,
};
describe("image adjustments", () => {
  test("accepts old documents and rejects out-of-range or unexpected controls", () => {
    expect(
      parseDesignDocument({ ...blankDesignDocument(), nodes: [node] }).nodes[0].style
        .imageAdjustments,
    ).toBeUndefined();
    expect(imageAdjustmentsSchema.safeParse({ exposure: 1.01 }).success).toBe(false);
    expect(imageAdjustmentsSchema.safeParse({ tint: NaN }).success).toBe(false);
    expect(imageAdjustmentsSchema.safeParse({ filter: "url(external)" }).success).toBe(false);
  });
  test("edits a fill by identity after reordering without changing its neighbour", () => {
    const first = {
      id: "first",
      type: "image" as const,
      assetId,
      opacity: 1,
      visible: true,
      fit: "cover" as const,
      positionX: 50,
      positionY: 50,
    };
    const second = { ...first, id: "second", adjustments: { tint: 0.4 } };
    const current = { ...node, style: { paints: [second, first] } };
    const patch = imageEditChanges(
      current,
      { nodeId: node.id, paintId: "second" },
      { adjustments: { contrast: 0.2 } },
    );
    expect(patch.style?.paints?.[1]).toEqual(first);
    expect(patch.style?.paints?.[0]).toMatchObject({ adjustments: { tint: 0.4, contrast: 0.2 } });
    expect(
      imageEditChanges(
        current,
        { nodeId: node.id, paintId: "deleted" },
        { adjustments: { exposure: 1 } },
      ),
    ).toEqual({});
  });
  test("image edits preserve layer effects and concurrent adjustment values", () => {
    const current = { ...node, style: { brightness: 70, imageAdjustments: { shadows: 0.2 } } };
    expect(
      imageEditChanges(current, { nodeId: node.id }, { adjustments: { exposure: 0.5 } }),
    ).toEqual({ style: { imageAdjustments: { shadows: 0.2, exposure: 0.5 } } });
    expect(imageEditNode(current, { nodeId: "other" })).toBeUndefined();
  });
  test("tone filters use luminance masks and alpha-preserving composition", () => {
    const filter = imageAdjustmentFilter("test", { highlights: -0.4, shadows: 0.5 });
    expect(filter).toContain("0.2126 0.7152 0.0722");
    expect(filter.match(/operator="atop"/g)).toHaveLength(2);
    expect(filter).toContain('flood-color="black"');
    expect(filter).toContain('flood-color="white"');
  });
});
