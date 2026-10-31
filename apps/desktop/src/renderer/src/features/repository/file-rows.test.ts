import { expect, test } from "bun:test";
import { prepareFileRows, visibleTreeRows } from "./file-rows";
import type { RepositoryDirectory } from "../../../../shared/contracts/repository-files";

test("projects only expanded descendants with explicit virtual-tree accessibility positions", () => {
  const directories = new Map<string, RepositoryDirectory>([
    [
      "",
      {
        entries: [
          { path: "a", name: "a", kind: "directory" },
          { path: "z", name: "z", kind: "file" },
        ],
        limited: false,
      },
    ],
    ["a", { entries: [{ path: "a/b", name: "b", kind: "directory" }], limited: false }],
    ["a/b", { entries: [{ path: "a/b/c", name: "c", kind: "file" }], limited: false }],
  ]);
  expect(visibleTreeRows(directories, new Set()).map((row) => row.path)).toEqual(["a", "z"]);
  expect(
    visibleTreeRows(directories, new Set(["a", "a/b"])).map(
      ({ path, depth, position, siblings }) => ({ path, depth, position, siblings }),
    ),
  ).toEqual([
    { path: "a", depth: 1, position: 1, siblings: 2 },
    { path: "a/b", depth: 2, position: 1, siblings: 1 },
    { path: "a/b/c", depth: 3, position: 1, siblings: 1 },
    { path: "z", depth: 1, position: 2, siblings: 2 },
  ]);
});

test("aligns replacement blocks and preserves numbering across multiple hunks without Git headers", () => {
  const result = prepareFileRows({
    kind: "text",
    view: "diff",
    comparison: "head",
    text: "--- a/file\n+++ b/file\n@@ -2,3 +2,2 @@\n old\n-const x = 1;\n-extra\n+const x = 2;\n@@ -30,0 +31,1 @@\n++++ source\n",
  });
  const rows = result.rows.filter((row) => row.kind === "lines");
  expect(rows.map((row) => [row.before?.number ?? null, row.after?.number ?? null])).toEqual([
    [2, 2],
    [3, 3],
    [4, null],
    [null, 31],
  ]);
  expect(rows[1].before?.text).toBe("const x = 1;");
  expect(rows[1].after?.text).toBe("const x = 2;");
  expect(rows[1].before?.emphasis).toEqual([10, 11]);
  expect(rows[1].after?.emphasis).toEqual([10, 11]);
  expect(rows[3].after?.text).toBe("+++ source");
  expect(result.added).toBe(2);
  expect(result.removed).toBe(2);
  expect(result.rows[0].kind).toBe("hunk");
});

test("keeps newline markers on the correct side without breaking replacement alignment", () => {
  const { rows } = prepareFileRows({
    kind: "text",
    view: "diff",
    comparison: "head",
    text: "@@ -1 +1 @@\n-old\n\\ No newline at end of file\n+new\n\\ No newline at end of file\n",
  });
  const pair = rows.find((row) => row.kind === "lines");
  expect(pair?.before?.text).toBe("old");
  expect(pair?.after?.text).toBe("new");
  expect(rows.filter((row) => row.kind === "note").map((row) => row.side)).toEqual([
    "before",
    "after",
  ]);
});

test("new files have an empty baseline while unchanged and plain files use one column", () => {
  const input = { kind: "text", view: "file", text: "one\ntwo\n" } as const;
  for (const comparison of ["empty", "unborn"] as const) {
    const added = prepareFileRows({ ...input, comparison });
    expect(added.split).toBe(true);
    expect(added.added).toBe(2);
    expect(
      added.rows.every((row) => row.kind === "lines" && row.before === null && row.changed),
    ).toBe(true);
  }
  for (const comparison of ["head", "none"] as const) {
    const result = prepareFileRows({ ...input, comparison });
    expect(result.split).toBe(false);
    expect(result.added).toBe(0);
    expect(result.rows.every((row) => row.kind === "lines" && !row.changed)).toBe(true);
  }
});

test("bounds large previews and long lines explicitly", () => {
  const result = prepareFileRows({
    kind: "text",
    view: "file",
    comparison: "empty",
    text: "x".repeat(100000) + "\nshort\n".repeat(11000),
  });
  expect(result.limited).toBe(true);
  expect(result.longLines).toBe(true);
  expect(result.rows.length).toBe(20000);
  const row = result.rows[0];
  expect(row.kind === "lines" && row.after && row.after.text.length < 4100).toBe(true);
});

test("changed-text emphasis never splits a Unicode surrogate pair", () => {
  const result = prepareFileRows({
    kind: "text",
    view: "diff",
    comparison: "head",
    text: "@@ -1 +1 @@\n-label = '😀';\n+label = '😁';\n",
  });
  const row = result.rows.find((row) => row.kind === "lines");
  expect(row?.before?.emphasis).toEqual([9, 11]);
  expect(row?.after?.emphasis).toEqual([9, 11]);
});

test("clipping a long line does not leave an unpaired surrogate", () => {
  const text = "x".repeat(3999) + "😀" + "tail";
  const result = prepareFileRows({ kind: "text", view: "file", comparison: "none", text });
  const row = result.rows[0];
  expect(result.longLines).toBe(true);
  if (row.kind !== "lines" || !row.after) throw new Error("Expected a preview line.");
  expect(new TextDecoder().decode(new TextEncoder().encode(row.after.text))).toBe(row.after.text);
});

test("a missing-newline marker after shared context belongs to both versions", () => {
  const { rows } = prepareFileRows({
    kind: "text",
    view: "diff",
    comparison: "head",
    text: "@@ -1,2 +1,2 @@\n-old\n+new\n shared\n\\ No newline at end of file\n",
  });
  expect(rows.filter((row) => row.kind === "note")).toEqual([
    { kind: "note", text: "No newline at end of file", side: "both" },
  ]);
});

test("labels omitted context between hunks without inventing file contents", () => {
  const result = prepareFileRows({
    kind: "text",
    view: "diff",
    comparison: "head",
    text: "@@ -4,7 +4,7 @@\n a\n b\n c\n-before\n+after\n d\n e\n f\n@@ -32 +32 @@\n-next\n+last\n",
  });
  expect(result.rows.filter((row) => row.kind === "hunk")).toEqual([
    { kind: "hunk", before: 4, after: 4, hidden: 3 },
    { kind: "hunk", before: 32, after: 32, hidden: 21 },
  ]);
});
