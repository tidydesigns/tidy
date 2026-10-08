import { test, expect } from "bun:test";
import {
  blankDesignDocument,
  buildDrawnNode,
  type DesignDocument,
  type DesignNode,
} from "./document";
import { applyDocumentPatch, diffDocument } from "./document-patch";

const node = (id: string, x = 10) =>
  buildDrawnNode(id, "container", null, { x, y: 20, width: 100, height: 80 });
const fixture = (): DesignDocument => ({
  ...blankDesignDocument(),
  nodes: [node("a"), node("b", 200)],
});
const change = (
  doc: DesignDocument,
  id: string,
  transform: (node: DesignNode) => DesignNode,
): DesignDocument => ({
  ...doc,
  nodes: doc.nodes.map((node) => (node.id === id ? transform(node) : node)),
});

test("patch staging never mutates inputs, including on a failed transaction", () => {
  const freeze = <T>(value: T): T => {
    if (value && typeof value === "object") {
      Object.values(value).forEach(freeze);
      Object.freeze(value);
    }
    return value;
  };
  const base = freeze({ ...fixture(), tokens: { brand: "#ffffff" } });
  const next = {
    ...change(base, "a", (n) => ({ ...n, box: { ...n.box, x: 30 }, style: { radius: 8 } })),
    tokens: { brand: "#000000" },
  };
  const patch = freeze(diffDocument(base, next));
  const applied = applyDocumentPatch(base, patch);
  expect(applied).toEqual(next);
  applied.nodes[1].box.x = 999;
  expect(base.nodes[1].box.x).toBe(200);
  expect(() =>
    applyDocumentPatch(base, [
      ...patch,
      {
        collection: "nodes",
        id: "a",
        path: ["parentId"],
        before: { exists: true, value: null },
        after: { exists: true, value: "missing" },
      },
    ]),
  ).toThrow("has no parent");
  expect(base.nodes[0].box.x).toBe(10);
  expect(base.tokens.brand).toBe("#ffffff");
});

test("patch entity indexes follow reorders, deletions and creations within one transaction", () => {
  const base = fixture();
  const reordered = { ...base, nodes: [base.nodes[1], base.nodes[0]] };
  const deleted = { ...reordered, nodes: [reordered.nodes[0]] };
  const added = { ...deleted, nodes: [...deleted.nodes, node("c")] };
  const changed = change(added, "c", (n) => ({ ...n, name: "C" }));
  const final = change(changed, "b", (n) => ({ ...n, name: "B" }));
  const stages = [base, reordered, deleted, added, changed, final];
  const patch = stages.slice(1).flatMap((stage, index) => diffDocument(stages[index], stage));
  expect(applyDocumentPatch(base, patch)).toEqual(final);
});

test("an unrelated patch still rejects invalid untouched document data", () => {
  const base = fixture();
  const patch = diffDocument(
    base,
    change(base, "a", (n) => ({ ...n, name: "Changed" })),
  );
  base.nodes[1].box.width = -1;
  expect(() => applyDocumentPatch(base, patch)).toThrow();
});
