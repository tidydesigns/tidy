import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { FontRecovery } from "@/app/files/[uid]/font-recovery";
import {
  blankDesignDocument,
  buildDrawnNode,
  parseDesignDocument,
  type DesignDocument,
} from "@/lib/design/document";
import {
  diffDocument,
  applyDocumentPatch,
  invertPatch,
  type DocumentPatch,
} from "@/lib/design/document-patch";
import { fontRegistry } from "@/lib/design/fonts/runtime";
import { DocumentPreview } from "@/app/files/thumbnail-renderer";
import { DesignSnapshot } from "@/components/github/design-snapshot";
import { TidyDesign } from "@/lib/design/code-runtime";
import { DesignText } from "@/components/design/design-text";
import { nodeStyle } from "@/lib/design/node-style";

const frame = buildDrawnNode("frame", "artboard", null, { x: 0, y: 0, width: 300, height: 180 });
const text = {
  ...buildDrawnNode("text", "text", "frame", { x: 10, y: 10, width: 150, height: 30 }),
  text: "Font example",
  style: {
    fontFamily: "Tidy Absent Font 937",
    fontFace: "Tidy Absent Font 937 Regular",
    fontSource: "local" as const,
    fontSize: 16,
  },
};
const initial = parseDesignDocument({
  ...blankDesignDocument(),
  pages: [
    { id: "page-1", name: "One" },
    { id: "page-2", name: "Two" },
  ],
  nodes: [
    frame,
    text,
    { ...text, id: "hidden-text", parentId: null, pageId: "page-2", visible: false, locked: true },
    {
      ...text,
      id: "available",
      parentId: null,
      pageId: "page-2",
      style: { fontFamily: "monospace", fontSource: "system" },
    },
  ],
});
const testWindow = window as Window & {
  initialFontDocument?: DesignDocument;
  fontTest?: { document: DesignDocument; registry: typeof fontRegistry };
};
function Fixture() {
  const [content, setContent] = useState(() =>
    parseDesignDocument(testWindow.initialFontDocument ?? initial),
  );
  const [undo, setUndo] = useState<DocumentPatch>();
  useEffect(() => {
    testWindow.fontTest = { document: content, registry: fontRegistry };
  }, [content]);
  const node = content.nodes.find((node) => node.id === "text")!;
  return (
    <>
      <FontRecovery
        document={content}
        onDocument={(update) => {
          const next = update(content);
          setUndo(invertPatch(diffDocument(content, next)));
          setContent(next);
        }}
      />
      <button
        onClick={() => {
          if (undo) setContent((current) => applyDocumentPatch(current, undo));
        }}
      >
        Undo replacement
      </button>
      <div data-surface="canvas" style={{ position: "relative", width: 300, height: 180 }}>
        <div style={nodeStyle(node, "absolute", {})}>
          <DesignText node={node} />
        </div>
      </div>
      <div data-surface="thumbnail" style={{ width: 300, height: 180 }}>
        <DocumentPreview content={content} />
      </div>
      <div data-surface="review" style={{ width: 300 }}>
        <DesignSnapshot
          content={content}
          frameId="frame"
          reviewId="test"
          selectedNode={null}
          onSelect={() => {}}
        />
      </div>
      <div data-surface="export" style={{ position: "relative", width: 300, height: 180 }}>
        <TidyDesign document={content} rootId="frame" assets={{}} />
      </div>
    </>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
