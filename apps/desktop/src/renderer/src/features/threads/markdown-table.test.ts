import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { MarkdownTable } from "./markdown-table";
import { formatTableCsv, tableSourceRows } from "./table-format";

function render(count: number) {
  let csv = "";
  const rows = Array.from(
    { length: count },
    (_, index) => `| ${index + 1} | **Finding ${index + 1}**, reviewed |`,
  );
  const html = renderToStaticMarkup(
    createElement(Markdown, {
      remarkPlugins: [remarkGfm],
      components: {
        table: ({ node, children }) => {
          if (node) csv = formatTableCsv(tableSourceRows(node));
          return createElement(MarkdownTable, { node, children });
        },
      },
      children: `| # | Finding |\n| --- | --- |\n${rows.join("\n")}`,
    }),
  );
  return { html, csv };
}

describe("Markdown table pagination", () => {
  test("keeps small tables complete with copy and expand controls", () => {
    const { html } = render(2);
    expect(html.match(/<tr>/g)).toHaveLength(3);
    expect(html).not.toContain("Next rows");
    expect(html).toContain('aria-label="Expand table"');
    expect(html).toContain('aria-label="Copy table"');
  });

  test("starts pagination only after 100 data rows", () => {
    expect(render(100).html).not.toContain("Next rows");
    expect(render(101).html).toContain("Rows 1–100 of 101");
  });

  test("bounds a large table without dropping off-page CSV data or inline formatting", () => {
    const { html, csv } = render(1000);
    expect(html.match(/<tr>/g)).toHaveLength(101);
    expect(html).toContain("<strong>Finding 100</strong>");
    expect(html).not.toContain("<strong>Finding 101</strong>");
    expect(csv.split("\r\n")).toHaveLength(1001);
    expect(csv).toEndWith('1000,"Finding 1000, reviewed"');
  });
});
