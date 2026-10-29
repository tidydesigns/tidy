import { expect, test } from "bun:test";
import {
  blankDesignDocument,
  buildDrawnNode,
  parseDesignDocument,
  parseImmutableDesignDocument,
} from "./document";

function fixture() {
  return {
    ...blankDesignDocument(),
    nodes: [
      buildDrawnNode("a", "container", null, { x: 0, y: 0, width: 100, height: 100 }),
      buildDrawnNode("b", "container", "a", { x: 10, y: 10, width: 20, height: 20 }),
      buildDrawnNode("c", "text", null, { x: 200, y: 0, width: 100, height: 20 }),
    ],
  };
}

test("only parser-owned deeply immutable values are reused; mutable parsing stays independently owned", () => {
  const source = fixture();
  const first = parseImmutableDesignDocument(source);
  const second = parseImmutableDesignDocument(first);
  expect(second).toBe(first);
  expect(first.nodes[0]).not.toBe(source.nodes[0]);
  expect(Object.isFrozen(first.nodes[0].box)).toBe(true);
  expect(() => {
    first.nodes[0].box.width = -1;
  }).toThrow();
  source.nodes[0].box.width = -1;
  expect(() => parseImmutableDesignDocument(source)).toThrow();
  expect(() => parseImmutableDesignDocument(Object.freeze(source))).toThrow();
  const mutable = parseDesignDocument(first);
  mutable.nodes[0].box.width = 300;
  expect(first.nodes[0].box.width).toBe(100);
  expect(parseImmutableDesignDocument({ ...first, warnings: [] }).nodes[0]).toBe(first.nodes[0]);
});

test("equivalent transports reuse owned values without trusting colliding IDs or mutable sources", () => {
  const first = parseImmutableDesignDocument(fixture());
  const transported = structuredClone(first);
  const reused = parseImmutableDesignDocument(transported);
  expect(reused).toBe(first);
  expect(reused.tokens).toBe(first.tokens);
  transported.nodes[0].name = "Other file, same ID";
  const changed = parseImmutableDesignDocument(transported);
  expect(changed.nodes[0].name).toBe("Other file, same ID");
  expect(first.nodes[0].name).not.toBe(changed.nodes[0].name);
  transported.nodes[0].box.width = -1;
  expect(() => parseImmutableDesignDocument(transported)).toThrow();
  expect(() =>
    parseImmutableDesignDocument({
      ...first,
      nodes: [
        { ...first.nodes[0], style: { ...first.nodes[0].style, unexpected: undefined } },
        ...first.nodes.slice(1),
      ],
    }),
  ).toThrow();
});

test("cached nodes still undergo graph checks when dependencies or metadata change", () => {
  const first = parseImmutableDesignDocument(fixture());
  for (const invalid of [
    { ...first, pages: [{ id: "other", name: "Other" }] },
    { ...first, nodes: first.nodes.filter((node) => node.id !== "a") },
    { ...first, nodes: [...first.nodes, first.nodes[0]] },
    { ...first, unexpected: true },
  ]) {
    expect(() => parseDesignDocument(invalid)).toThrow();
    expect(() => parseImmutableDesignDocument(invalid)).toThrow();
  }
  const bound = parseImmutableDesignDocument({
    ...first,
    tokens: { brand: "#ffffff" },
    nodes: [{ ...first.nodes[0], style: { fillToken: "brand" } }, ...first.nodes.slice(1)],
  });
  // Typed bindings require a live token even when the node itself is cached.
  const typed = parseImmutableDesignDocument({
    ...bound,
    designTokens: { size: { type: "dimension", value: 12 } },
    nodes: [{ ...bound.nodes[0], tokenBindings: { width: "size" } }, ...bound.nodes.slice(1)],
  });
  expect(() => parseImmutableDesignDocument({ ...typed, designTokens: {} })).toThrow();
});

test("transported layer edits retain equal metadata without hiding metadata edits or invalid bindings", () => {
  const source = {
    ...fixture(),
    designTokens: { size: { type: "dimension", value: 12 } },
  };
  const first = parseImmutableDesignDocument(JSON.parse(JSON.stringify(source)));
  const incoming = JSON.parse(JSON.stringify(first));
  incoming.nodes[1].name = "Agent edit";
  const edited = parseImmutableDesignDocument(incoming);
  expect(edited.nodes[1].name).toBe("Agent edit");
  expect(edited.nodes[0]).toBe(first.nodes[0]);
  for (const key of ["pages", "tokens", "designTokens", "warnings", "editedNodeIds"] as const)
    expect(edited[key]).toBe(first[key]);
  incoming.pages[0].name = "Agent page";
  incoming.designTokens.size.value = 24;
  const metadata = parseImmutableDesignDocument(incoming);
  expect(metadata.pages).not.toBe(first.pages);
  expect(metadata.pages[0].name).toBe("Agent page");
  expect(metadata.designTokens.size.value).toBe(24);
  expect(first.designTokens.size.value).toBe(12);
  expect(first.pages[0].name).toBe("Page 1");
  // Reuse happens only after schema validation, and all graph checks still run.
  incoming.nodes[0].tokenBindings = { width: "size" };
  const bound = parseImmutableDesignDocument(incoming);
  expect(() => parseImmutableDesignDocument({ ...bound, designTokens: {} })).toThrow();
  incoming.pages[0].id = "missing-page";
  expect(() => parseImmutableDesignDocument(incoming)).toThrow();
});

test("immutable editor snapshots use the shared layer ceiling", () => {
  const source = {
    ...blankDesignDocument(),
    nodes: Array.from({ length: 10_000 }, (_, index) =>
      buildDrawnNode(`import-${index}`, "container", null, { x: 0, y: 0, width: 10, height: 10 }),
    ),
  };
  expect(parseDesignDocument(source).nodes).toHaveLength(10_000);
  const parsed = parseImmutableDesignDocument(source);
  expect(parsed.nodes).toHaveLength(10_000);
  expect(parseImmutableDesignDocument(parsed)).toBe(parsed);
  const oversized = {
    ...source,
    nodes: [
      ...source.nodes,
      buildDrawnNode("extra", "container", null, { x: 0, y: 0, width: 10, height: 10 }),
    ],
  };
  expect(() => parseDesignDocument(oversized)).toThrow();
  expect(() => parseImmutableDesignDocument(oversized)).toThrow();
});
