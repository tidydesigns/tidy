import {
  blankDesignDocument,
  buildDrawnNode,
  parseDesignDocument,
  type DesignNode,
} from "../document";
import { createComponentInstance } from "../document-operations";

/** Isolated development fixture for linked structure and cross-page instance controls. */
export function buildComponentsDocument() {
  const node = (
    id: string,
    type: "artboard" | "container" | "text",
    parent: string | null,
    x: number,
    y: number,
    width: number,
    height: number,
  ): DesignNode => buildDrawnNode(id, type, parent, { x, y, width, height });
  const document = parseDesignDocument({
    ...blankDesignDocument(),
    pages: [
      { id: "page-1", name: "Instances" },
      { id: "page-2", name: "Other components" },
    ],
    nodes: [
      { ...node("frame", "artboard", null, 0, 0, 700, 600), name: "Components" },
      {
        ...node("master", "container", "frame", 50, 40, 220, 160),
        name: "Card",
        isComponent: true,
        style: { fill: "#eeeeee" },
      },
      { ...node("label", "text", "master", 12, 12, 160, 30), name: "Label", text: "Original" },
      {
        ...node("detail", "container", "master", 12, 60, 160, 20),
        name: "Detail",
        style: { fill: "#ff5d00" },
      },
      {
        ...node("frame-2", "artboard", null, 0, 0, 700, 600),
        name: "Other components",
        pageId: "page-2",
      },
      {
        ...node("target", "container", "frame-2", 40, 40, 180, 140),
        name: "Alternate card",
        isComponent: true,
        pageId: "page-2",
        style: { fill: "#ccffcc" },
      },
      {
        ...node("target-label", "text", "target", 10, 10, 130, 25),
        name: "Label",
        text: "Target",
        pageId: "page-2",
      },
    ],
  });
  let id = 0;
  const result = createComponentInstance(document, "master", () => `instance-${id++}`).document;
  return parseDesignDocument({
    ...result,
    nodes: result.nodes.map((item) =>
      item.id === "instance-0" ? { ...item, box: { ...item.box, x: 50, y: 300 } } : item,
    ),
  });
}
