import type { ExtraProps } from "react-markdown";

export function formatTableCsv(rows: string[][]): string {
  return rows
    .map((row) =>
      row
        .map((cell) => (/[",\r\n]/.test(cell) ? `"${cell.replaceAll('"', '""')}"` : cell))
        .join(","),
    )
    .join("\r\n");
}

type TableNode = NonNullable<ExtraProps["node"]>;

function sourceText(node: TableNode["children"][number]): string {
  if (node.type === "text") return node.value;
  if (node.type !== "element") return "";
  if (node.tagName === "br") return "\n";
  if (node.tagName === "img") return String(node.properties.alt ?? "Image");
  return node.children.map(sourceText).join("");
}

export function tableSourceRows(node: TableNode): string[][] {
  return node.children.flatMap((group) => {
    if (group.type !== "element") return [];
    return group.children.flatMap((row) => {
      if (row.type !== "element" || row.tagName !== "tr") return [];
      return [
        row.children.flatMap((cell) =>
          cell.type === "element" && (cell.tagName === "th" || cell.tagName === "td")
            ? [sourceText(cell)]
            : [],
        ),
      ];
    });
  });
}
