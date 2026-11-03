import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Window } from "happy-dom";
import { CodeCell, fileColumnRange } from "./code-cell";
import { prepareFileRows } from "./file-rows";

test("file columns preserve emoji and combined characters without inventing missing positions", () => {
  const line = { number: 1, text: "a👩🏽‍💻e\u0301z" };
  for (const column of [2, 3, 4, 5, 6, 7, 8]) expect(fileColumnRange(line, column)).toEqual([1, 8]);
  expect(fileColumnRange(line, 9)).toEqual([8, 10]);
  expect(fileColumnRange(line, 10)).toEqual([8, 10]);
  expect(fileColumnRange(line, 12)).toBeNull();
  expect(fileColumnRange({ number: 1, text: "" }, 1)).toBeNull();
  expect(fileColumnRange(line, 0)).toBeNull();
});

test("file columns exclude the preview clipping notice", () => {
  const prepared = prepareFileRows({
    kind: "text",
    view: "file",
    comparison: "none",
    text: "a".repeat(5000),
  });
  const row = prepared.rows[0];
  expect(row?.kind).toBe("lines");
  if (row?.kind !== "lines" || !row.after) throw new Error("Missing prepared file line");
  const line = row.after;
  expect(fileColumnRange(line, 4000)).toEqual([3999, 4000]);
  expect(fileColumnRange(line, 4001)).toBeNull();
  expect(fileColumnRange(line, 5000)).toBeNull();
});

test("file column markup contains the whole combined character", () => {
  const text = "a👩🏽‍💻e\u0301z";
  const output = renderToStaticMarkup(
    createElement(CodeCell, {
      side: "after",
      column: 3,
      row: { kind: "lines", changed: false, before: null, after: { number: 1, text } },
    }),
  );
  expect(output).toContain('<mark data-file-column="true">👩🏽‍💻</mark>');
});

test("renders highlighted source as text and preserves emphasis across token boundaries", async () => {
  const text = '<script>alert("value")</script>';
  const markup = renderToStaticMarkup(
    createElement(CodeCell, {
      side: "after",
      row: {
        kind: "lines",
        changed: true,
        before: null,
        after: {
          number: 1,
          text,
          emphasis: [6, 17],
          tokens: [
            { text: text.slice(0, 12), classes: "hljs-tag" },
            { text: text.slice(12), classes: "hljs-string" },
          ],
        },
      },
    }),
  );
  const window = new Window();
  try {
    window.document.body.innerHTML = markup;
    expect(window.document.querySelector("script")).toBeNull();
    expect(window.document.querySelector("code")?.textContent).toBe(text);
    expect(
      [...window.document.querySelectorAll("mark")].map((node) => node.textContent).join(""),
    ).toBe(text.slice(6, 17));
  } finally {
    await window.happyDOM.close();
  }
});
