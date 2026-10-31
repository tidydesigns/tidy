import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Window } from "happy-dom";
import { CodeCell } from "./code-cell";

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
