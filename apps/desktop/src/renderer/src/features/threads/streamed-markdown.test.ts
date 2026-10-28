import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { remarkCompleteBlocks } from "./streamed-markdown";

function render(text: string, streaming = true, minimum = 0) {
  return renderToStaticMarkup(
    createElement(Markdown, {
      children: text,
      remarkPlugins: [remarkGfm, [remarkCompleteBlocks, { text, streaming, minimum }]],
      skipHtml: true,
    }),
  );
}

describe("streamed Markdown sections", () => {
  test("holds partial paragraphs and releases separated paragraphs", () => {
    expect(render("A **partial")).toBe("");
    expect(render("A **complete** paragraph.\n\n")).toContain("<strong>complete</strong>");
  });

  test("holds headings until content can accompany them", () => {
    const prefix = "Earlier paragraph.\n\n## Details\n\n";
    expect(render(prefix)).not.toContain("<h2>");
    expect(render(prefix + "An unfinished paragraph")).not.toContain("<h2>");
    expect(render(prefix + "A finished paragraph.\n\n")).toContain("<h2>Details</h2>");
  });

  test("reveals completed list items while holding the last partial item", () => {
    const html = render("## Details\n\n- First item\n- Unfinished");
    expect(html).toContain("<h2>Details</h2>");
    expect(html).toContain("<li>First item</li>");
    expect(html).not.toContain("Unfinished");
    expect(render("- First item\n- Second item\n\n")).toContain("<li>Second item</li>");
  });

  test("holds fenced code until its closing fence arrives", () => {
    const fence = "```css\n.item {\n  color: red;";
    expect(render(fence)).toBe("");
    expect(render(fence + "\n}\n```")).toContain("color: red;");
    expect(render("~~~text\r\nComplete code\r\n~~~~")).toContain("Complete code");
  });

  test("keeps blank lines inside an unfinished code fence hidden", () => {
    const prefix = "A complete paragraph.\n\n";
    const fence = "```ts\nconst value = 1;\n\n";
    expect(render(prefix + fence)).toBe("<p>A complete paragraph.</p>");
    expect(render(prefix + fence + "```")).toContain("const value = 1;");
  });

  test("holds unfinished code in list items and quotes despite trailing blank lines", () => {
    const list = "- Complete item\n- ```ts\n  const value = 1;\n\n";
    expect(render(list)).toContain("Complete item");
    expect(render(list)).not.toContain("const value");
    const quote = "> ```ts\n> const value = 1;\n\n";
    expect(render(quote)).toBe("");
    expect(render(quote, false)).toContain("const value = 1;");
  });

  test("keeps a complete prefix visible while an indented code block grows", () => {
    const html = render("A paragraph.\n\n    incomplete code");
    expect(html).toContain("A paragraph.");
    expect(html).not.toContain("incomplete code");
  });

  test("keeps document-wide link definitions available to earlier sections", () => {
    const html = render("[Docs][ref]\n\n[ref]: https://example.com\n\nAn unfinished tail");
    expect(html).toContain('href="https://example.com"');
    expect(html).not.toContain("unfinished");
  });

  test("does not hide a section exposed before streaming resumed", () => {
    expect(render("日本語 👩🏽‍💻 grows", true, "日本語 👩🏽‍💻".length)).toContain("日本語 👩🏽‍💻 grows");
    const heading = "## Already visible";
    expect(render(heading + "\n\nAn unfinished tail", true, heading.length)).toContain(
      "<h2>Already visible</h2>",
    );
  });

  test("flushes final content without requiring a boundary", () => {
    expect(render("Final **answer**.", false)).toContain("<strong>answer</strong>");
    expect(render("Literal **unfinished", false)).toContain("Literal **unfinished");
  });
});
