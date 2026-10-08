"use client";
import type { TextContent } from "@bella/design/rich-text";

import { memo, useCallback, useMemo, useState, type MouseEvent, type PointerEvent } from "react";
import type { DesignNode } from "@/lib/design/document";
import { booleanRenderNode, vectorCompositeStyle } from "@tidy/design-renderer/vector-composites";
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

type Branch = {
  node: DesignNode;
  parent?: DesignNode;
  flowIndex: number;
  viewportWidth: number;
  selected: boolean;
  cropping: boolean;
  editing: boolean;
  children: Branch[];
  painted: DesignNode;
  composite: React.CSSProperties;
};

function branchBuilder() {
  const previous = new WeakMap<DesignNode, Branch>();
  let previousMap: Props["nodesById"] | undefined;
  let allNodes: DesignNode[] = [];
  return (props: Props) => {
    if (previousMap !== props.nodesById) {
      previousMap = props.nodesById;
      allNodes = [...props.nodesById.values()];
    }
    const selection = new Set(props.selectedIds);
    function build(node: DesignNode, flowIndex = 0, frameWidth = node.box.width): Branch | null {
      if (!node.visible || (node.parentId === null && !props.visibleRootIds.has(node.id)))
        return null;
      if (
        props.prototypeMode &&
        node.parentId === null &&
        (node.type !== "artboard" || node.id !== props.prototypeArtboardId)
      )
        return null;
      const viewportWidth = node.type === "artboard" ? node.box.width : frameWidth;
      const parent = props.nodesById.get(node.parentId ?? "");
      let childFlowIndex = 0;
      const children: Branch[] = [];
      for (const child of props.childrenById.get(node.id) ?? []) {
        const branch = build(child, childFlowIndex, viewportWidth);
        if (child.visible && child.positionMode !== "absolute") childFlowIndex++;
        if (branch) children.push(branch);
      }
      const selected = selection.has(node.id),
        cropping = props.cropId === node.id,
        editing = props.editingTextId === node.id;
      const old = previous.get(node);
      const composite = vectorCompositeStyle(node, allNodes, props.tokens, parent);
      if (
        old &&
        old.parent === parent &&
        old.composite.maskImage === composite.maskImage &&
        old.flowIndex === flowIndex &&
        old.viewportWidth === viewportWidth &&
        old.selected === selected &&
        old.cropping === cropping &&
        old.editing === editing &&
        old.children.length === children.length &&
        old.children.every((child, index) => child === children[index])
      )
        return old;
      const branch = {
        node,
        parent,
        flowIndex,
        viewportWidth,
        selected,
        cropping,
        editing,
        children,
        painted: booleanRenderNode(node, allNodes),
        composite,
      };
      previous.set(node, branch);
      return branch;
    }
    return (props.childrenById.get(null) ?? []).flatMap((node) => {
      const branch = build(node);
      return branch ? [branch] : [];
    });
  };
}

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
  const [build] = useState(branchBuilder);
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
