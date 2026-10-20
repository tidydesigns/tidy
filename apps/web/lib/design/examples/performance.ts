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

export function largeFramePerformanceDocument({
  count,
  layersPerFrame,
}: {
  count: number;
  layersPerFrame: number;
}) {
  const document = blankDesignDocument();
  for (let index = 0; index < count; index++) {
    const frame = Math.floor(index / layersPerFrame);
    const offset = index % layersPerFrame;
    if (offset === 0) {
      const node = buildDrawnNode(`large-frame-${frame}`, "artboard", null, {
        x: (frame % 4) * 5400,
        y: Math.floor(frame / 4) * 5400,
        width: 5000,
        height: 5000,
      });
      node.name = `Large frame ${frame + 1}`;
      node.style = { fill: "#fafafa", overflow: "hidden" };
      document.nodes.push(node);
    } else {
      const node = buildDrawnNode(
        `large-layer-${index}`,
        offset % 3 === 0 ? "text" : "container",
        `large-frame-${frame}`,
        {
          x: 32 + ((offset - 1) % 100) * 48,
          y: 32 + Math.floor((offset - 1) / 100) * 48,
          width: 44,
          height: 40,
        },
      );
      node.name = `Stress layer ${index}`;
      node.style =
        node.type === "text"
          ? { fontFamily: "system-ui", fontSize: 10, color: "#333333" }
          : {
              fill: offset % 2 ? "#e4e4e4" : "#d4d4d4",
              borderColor: "#cccccc",
              borderWidth: 1,
              radius: 4,
            };
      if (node.type === "text") node.text = `Label ${index}`;
      document.nodes.push(node);
    }
  }
  return parseDesignDocument(document);
}
