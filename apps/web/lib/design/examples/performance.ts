import { createComponentInstance } from "../document-operations";
import { blankDesignDocument, buildDrawnNode, parseDesignDocument } from "../document";
/** Repeatable, mixed nested scenes validated against the shared document limits. */
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

export function componentPerformanceDocument(count: number) {
  const document = performanceDocument(count);
  const component = parseDesignDocument({
    ...document,
    nodes: document.nodes.map((node) => {
      if (node.parentId === null) {
        const index = Number(node.id.slice("frame-".length));
        node = {
          ...node,
          box: { ...node.box, x: (index % 6) * 900, y: Math.floor(index / 6) * 800 },
        };
      }
      return node.id === "frame-0"
        ? {
            ...node,
            name: "Component master",
            isComponent: true,
            componentProperties: {
              label: { name: "Caption", targetId: "layer-3", property: "text" },
            },
          }
        : node;
    }),
  });
  let id = 0;
  return createComponentInstance(component, "frame-0", () => `component-instance-${id++}`).document;
}
