"use client";
import { booleanRenderNode, vectorCompositeStyle } from "./vector-composites";

import {
  createElement,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type HTMLAttributes,
} from "react";
import type { DesignDocument, DesignNode } from "@tidy/design/document";
import { childrenByParent } from "@tidy/design/node-hierarchy";
import { nodeStyle } from "./node-style";
import { responsiveNode } from "./responsive-layout";
import { replacePlainText } from "@tidy/design/rich-text-runtime";
import {
  resolveNodeTokens,
  resolvedColorTokens,
  resolvedDocumentNodes,
} from "@tidy/design/design-tokens";
import { DesignText } from "./design-text";
import { ImageMimeProvider } from "./image-context";
import { DesignImage } from "./design-image";
import { NodeFills } from "./node-fills";
import { NodeStrokes } from "./node-strokes";
import type { PrototypeState } from "@tidy/design/prototype";

type Props = {
  document: DesignDocument;
  rootId: string;
  assets: Record<string, string>;
  rootProps?: HTMLAttributes<HTMLElement>;
  frameWidth?: number;
  onAction?: (nodeId: string) => void;
  text?: Record<string, string>;
  variant?: string;
  variants?: Record<string, string>;
  states?: Record<string, PrototypeState>;
  onTrigger?: (nodeId: string, type: "click" | "hover" | "key", key?: string) => boolean;
  /** Pin a paint state for visual review; omitted keeps native interactions. */
  state?: "default" | "hover" | "pressed" | "focus" | "disabled";
  /** Visual review keeps design controls local, including inside host link bridges. */
  readOnly?: boolean;
};
type TreeProps = Props & {
  node: DesignNode;
  parent?: DesignNode;
  flowIndex: number;
  childrenById: Map<string, DesignNode[]>;
  colors: Record<string, string>;
  insideButton?: boolean;
  measuredWidth: number;
  rootRef?: (element: HTMLElement | null) => void;
};

function hasNamingContent(
  node: DesignNode,
  childrenById: Map<string, DesignNode[]>,
  text: Props["text"],
): boolean {
  if (!node.visible || node.semantics?.hidden) return false;
  if (node.type === "text" && (text?.[node.id] ?? node.text)?.trim()) return true;
  if ((node.assetId || node.vectorPath) && (node.semantics?.label ?? node.name).trim()) return true;
  return (childrenById.get(node.id) ?? []).some((child) =>
    hasNamingContent(child, childrenById, text),
  );
}

function RenderNode(props: TreeProps) {
  const { node, parent, document, assets, childrenById, measuredWidth, insideButton } = props;
  const { colors } = props;
  const [hover, setHover] = useState(false),
    [pressed, setPressed] = useState(false),
    [focus, setFocus] = useState(false);
  const responsive = booleanRenderNode(
    resolveNodeTokens(responsiveNode(node, measuredWidth), document),
    document.nodes,
  );
  const original =
    node.type === "text" && props.text?.[node.id] !== undefined
      ? {
          ...responsive,
          ...replacePlainText(
            { text: responsive.text ?? "", richText: responsive.richText },
            props.text[node.id],
          ),
        }
      : responsive;
  const external = node.id === props.rootId ? (props.rootProps ?? {}) : {};
  const explicitState = props.states?.[node.id] ?? props.state;
  const disabled =
    explicitState === "disabled" ||
    ((external as { disabled?: boolean }).disabled ?? node.semantics?.disabled);
  const activeStates = disabled
    ? [original.states?.disabled]
    : explicitState
      ? [explicitState === "default" ? undefined : original.states?.[explicitState]]
      : [
          hover ? original.states?.hover : undefined,
          pressed ? original.states?.pressed : undefined,
          focus ? original.states?.focus : undefined,
        ];
  const override = activeStates.some(Boolean)
    ? (Object.assign({}, ...activeStates.filter(Boolean)) as NonNullable<
        DesignNode["states"]
      >["hover"])
    : undefined;
  const painted = override
    ? {
        ...original,
        style: {
          ...original.style,
          ...override,
          ...(override.fill !== undefined || override.fillToken !== undefined
            ? {
                paints: undefined,
                gradientFrom: undefined,
                gradientTo: undefined,
                fillToken: override.fillToken,
              }
            : {}),
          ...(override.color !== undefined ? { colorToken: override.colorToken } : {}),
          ...(override.borderColor !== undefined || override.borderColorToken !== undefined
            ? { strokePaints: undefined, borderColorToken: override.borderColorToken }
            : {}),
        },
      }
    : original;
  const renderedParent = parent
    ? resolveNodeTokens(responsiveNode(parent, measuredWidth), document)
    : undefined;
  const style: CSSProperties = {
    margin: 0,
    padding: 0,
    background: "transparent",
    font: "inherit",
    textAlign: "left",
    ...nodeStyle(
      painted,
      renderedParent?.layout ?? "absolute",
      colors,
      renderedParent,
      props.flowIndex,
    ),
  };
  Object.assign(style, vectorCompositeStyle(node, document.nodes, colors, parent, assets));
  // Undefined values must not remove the native-control reset above.
  if (!style.background) style.background = "transparent";
  style.color ??= "inherit";
  style.textAlign ??= "left";
  style.textDecoration ??= "none";
  style.listStyle = "none";
  const tag = node.semantics?.element ?? (node.type === "text" || insideButton ? "span" : "div");
  if (tag === "button") {
    style.appearance = "none";
    style.cursor = disabled ? "default" : "pointer";
  }
  if (node.semantics?.hidden) style.pointerEvents = "none";
  if (node.id === props.rootId) {
    style.position = "relative";
    style.left = undefined;
    style.top = undefined;
    style.marginLeft = undefined;
    style.marginTop = undefined;
    style.flex = undefined;
    if (painted.widthMode === "fill") style.width = "100%";
    if (painted.heightMode === "fill") style.height = "100%";
  }
  const href = props.readOnly
    ? undefined
    : ((external as { href?: string }).href ?? node.semantics?.href);
  const nativeControl = tag === "button" || (tag === "a" && !!href);
  const hasHoverAction = node.interactions?.some((item) => item.trigger.type === "hover");
  const interactive =
    !!props.onTrigger &&
    (nativeControl ||
      node.linkTo ||
      node.interactions?.some((item) => ["click", "key", "hover"].includes(item.trigger.type)));
  const label =
    external["aria-label"] ??
    node.semantics?.label ??
    (interactive &&
    !external["aria-labelledby"] &&
    !external.title?.trim() &&
    !hasNamingContent(node, childrenById, props.text)
      ? node.name
      : undefined);
  const attributes = {
    ...external,
    ref: props.rootRef,
    style: { ...style, ...external.style },
    "aria-label": label,
    "aria-hidden": node.semantics?.hidden || undefined,
    inert: node.semantics?.hidden || external.inert || undefined,
    ...(props.onTrigger
      ? {
          "data-prototype-node": node.id,
          "aria-disabled": tag === "button" ? undefined : disabled || undefined,
          ...(!nativeControl && interactive && !disabled ? { role: "button", tabIndex: 0 } : {}),
        }
      : {}),
    ...(tag === "a"
      ? {
          href,
        }
      : {}),
    ...(tag === "button"
      ? {
          type: props.readOnly
            ? "button"
            : ((external as { type?: string }).type ?? node.semantics?.buttonType ?? "button"),
          disabled,
        }
      : {}),
    onClick: (event: React.MouseEvent<HTMLElement>) => {
      external.onClick?.(event);
      if (props.onTrigger) {
        event.preventDefault();
        if (disabled) {
          event.stopPropagation();
          return;
        }
        if (!disabled && props.onTrigger(node.id, "click")) event.stopPropagation();
        return;
      }
      if (
        !event.defaultPrevented &&
        !disabled &&
        props.onAction &&
        (["button", "a"].includes(tag) || node.linkTo)
      ) {
        event.stopPropagation();
        props.onAction(node.id);
      }
    },
    onMouseEnter: (event: React.MouseEvent<HTMLElement>) => {
      setHover(true);
      external.onMouseEnter?.(event);
      if (!disabled) props.onTrigger?.(node.id, "hover");
    },
    onMouseLeave: (event: React.MouseEvent<HTMLElement>) => {
      setHover(false);
      setPressed(false);
      external.onMouseLeave?.(event);
    },
    onPointerDown: (event: React.PointerEvent<HTMLElement>) => {
      setPressed(true);
      external.onPointerDown?.(event);
    },
    onPointerUp: (event: React.PointerEvent<HTMLElement>) => {
      setPressed(false);
      external.onPointerUp?.(event);
    },
    onPointerCancel: (event: React.PointerEvent<HTMLElement>) => {
      setPressed(false);
      external.onPointerCancel?.(event);
    },
    onFocus: (event: React.FocusEvent<HTMLElement>) => {
      const focusVisible = event.target.matches(":focus-visible");
      setFocus(focusVisible);
      external.onFocus?.(event);
      if (
        !event.defaultPrevented &&
        event.target === event.currentTarget &&
        focusVisible &&
        !disabled &&
        hasHoverAction
      )
        props.onTrigger?.(node.id, "hover");
    },
    onBlur: (event: React.FocusEvent<HTMLElement>) => {
      setFocus(false);
      setPressed(false);
      external.onBlur?.(event);
    },
    onKeyDown: (event: React.KeyboardEvent<HTMLElement>) => {
      if (event.key === " " || event.key === "Enter") setPressed(true);
      external.onKeyDown?.(event);
      if (
        !disabled &&
        !event.repeat &&
        props.onTrigger &&
        (props.onTrigger(node.id, "key", event.key) ||
          (!nativeControl &&
            [" ", "Enter"].includes(event.key) &&
            props.onTrigger(node.id, "click")))
      ) {
        event.preventDefault();
        event.stopPropagation();
      }
    },
    onKeyUp: (event: React.KeyboardEvent<HTMLElement>) => {
      setPressed(false);
      external.onKeyUp?.(event);
    },
  };
  let index = 0;
  return createElement(
    tag,
    attributes,
    <>
      <NodeStrokes node={painted} tokens={colors} />
      <NodeFills node={painted} tokens={colors} assetUrl={(id) => assets[id]} />
    </>,
    node.type === "text" ? (
      <DesignText node={painted} />
    ) : (
      (node.assetId || painted.vectorPath) && (
        <DesignImage
          tokens={colors}
          node={painted}
          src={node.assetId ? assets[node.assetId] : undefined}
        />
      )
    ),
    (childrenById.get(node.id) ?? [])
      .filter((child) => child.visible)
      .map((child) => {
        const flowIndex = index;
        if (child.positionMode !== "absolute") index++;
        return (
          <RenderNode
            key={child.id}
            {...props}
            node={child}
            parent={node}
            rootRef={undefined}
            flowIndex={flowIndex}
            insideButton={insideButton || tag === "button"}
          />
        );
      }),
  );
}

/** Standalone runtime bundled for handoff. It imports only React in the exported artifact. */
export function TidyDesign({
  document,
  rootId,
  assets,
  rootProps,
  frameWidth,
  onAction,
  text,
  variant,
  variants,
  states,
  onTrigger,
  state,
  readOnly,
}: Props) {
  const nodes = resolvedDocumentNodes(
    document,
    variants || variant !== undefined
      ? new Map([
          ...Object.entries(variants ?? {}),
          ...(variant !== undefined ? [[rootId, variant] as [string, string]] : []),
        ])
      : undefined,
  );
  const renderedDocument = { ...document, nodes };
  const root = nodes.find((node) => node.id === rootId);
  const ref = useRef<HTMLElement | null>(null);
  const [width, setWidth] = useState(frameWidth ?? root?.box.width ?? 1);
  useEffect(() => {
    if (!ref.current || frameWidth !== undefined) return;
    const observer = new ResizeObserver(([entry]) => {
      const box = entry.borderBoxSize[0];
      setWidth(box?.inlineSize ?? entry.contentRect.width);
    });
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, [frameWidth]);
  if (!root?.visible) return null;
  const childrenById = childrenByParent(nodes);
  return (
    <ImageMimeProvider types={document.assetMimeTypes}>
      <RenderNode
        document={renderedDocument}
        rootId={rootId}
        assets={assets}
        rootProps={rootProps}
        onAction={onAction}
        onTrigger={onTrigger}
        states={states}
        state={state}
        readOnly={readOnly}
        text={text}
        node={root}
        childrenById={childrenById}
        colors={resolvedColorTokens(renderedDocument)}
        measuredWidth={frameWidth ?? width}
        flowIndex={0}
        rootRef={(element) => {
          ref.current = element;
        }}
      />
    </ImageMimeProvider>
  );
}
