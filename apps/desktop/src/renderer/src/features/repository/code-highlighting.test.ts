import { expect, test } from "bun:test";
import { prepareFileRows } from "./file-rows";
import { highlightFileRows } from "./code-highlighting";

test("colours both diff sides without changing source or emphasis ranges", () => {
  const result = prepareFileRows({
    kind: "text",
    view: "diff",
    comparison: "head",
    text: '@@ -1 +1 @@\n-const value = "old";\n+const value = "new";\n',
  });
  const before = structuredClone(result);
  highlightFileRows(result, "example.ts");
  expect(result.rows).toHaveLength(before.rows.length);
  for (const row of result.rows) {
    if (row.kind !== "lines") continue;
    for (const side of ["before", "after"] as const) {
      const line = row[side];
      expect(line?.tokens?.map((token) => token.text).join("")).toBe(line?.text);
      expect(line?.tokens?.some((token) => token.classes.includes("hljs-keyword"))).toBe(true);
      expect(line?.tokens?.some((token) => token.classes.includes("hljs-string"))).toBe(true);
    }
  }
  expect(
    result.rows.map((row) =>
      row.kind === "lines" ? [row.before?.emphasis, row.after?.emphasis] : null,
    ),
  ).toEqual(
    before.rows.map((row) =>
      row.kind === "lines" ? [row.before?.emphasis, row.after?.emphasis] : null,
    ),
  );
});
test("preserves untrusted markup and multiline strings as text tokens", () => {
  const text = '<script>alert("fixture")</script>\n<!-- comment\ncontinued -->';
  const result = prepareFileRows({ kind: "text", view: "file", comparison: "none", text });
  highlightFileRows(result, "example.html");
  expect(
    result.rows
      .map((row) =>
        row.kind === "lines" ? row.after?.tokens?.map((token) => token.text).join("") : "",
      )
      .join("\n"),
  ).toBe(text);
});
test("bounds highlighting and preserves unsupported file contents", () => {
  const result = prepareFileRows({
    kind: "text",
    view: "file",
    comparison: "none",
    text: "const value = 1;\n".repeat(12000),
  });
  highlightFileRows(result, "large.ts");
  const highlighted = result.rows.filter((row) => row.kind === "lines" && row.after?.tokens);
  expect(highlighted.length).toBeGreaterThan(0);
  expect(highlighted.length).toBeLessThan(5000);
  expect(result.rows.length).toBe(12000);
  const unsupported = prepareFileRows({
    kind: "text",
    view: "file",
    comparison: "none",
    text: "plain text",
  });
  highlightFileRows(unsupported, "file.unknown");
  expect(unsupported.rows).toEqual([
    { kind: "lines", before: null, after: { number: 1, text: "plain text" }, changed: false },
  ]);
});
