import { createLowlight } from "lowlight";
import typescript from "highlight.js/lib/languages/typescript";
import javascript from "highlight.js/lib/languages/javascript";
import css from "highlight.js/lib/languages/css";
import json from "highlight.js/lib/languages/json";
import xml from "highlight.js/lib/languages/xml";
import python from "highlight.js/lib/languages/python";
import bash from "highlight.js/lib/languages/bash";
import rust from "highlight.js/lib/languages/rust";
import go from "highlight.js/lib/languages/go";
import sql from "highlight.js/lib/languages/sql";
import yaml from "highlight.js/lib/languages/yaml";
import markdown from "highlight.js/lib/languages/markdown";
import type { CodeLine, FileRows } from "./file-rows";

const highlighter = createLowlight({
  typescript,
  javascript,
  css,
  json,
  xml,
  python,
  bash,
  rust,
  go,
  sql,
  yaml,
  markdown,
});
const languages: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  css: "css",
  json: "json",
  html: "xml",
  htm: "xml",
  svg: "xml",
  xml: "xml",
  py: "python",
  sh: "bash",
  bash: "bash",
  rs: "rust",
  go: "go",
  sql: "sql",
  yaml: "yaml",
  yml: "yaml",
  md: "markdown",
};
export function highlightFileRows(result: FileRows, path: string) {
  const language = languages[path.split(".").at(-1)?.toLowerCase() ?? ""];
  if (!language) return;
  for (const side of ["before", "after"] as const) {
    const lines: CodeLine[] = [];
    let size = 0;
    for (const row of result.rows) {
      if (row.kind !== "lines" || !row[side]) continue;
      const line = row[side];
      if (size + line.text.length + 1 > 65536) break;
      lines.push(line);
      size += line.text.length + 1;
    }
    if (!lines.length) continue;
    const tokens: Array<NonNullable<CodeLine["tokens"]>> = lines.map(() => []);
    let index = 0,
      count = 0;
    const tree = highlighter.highlight(language, lines.map((line) => line.text).join("\n"));
    function visit(node: (typeof tree.children)[number], classes: string[]) {
      if (node.type === "text") {
        const parts = node.value.split("\n");
        parts.forEach((text, part) => {
          if (part) index++;
          if (text && tokens[index]) {
            if (++count > 24000) throw new Error("Syntax preview limit reached.");
            tokens[index].push({ text, classes: classes.join(" ") });
          }
        });
      } else if (node.type === "element") {
        const names = node.properties.className;
        const next = [
          ...classes,
          ...(Array.isArray(names)
            ? names.filter((value): value is string => typeof value === "string")
            : []),
        ];
        for (const child of node.children) visit(child, next);
      }
    }
    try {
      for (const node of tree.children) visit(node, []);
      lines.forEach((line, index) => {
        if (tokens[index].map((token) => token.text).join("") === line.text)
          line.tokens = tokens[index];
      });
    } catch {
      continue;
    }
  }
}
