import { expect, test } from "bun:test";
import { equalJsonValues, jsonValueKey } from "./json-value";

test("JSON equality preserves storage semantics without depending on property order", () => {
  const values: unknown[] = [
    undefined,
    null,
    true,
    false,
    0,
    -0,
    1,
    NaN,
    Infinity,
    "",
    "x",
    [],
    [null],
    [undefined],
    Array(1),
    [1, 2],
    [2, 1],
    {},
    { a: undefined },
    { a: null },
    { a: 1, b: 2 },
    { b: 2, a: 1 },
    { nested: { x: [1, { a: undefined, b: "x" }] } },
    { nested: { x: [1, { b: "x" }] } },
    { a: () => 1 },
    { a: Symbol("a") },
    Object.assign(Object.create(null), { a: 1 }),
    new Date("2026-01-01"),
    "2026-01-01T00:00:00.000Z",
    { toJSON: () => ({ a: 1 }) },
    { a: { toJSON: () => undefined } },
    JSON.parse('{"__proto__":{"x":1}}'),
    { constructor: "own" },
  ];
  for (const a of values)
    for (const b of values) {
      expect(equalJsonValues(a, b)).toBe(a === b || jsonValueKey(a) === jsonValueKey(b));
    }
});

test("nested JSON values compare identically after validation and JSONB reordering", () => {
  let seed = 139;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const value = (depth: number): unknown => {
    const choice = Math.floor(random() * (depth ? 6 : 4));
    if (choice === 0) return undefined;
    if (choice === 1) return null;
    if (choice === 2) return Math.floor(random() * 5);
    if (choice === 3) return `value-${Math.floor(random() * 5)}`;
    if (choice === 4) return Array.from({ length: 4 }, () => value(depth - 1));
    return Object.fromEntries(["a", "b", "c"].map((key) => [key, value(depth - 1)]));
  };
  const stored = (input: unknown) =>
    input === undefined
      ? undefined
      : JSON.parse(
          JSON.stringify(input, (_key, item) =>
            item && typeof item === "object" && !Array.isArray(item)
              ? Object.fromEntries(Object.entries(item).reverse())
              : item,
          ),
        );
  for (let i = 0; i < 500; i++) {
    const a = value(4),
      b = value(4);
    expect(equalJsonValues(a, stored(a))).toBe(true);
    expect(equalJsonValues(a, b)).toBe(jsonValueKey(a) === jsonValueKey(b));
  }
});
