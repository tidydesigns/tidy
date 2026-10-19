"use client";
import type { TextContent } from "@tidy/design/rich-text";

import {
  memo,
  useCallback,
  useMemo,
  useState,
  type MouseEvent,
  type PointerEvent,
  type ReactElement,
} from "react";
import type { DesignNode } from "../design/document";
import { createArtworkBranches, type Branch } from "./artwork-branches";
import { nodeStyle } from "../design/node-style";
import { responsiveNode } from "../design/responsive-layout";
import { NodeStrokes } from "@tidy/design-renderer/node-strokes";
import { NodeFills } from "@tidy/design-renderer/node-fills";
import { DesignText } from "@tidy/design-renderer/design-text";
import { DesignImage } from "@tidy/design-renderer/design-image";
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
  renderBranch,
}: {
  branch: Branch;
  tokens: Props["tokens"];
  previewAssetUrls: Props["previewAssetUrls"];
  handlers: Handlers;
  renderBranch: (branch: Branch) => ReactElement;
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
      ? "2px solid var(--color-primary-orange)"
      : node.style.outlineWidth
        ? `${node.style.outlineWidth}px solid ${node.style.outlineColor ?? "#000000"}`
        : undefined,
    outlineOffset: selected ? "1px" : undefined,
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
      {children.map(renderBranch)}
    </div>
  );
});

/** Cache element identity as well as branch identity. A selection change must
 * not allocate a fresh React element for every unchanged sibling in an artboard. */
function createArtworkRenderer({
  tokens,
  previewAssetUrls,
  handlers,
}: {
  tokens: Props["tokens"];
  previewAssetUrls: Props["previewAssetUrls"];
  handlers: Handlers;
}) {
  const elements = new WeakMap<Branch, ReactElement>();
  function renderBranch(branch: Branch): ReactElement {
    let element = elements.get(branch);
    if (!element) {
      element = (
        <ArtworkNode
          key={branch.node.id}
          branch={branch}
          tokens={tokens}
          previewAssetUrls={previewAssetUrls}
          handlers={handlers}
          renderBranch={renderBranch}
        />
      );
      elements.set(branch, element);
    }
    return element;
  }
  return renderBranch;
}

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
  const renderBranch = useMemo(
    () =>
      createArtworkRenderer({
        tokens: props.tokens,
        previewAssetUrls: props.previewAssetUrls,
        handlers,
      }),
    [props.tokens, props.previewAssetUrls, handlers],
  );
  return (
    <ImageMimeProvider types={props.assetMimeTypes}>
      {build(props).map(renderBranch)}
    </ImageMimeProvider>
  );
});
