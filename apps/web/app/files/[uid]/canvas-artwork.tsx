"use client";
import type { TextContent } from "@tidy/design/rich-text";

import { memo, useCallback, useMemo, useState, type MouseEvent, type PointerEvent } from "react";
import type { DesignNode } from "@/lib/design/document";
import { createArtworkBranches, type Branch } from "./artwork-branches";
import { nodeStyle } from "@/lib/design/node-style";
import { responsiveNode } from "@/lib/design/responsive-layout";
import { NodeStrokes } from "@/components/design/node-strokes";
import { NodeFills } from "@/components/design/node-fills";
import { DesignText } from "@/components/design/design-text";
import { DesignImage } from "@/components/design/design-image";
import { EditableDesignText } from "./editable-design-text";

import { ImageMimeProvider } from "@tidy/design-renderer/image-context";

type Props = {
  assetMimeTypes?: Record<string, string>;
  nodesById: ReadonlyMap<string, DesignNode>;
  childrenById: ReadonlyMap<string | null, DesignNode[]>;
  visibleRootIds: ReadonlySet<string>;
  registerElement: (id: string, element: HTMLDivElement | null) => void;
  tokens: Record<string, string>;
  selectedIds: string[];
  prototypeMode: boolean;
  prototypeArtboardId: string | null;
  cropId: string | null;
  editingTextId: string | null;
  newTextId?: string | null;
  previewAssetUrls?: Record<string, string>;
  onMenu: (event: MouseEvent<HTMLElement>, id: string) => void;
  onDoubleClick: (node: DesignNode, event: MouseEvent<HTMLDivElement>) => void;
  onPointerDown: (node: DesignNode, event: PointerEvent<HTMLDivElement>) => void;
  onPointerMove: (node: DesignNode, event: PointerEvent<HTMLDivElement>) => void;
  onPointerUp: (node: DesignNode, event: PointerEvent<HTMLDivElement>) => void;
  onPointerCancel: () => void;
  onTextDraft: (node: DesignNode, value: TextContent) => void;
  onTextFinish: (node: DesignNode, value: TextContent | null) => void;
};

type Handlers = Pick<
  Props,
  | "registerElement"
  | "onMenu"
  | "onDoubleClick"
  | "onPointerDown"
  | "onPointerMove"
  | "onPointerUp"
  | "onPointerCancel"
  | "onTextFinish"
  | "onTextDraft"
  | "newTextId"
>;
const ArtworkNode = memo(function ArtworkNode({
  branch,
  tokens,
  previewAssetUrls,
  handlers,
}: {
  branch: Branch;
  tokens: Props["tokens"];
  previewAssetUrls: Props["previewAssetUrls"];
  handlers: Handlers;
}) {
  const { node, parent, viewportWidth, flowIndex, selected, cropping, editing, children } = branch;
  const register = useCallback(
    (element: HTMLDivElement | null) => handlers.registerElement(node.id, element),
    [handlers, node.id],
  );
  const rendered = responsiveNode(branch.painted, viewportWidth);
  const style: React.CSSProperties = {
    ...nodeStyle(
      rendered,
      parent ? responsiveNode(parent, viewportWidth).layout : "absolute",
      tokens,
      parent ? responsiveNode(parent, viewportWidth) : undefined,
      flowIndex,
    ),
    ...(editing ? { textDecoration: "none" } : {}),
    ...branch.composite,
    outline: selected
      ? "calc(2px / var(--canvas-zoom, 1)) solid var(--color-primary-orange)"
      : node.style.outlineWidth
        ? `${node.style.outlineWidth}px solid ${node.style.outlineColor ?? "#000000"}`
        : undefined,
    outlineOffset: selected ? "calc(1px / var(--canvas-zoom, 1))" : undefined,
    cursor: cropping ? "move" : undefined,
  };
  return (
    <div
      ref={register}
      data-node-id={node.id}
      data-selected={selected}
      style={style}
      onContextMenu={(event) => handlers.onMenu(event, node.id)}
      onDoubleClick={(event) => handlers.onDoubleClick(node, event)}
      onPointerDown={(event) => handlers.onPointerDown(node, event)}
      onPointerMove={(event) => handlers.onPointerMove(node, event)}
      onPointerUp={(event) => handlers.onPointerUp(node, event)}
      onPointerCancel={handlers.onPointerCancel}
    >
      <NodeStrokes node={rendered} tokens={tokens} />
      <NodeFills
        node={rendered}
        tokens={tokens}
        assetUrl={(id) => previewAssetUrls?.[id] ?? `/api/assets/${id}`}
      />
      {node.type === "text" ? (
        editing ? (
          <EditableDesignText
            node={node}
            selectAllOnMount={handlers.newTextId === node.id}
            onDraft={(value) => handlers.onTextDraft(node, value)}
            onFinish={(value) => handlers.onTextFinish(node, value)}
          />
        ) : (
          <DesignText node={node} interactiveLinks={false} />
        )
      ) : rendered.type === "image" || rendered.type === "vector" ? (
        <DesignImage
          tokens={tokens}
          node={rendered}
          src={previewAssetUrls?.[node.assetId ?? ""] ?? `/api/assets/${node.assetId}`}
        />
      ) : null}
      {children.map((child) => (
        <ArtworkNode
          key={child.node.id}
          branch={child}
          tokens={tokens}
          previewAssetUrls={previewAssetUrls}
          handlers={handlers}
        />
      ))}
    </div>
  );
});

/** View movement leaves artwork untouched; edits render only affected branches. */
export const CanvasArtwork = memo(function CanvasArtwork(props: Props) {
  const [build] = useState(createArtworkBranches);
  const {
    registerElement,
    onMenu,
    onDoubleClick,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onPointerCancel,
    onTextDraft,
    onTextFinish,
    newTextId,
  } = props;
  const handlers = useMemo(
    () => ({
      registerElement,
      onMenu,
      onDoubleClick,
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onPointerCancel,
      onTextDraft,
      onTextFinish,
      newTextId,
    }),
    [
      registerElement,
      onMenu,
      onDoubleClick,
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onPointerCancel,
      onTextDraft,
      onTextFinish,
      newTextId,
    ],
  );
  return (
    <ImageMimeProvider types={props.assetMimeTypes}>
      {build(props).map((branch) => (
        <ArtworkNode
          key={branch.node.id}
          branch={branch}
          tokens={props.tokens}
          previewAssetUrls={props.previewAssetUrls}
          handlers={handlers}
        />
      ))}
    </ImageMimeProvider>
  );
});
