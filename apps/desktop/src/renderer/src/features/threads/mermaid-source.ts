import { MERMAID_RESOURCE_MESSAGE } from "./mermaid-error";

export function mermaidSourceError(source: string): string | null {
  if (!source.trim()) return "This diagram is empty.";
  if (source.length > 20_000 || source.replace(/\r?\n$/u, "").split(/\r?\n/u).length > 300)
    return "This diagram is too large to preview. Copy the code to view it elsewhere.";
  if (/\$\$[\s\S]+?\$\$/u.test(source)) return "Diagrams with math labels are shown as code.";
  if (
    /!\[|<\s*(?:img|image|iframe|script|foreignObject)\b|@import|url\s*\(/iu.test(source) ||
    source.split("\n").some((line) => {
      const escape = line.lastIndexOf("\\");
      return escape >= 0 && /\b(?:classDef|style|linkStyle)\b/u.test(line.slice(0, escape));
    })
  )
    return MERMAID_RESOURCE_MESSAGE;
  return null;
}
