import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { remarkTableSource } from "./table-markdown";

function render(source: string) {
  const copied: string[] = [];
  const html = renderToStaticMarkup(
    createElement(Markdown, {
      remarkPlugins: [remarkGfm, remarkTableSource],
      components: {
        table({ node, children }) {
          copied.push(String(node?.properties["data-markdown-source"]));
          return createElement("table", null, children);
        },
      },
      children: source,
    }),
  );
  return { copied, html };
}

describe("table Markdown source", () => {
  test("preserves exact formatting, alignment, escapes and line endings", () => {
    const table = [
      "| Feature | Detail |",
      "| :--- | ---: |",
      '| **Bold** and *italic* | ~~Removed~~ and [a link](https://example.com "Title") |',
      "| `canvas_render` | ``code ` and \\| pipe`` |",
      "| \\*literal\\* | &amp; and <span>example</span> |",
    ].join("\r\n");
    const result = render(`Before\r\n\r\n${table}\r\n\r\nAfter`);
    expect(result.copied).toEqual([table]);
    expect(result.html).not.toContain("data-markdown-source");
  });

  test("keeps separate tables independent", () => {
    const first = "A | B\n--- | ---\nOne | Two";
    const second = "| C | D |\n| --- | --- |\n| Three | Four |";
    expect(render(`${first}\n\nBetween\n\n${second}`).copied).toEqual([first, second]);
  });

  test("includes only referenced definitions so copied links and images resolve", () => {
    const table = "| Link | Image |\n| --- | --- |\n| [Read][DOCS] | ![Preview][image] |";
    const definitions =
      '[docs]: https://example.com/docs "Documentation"\n\n[image]: https://example.com/image.png';
    const result = render(`${table}\n\n${definitions}\n\n[unused]: https://example.com/unused`);
    expect(result.copied).toEqual([`${table}\n\n${definitions}`]);
    expect(render(result.copied[0]!).html).toBe(result.html);
  });

  test("includes footnotes and their referenced links", () => {
    const table = "| Note |\n| --- |\n| Detail[^note] |";
    const definitions = "[^note]: See [details][docs].\n\n[docs]: https://example.com";
    const result = render(`${table}\n\n${definitions}`);
    expect(result.copied).toEqual([`${table}\n\n${definitions}`]);
    expect(render(result.copied[0]!).html).toBe(result.html);
  });

  test.each(["> ", "  > "])("removes enclosing quote prefixes: %s", (prefix) => {
    const table = "| A | B |\n| --- | --- |\n| **One** | Two |";
    const quoted = table
      .split("\n")
      .map((line) => prefix + line)
      .join("\n");
    expect(render(quoted).copied).toEqual([table]);
  });

  test("copies a nested list table as a standalone table", () => {
    const table = "| A | B |\n| --- | --- |\n| One | Two |";
    const nested = `- Item\n\n${table
      .split("\n")
      .map((line) => "  " + line)
      .join("\n")}`;
    expect(render(nested).copied).toEqual([table]);
  });
});
