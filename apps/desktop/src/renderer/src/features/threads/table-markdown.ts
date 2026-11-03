import type { Definition, FootnoteDefinition, Nodes, Root } from "mdast";

function visit(node: Nodes, action: (node: Nodes) => void) {
  action(node);
  if ("children" in node) for (const child of node.children) visit(child, action);
}

function sourceOf(node: Nodes, source: string) {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  if (start === undefined || end === undefined) return undefined;
  const raw = source.slice(start, end);
  const indent = (node.position?.start.column ?? 1) - 1;
  return indent
    ? raw.replace(
        /(\r?\n)([ \t>]*)/g,
        (_match, newline: string, prefix: string) => newline + prefix.slice(indent),
      )
    : raw;
}

export function remarkTableSource() {
  return (root: Root, file: { toString(): string }) => {
    const source = file.toString();
    const definitions = new Map<string, Definition | FootnoteDefinition>();
    visit(root, (node) => {
      if (node.type !== "definition" && node.type !== "footnoteDefinition") return;
      const key = `${node.type}:${node.identifier.toUpperCase()}`;
      if (!definitions.has(key)) definitions.set(key, node);
    });

    visit(root, (node) => {
      if (node.type !== "table") return;
      const table = sourceOf(node, source);
      if (table === undefined) return;
      const needed = new Set<Definition | FootnoteDefinition>();
      function collectReference(child: Nodes) {
        const kind =
          child.type === "linkReference" || child.type === "imageReference"
            ? "definition"
            : child.type === "footnoteReference"
              ? "footnoteDefinition"
              : null;
        if (!kind || !("identifier" in child)) return;
        const definition = definitions.get(`${kind}:${child.identifier.toUpperCase()}`);
        if (!definition || needed.has(definition)) return;
        needed.add(definition);
        visit(definition, collectReference);
      }
      visit(node, collectReference);
      const newline = table.includes("\r\n") ? "\r\n" : "\n";
      const fragments = [table];
      for (const definition of definitions.values()) {
        if (!needed.has(definition)) continue;
        const value = sourceOf(definition, source);
        if (value !== undefined) fragments.push(value);
      }
      node.data = {
        ...node.data,
        hProperties: {
          ...node.data?.hProperties,
          "data-markdown-source": fragments.join(newline + newline),
        },
      };
    });
  };
}
