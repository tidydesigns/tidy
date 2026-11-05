import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { remarkCompleteBlocks } from "./streamed-markdown";

function render(text: string, streaming = true, minimum = 0, onExpose?: (offset: number) => void) {
  return renderToStaticMarkup(
    createElement(Markdown, {
      children: text,
      remarkPlugins: [remarkGfm, [remarkCompleteBlocks, { text, streaming, minimum, onExpose }]],
      skipHtml: true,
    }),
  );
}

describe("streamed Markdown sections", () => {
  test("streams paragraphs before their separator arrives", () => {
    expect(render("A **partial")).toContain("partial");
    expect(render("A **complete** paragraph.\n\n")).toContain("<strong>complete</strong>");
  });

  test("holds new headings until content arrives and preserves exposed headings", () => {
    const prefix = "Earlier paragraph.\n\n## Details\n\n";
    expect(render(prefix)).not.toContain("<h2>");
    expect(render(prefix + "An unfinished paragraph")).toContain("<h2>");
    expect(render(prefix, true, prefix.length)).toContain("<h2>Details</h2>");
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
  });

  test("flushes final content without requiring a boundary", () => {
    expect(render("## Final heading", false)).toBe("<h2>Final heading</h2>");
    expect(render("```ts\nconst final = 1;", false)).toContain("const final = 1;");
    expect(render("- Final item", false)).toContain("<li>Final item</li>");
  });
});

test("visible paragraphs stay visible when streaming reclassifies tables and headings", () => {
  for (const chunks of [
    ["| Name | Value |", "\n| --- | --- |", "\n| Count | 1 |"],
    ["Title", "\n---"],
  ]) {
    let text = "";
    let exposed = 0;
    for (const chunk of chunks) {
      text += chunk;
      const html = render(text, true, exposed, (offset) => {
        exposed = Math.max(exposed, offset);
      });
      expect(html).toContain(chunks[0].includes("Name") ? "Name" : "Title");
    }
  }
});

test("exposing paragraphs does not release a subsequent unfinished code fence", () => {
  let exposed = 0;
  render("A visible paragraph", true, 0, (offset) => {
    exposed = offset;
  });
  const html = render("A visible paragraph\n\n```ts\nconst secret = 1", true, exposed);
  expect(html).toContain("A visible paragraph");
  expect(html).not.toContain("const secret");
});

test("exposed list items do not expose a later unfinished fenced item", () => {
  let exposed = 0;
  const text = "- First item\n- ```ts\n  const hidden = 1;";
  render(text, true, 0, (offset) => {
    exposed = offset;
  });
  const html = render(text + "\n  const next = 2;", true, exposed);
  expect(html).toContain("<li>First item</li>");
  expect(html).not.toContain("const hidden");
});
