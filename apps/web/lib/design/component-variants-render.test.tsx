import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { composeComponent, componentTreeSchema } from "./compose-component";
import { buttonExample } from "../mcp/design-tools";
import { createComponentInstance } from "./document-operations";
import { syncComponentEdit } from "./component-sync";
import { resolveVariantNodes } from "./component-variants";
import { buildDrawnNode, parseDesignDocument } from "./document";
import { SelectionInspector } from "@/app/files/[uid]/selection-inspector";
import { DocumentPreview } from "@/app/files/thumbnail-renderer";
import { DesignSnapshot } from "@/components/github/design-snapshot";
import { snapshotFrames } from "@/lib/github/validation";

function fixture() {
  const document = composeComponent(componentTreeSchema.parse(buttonExample)).document;
  let id = 0;
  const instance = createComponentInstance(document, "new-thread", () => `copy-${id++}`);
  const frame = {
    ...buildDrawnNode("frame", "artboard", null, { x: 0, y: 0, width: 400, height: 200 }),
    style: {},
    layout: "flex-row" as const,
  };
  const nodes = syncComponentEdit(instance.document.nodes, instance.rootId, {
    variant: "secondary",
  }).map((node) => (node.id === instance.rootId ? { ...node, parentId: "frame" } : node));
  return parseDesignDocument({ ...document, nodes: [frame, ...nodes] });
}

test("inspector presents the family's selected variant with read-only permissions", () => {
  const document = fixture();
  const selected = resolveVariantNodes(document.nodes).filter((node) => node.id === "copy-0");
  const props = {
    document,
    selected,
    onPatch: () => {},
    onDocument: () => {},
    onExport: () => {},
    onReplaceImage: () => {},
    onPrototype: () => {},
    onAlign: () => {},
    onDistribute: () => {},
    onGroup: () => {},
  };
  const html = renderToStaticMarkup(<SelectionInspector {...props} />);
  expect(html).toContain('aria-label="Variant: secondary"');
  expect(html).toContain('aria-haspopup="menu"');
  expect(html).not.toContain('<select aria-label="Variant"');
  const readOnly = renderToStaticMarkup(<SelectionInspector {...props} readOnly />);
  expect(readOnly).toContain("data-handoff-inspector");
  expect(readOnly).toContain("secondary");
  expect(readOnly).toContain("Copy CSS");
  expect(readOnly).not.toContain("<fieldset");
});

test("thumbnails and snapshots render the same selected palette, including external masters", () => {
  const document = fixture();
  const thumbnail = renderToStaticMarkup(<DocumentPreview content={document} />);
  expect(thumbnail).toContain("background:#eeeeec");
  expect(thumbnail).toContain("color:#282a28");
  const snapshot = snapshotFrames(document, ["frame"]);
  expect(parseDesignDocument(snapshot).nodes).toHaveLength(3);
  expect(snapshot.nodes.find((node) => node.id === "copy-0")?.variant).toBeUndefined();
  const html = renderToStaticMarkup(
    <DesignSnapshot
      reviewId="review"
      content={snapshot}
      frameId="frame"
      selectedNode={null}
      onSelect={() => {}}
    />,
  );
  expect(html).toContain("background:#eeeeec");
  expect(html).toContain("color:#282a28");
  expect(document.nodes.find((node) => node.id === "copy-0")?.variant).toBe("secondary");
});
