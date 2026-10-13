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

/** Dense sibling selections exercise per-layer work rather than moving a few artboard roots. */
export function selectionPerformanceDocument(selectedCount: number) {
  if (!Number.isInteger(selectedCount) || selectedCount < 1 || selectedCount > 4999)
    throw new Error("Select between 1 and 4,999 layers within the document limit.");
  const document = blankDesignDocument();
  const columns = Math.min(50, selectedCount);
  document.nodes.push(
    buildDrawnNode("selection-frame", "artboard", null, {
      x: 0,
      y: 0,
      width: columns * 28 + 40,
      height: Math.ceil(selectedCount / columns) * 20 + 40,
    }),
  );
  for (let index = 0; index < selectedCount; index++) {
    const node = buildDrawnNode(`selected-${index}`, "container", "selection-frame", {
      x: (index % columns) * 28 + 20,
      y: Math.floor(index / columns) * 20 + 20,
      width: 20,
      height: 12,
    });
    node.name = `Selected layer ${index + 1}`;
    document.nodes.push(node);
  }
  return parseDesignDocument(document);
}
