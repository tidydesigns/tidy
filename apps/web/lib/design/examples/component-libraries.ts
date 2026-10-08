import { blankDesignDocument, buildDrawnNode, parseDesignDocument } from "../document";
import { libraryPayload, importLibraryComponent } from "../component-libraries";
import { createComponentInstance } from "../document-operations";
export const libraryFileUid = "00000000-0000-4000-8000-000000000037";
export function buildLibrarySource(revision = 1) {
  return parseDesignDocument({
    ...blankDesignDocument(),
    nodes: [
      {
        ...buildDrawnNode("source-button", "container", null, {
          x: 0,
          y: 0,
          width: 180,
          height: 70,
        }),
        name: "Library button",
        isComponent: true,
        style: { fill: "#ff6600", radius: 12 },
        componentProperties: {
          label: { name: "Label", targetId: "source-label", property: "text" },
          size: { name: "Label size", targetId: "source-label", property: "fontSize" },
        },
        variants: {
          default: "primary",
          options: { primary: {}, compact: { root: { box: { width: 140, height: 60 } } } },
        },
      },
      {
        ...buildDrawnNode("source-label", "text", "source-button", {
          x: 20,
          y: 22,
          width: 140,
          height: 28,
        }),
        name: "Library label",
        text: revision > 1 ? "Updated source" : "Library",
        style: { fontSize: revision > 1 ? 24 : 18, color: "#111111" },
      },
      ...(revision > 1
        ? [
            {
              ...buildDrawnNode("source-icon", "container", "source-button", {
                x: 145,
                y: 8,
                width: 16,
                height: 16,
              }),
              name: "Library icon",
              style: { fill: "#000000" },
            },
          ]
        : []),
    ],
  });
}
export function buildComponentLibraryDocument() {
  const doc = parseDesignDocument({
    ...blankDesignDocument(),
    nodes: [
      {
        ...buildDrawnNode("frame", "artboard", null, { x: 40, y: 40, width: 640, height: 360 }),
        name: "Library frame",
        style: { fill: "#ffffff" },
      },
      {
        ...buildDrawnNode("local-component", "container", "frame", {
          x: 30,
          y: 30,
          width: 180,
          height: 70,
        }),
        name: "Local button",
        isComponent: true,
        style: { fill: "#0088cc", radius: 12 },
        componentProperties: {
          label: { name: "Label", targetId: "local-label", property: "text" },
        },
      },
      {
        ...buildDrawnNode("local-label", "text", "local-component", {
          x: 20,
          y: 22,
          width: 140,
          height: 28,
        }),
        name: "Local label",
        text: "Local",
        style: { fontSize: 18, color: "#ffffff" },
      },
    ],
  });
  let serial = 0;
  const linked = importLibraryComponent(
    doc,
    libraryPayload(buildLibrarySource(), "source-button", libraryFileUid),
    1,
    () => `library-${++serial}`,
  );
  serial = 0;
  const instance = createComponentInstance(linked.document, linked.rootId, () =>
    serial++ === 0 ? "linked-instance" : "linked-label",
  );
  return parseDesignDocument({
    ...instance.document,
    nodes: instance.document.nodes.map((n) =>
      n.instanceOf === linked.rootId
        ? {
            ...n,
            pageId: "page-1",
            parentId: n.id === "linked-instance" ? "frame" : n.parentId,
            box: n.id === "linked-instance" ? { ...n.box, x: 300, y: 30 } : n.box,
          }
        : n,
    ),
  });
}
