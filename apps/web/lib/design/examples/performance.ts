import { blankDesignDocument, buildDrawnNode, parseDesignDocument } from "../document";
/** Repeatable, mixed nested scenes within the document's 5,000-node limit. */
export function performanceDocument(count: number) {
  const document = blankDesignDocument();
  for (let i = 0; i < count; i++) {
    const frame = Math.floor(i / 100),
      offset = i % 100;
    if (!offset)
      document.nodes.push(
        buildDrawnNode(`frame-${frame}`, "artboard", null, {
          x: frame * 900,
          y: 0,
          width: 800,
          height: 700,
        }),
      );
    else {
      const type = offset % 3 === 0 ? "text" : "container";
      const node = buildDrawnNode(`layer-${i}`, type, `frame-${frame}`, {
        x: (offset % 8) * 90 + 20,
        y: Math.floor(offset / 8) * 45 + 20,
        width: 80,
        height: 32,
      });
      node.name = `Layer ${i}`;
      if (type === "text") {
        node.text = `Text ${i}`;
        node.style = { fontFamily: "system-ui", fontSize: 12, color: "#222222" };
      }
      document.nodes.push(node);
    }
  }
  return parseDesignDocument(document);
}
