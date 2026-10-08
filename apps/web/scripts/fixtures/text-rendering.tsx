import { createRoot } from "react-dom/client";
import { DocumentPreview } from "@/app/files/thumbnail-renderer";
import { DesignSnapshot } from "@/components/github/design-snapshot";
import { CanvasArtwork } from "@/app/files/[uid]/canvas-artwork";
import { TidyDesign } from "@/lib/design/code-runtime";
import { blankDesignDocument, buildDrawnNode, type DesignNode } from "@/lib/design/document";

const noop = () => {};
const frame = buildDrawnNode("frame", "artboard", null, { x: 0, y: 0, width: 500, height: 800 });
const text = {
  ...buildDrawnNode("text", "text", "frame", { x: 10, y: 20, width: 220, height: 90 }),
  name: "Text",
  style: {
    fontFamily: "monospace",
    fontSize: 16,
    paragraphSpacing: 7,
    lineHeight: 1.5,
    color: "#000000",
  },
};
const cases: DesignNode[] = [
  { ...text, text: "" },
  { ...text, text: "", widthMode: "hug", heightMode: "hug" },
  { ...text, text: "Word ".repeat(100) + "\n\nLast line", heightMode: "hug" },
  {
    ...text,
    text: "A longer line\n\nEnd\n",
    widthMode: "hug",
    heightMode: "hug",
    style: { ...text.style, lineHeightMode: "px", lineHeightPx: 28 },
  },
  {
    ...text,
    text: "Auto line height\nAnother paragraph",
    widthMode: "fill",
    heightMode: "hug",
    style: { ...text.style, lineHeightMode: "auto" },
  },
  {
    ...text,
    text: "A long single line that must truncate at the fixed width",
    style: {
      ...text.style,
      textWrap: "nowrap",
      textOverflow: "ellipsis",
      textDecoration: "underline",
    },
  },
  {
    ...text,
    text: "Word ".repeat(70),
    heightMode: "hug",
    style: { ...text.style, maxLines: 2, lineHeightMode: "percent", lineHeight: 1.7 },
  },
];
const rootText = {
  ...cases[2],
  id: "root-text",
  parentId: null,
  box: { x: 0, y: 0, width: 220, height: 30 },
};
createRoot(document.getElementById("root")!).render(
  <>
    {cases.map((node, index) => {
      const content = { ...blankDesignDocument(), nodes: [frame, node] };
      return (
        <div key={index} data-case={index}>
          <div data-surface="canvas" style={{ position: "relative", width: 500, height: 800 }}>
            <CanvasArtwork
              nodesById={new Map(content.nodes.map((node) => [node.id, node]))}
              childrenById={
                new Map([
                  [null, [frame]],
                  ["frame", [node]],
                ])
              }
              visibleRootIds={new Set(["frame"])}
              tokens={{}}
              selectedIds={[]}
              prototypeMode={false}
              prototypeArtboardId={null}
              cropId={null}
              editingTextId={null}
              registerElement={noop}
              onMenu={noop}
              onDoubleClick={noop}
              onPointerDown={noop}
              onPointerMove={noop}
              onPointerUp={noop}
              onPointerCancel={noop}
              onTextDraft={noop}
              onTextFinish={noop}
            />
          </div>
          <div data-surface="thumbnail" style={{ width: 500, height: 800 }}>
            <DocumentPreview content={content} />
          </div>
          <div data-surface="review" style={{ width: 500 }}>
            <DesignSnapshot
              content={content}
              reviewId="test"
              frameId="frame"
              selectedNode={null}
              onSelect={noop}
            />
          </div>
          <div data-surface="export" style={{ position: "relative", width: 500, height: 800 }}>
            <TidyDesign document={content} rootId="frame" assets={{}} />
          </div>
        </div>
      );
    })}
    <div id="root-text-preview" style={{ width: 500, height: 320 }}>
      <DocumentPreview content={{ ...blankDesignDocument(), nodes: [rootText] }} />
    </div>
    <div id="clipped-text-preview" style={{ width: 500, height: 320 }}>
      <DocumentPreview
        content={{
          ...blankDesignDocument(),
          nodes: [{ ...frame, box: { ...frame.box, height: 100 } }, cases[2]],
        }}
      />
    </div>
  </>,
);
