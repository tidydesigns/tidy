import { strokeStyle } from "./strokes";
import { effectCss, shadowCss } from "@bella/design/effects";
import type { CSSProperties } from "react";
import type { DesignNode } from "@bella/design/document";
import { paintBackground } from "./paints";
import { constraintStyle } from "./constraints";
import { renderFontFamily } from "./font-family";

function gridTrackStyle(track: NonNullable<DesignNode["gridColumnTracks"]>[number]) {
  return track.unit === "auto"
    ? "auto"
    : track.unit === "fr"
      ? `minmax(0, ${track.value}fr)`
      : `${track.value}px`;
}

/** Shared visual rules for the full canvas and file thumbnails. */
export function nodeStyle(
  node: DesignNode,
  parentLayout: DesignNode["layout"],
  tokens: Record<string, string>,
  parent?: DesignNode,
  flowIndex = 0,
): CSSProperties {
  const solePaint = node.style.paints?.length === 1 ? node.style.paints[0] : undefined;
  const simplePaint =
    solePaint?.visible &&
    solePaint.opacity === 1 &&
    (!solePaint.blendMode || solePaint.blendMode === "normal") &&
    solePaint.type !== "image" &&
    !(solePaint.type === "linear" && solePaint.start) &&
    !(solePaint.type === "radial" && solePaint.rotation)
      ? paintBackground(solePaint, tokens)
      : undefined;
  const color = node.style.colorToken
    ? (tokens[node.style.colorToken] ?? node.style.color)
    : node.style.color;
  const fill = node.style.fillToken
    ? (tokens[node.style.fillToken] ?? node.style.fill)
    : node.style.fill;
  const borderColor = node.style.borderColorToken
    ? (tokens[node.style.borderColorToken] ?? node.style.borderColor)
    : node.style.borderColor;
  const absolute = parentLayout === "absolute" || node.positionMode === "absolute";
  const mainFill =
    !absolute &&
    (parentLayout === "flex-column" ? node.heightMode === "fill" : node.widthMode === "fill");
  const crossFill =
    parentLayout === "flex-column" ? node.widthMode === "fill" : node.heightMode === "fill";
  const radius = node.style.radius ?? 0;
  const border = node.style.borderWidth ?? 0;
  const parentGap =
    parentLayout === "flex-row"
      ? (parent?.columnGap ?? parent?.gap ?? 0)
      : (parent?.rowGap ?? parent?.gap ?? 0);
  const overlap =
    !absolute && !parent?.wrap && flowIndex > 0 && parentGap < 0 ? parentGap : undefined;
  const flowMargin =
    !absolute && (parentLayout === "flex-row" || parentLayout === "flex-column")
      ? (overlap ?? 0) + (node.flowGapBefore ?? 0)
      : 0;
  const crossOffset =
    !absolute && (parentLayout === "flex-row" || parentLayout === "flex-column")
      ? node.flowCrossOffset
      : undefined;
  return {
    position: absolute ? "absolute" : "relative",
    left: absolute ? node.box.x : parentLayout === "flex-column" ? crossOffset : undefined,
    top: absolute ? node.box.y : parentLayout === "flex-row" ? crossOffset : undefined,
    marginLeft: parentLayout === "flex-row" && !absolute && flowMargin ? flowMargin : undefined,
    marginTop: parentLayout === "flex-column" && !absolute && flowMargin ? flowMargin : undefined,
    width:
      node.widthMode === "fill" && node.parentId !== null
        ? absolute
          ? `calc(100% - ${node.box.x}px)`
          : parentLayout === "grid"
            ? "100%"
            : undefined
        : node.widthMode === "hug"
          ? "max-content"
          : node.box.width,
    height:
      node.heightMode === "fill" && node.parentId !== null
        ? absolute
          ? `calc(100% - ${node.box.y}px)`
          : parentLayout === "grid"
            ? "100%"
            : undefined
        : node.heightMode === "hug"
          ? "max-content"
          : node.box.height,
    minWidth: node.minWidth ?? (node.widthMode === "fill" ? 0 : undefined),
    maxWidth: node.maxWidth,
    minHeight: node.minHeight ?? (node.heightMode === "fill" ? 0 : undefined),
    maxHeight: node.maxHeight,
    flex: !absolute && parentLayout !== "grid" ? (mainFill ? "1 1 0px" : "0 0 auto") : undefined,
    alignSelf:
      node.alignSelf && node.alignSelf !== "auto"
        ? node.alignSelf === "start"
          ? "flex-start"
          : node.alignSelf === "end"
            ? "flex-end"
            : node.alignSelf
        : crossFill && !absolute
          ? "stretch"
          : undefined,
    boxSizing: "border-box",
    display:
      node.type === "text"
        ? "flex"
        : node.layout === "absolute"
          ? undefined
          : node.layout === "grid"
            ? "grid"
            : "flex",
    flexDirection: node.type === "text" || node.layout === "flex-column" ? "column" : "row",
    flexWrap: node.wrap ? "wrap" : "nowrap",
    gridTemplateColumns:
      node.layout === "grid"
        ? (node.gridColumnTracks?.map(gridTrackStyle).join(" ") ??
          `repeat(${node.gridColumns ?? 2}, minmax(0, 1fr))`)
        : undefined,
    gridTemplateRows:
      node.layout === "grid" ? node.gridRowTracks?.map(gridTrackStyle).join(" ") : undefined,
    gridColumn:
      !absolute && parentLayout === "grid" && node.gridColumnSpan && node.gridColumnSpan > 1
        ? `span ${node.gridColumnSpan}`
        : undefined,
    gridRow:
      !absolute && parentLayout === "grid" && node.gridRowSpan && node.gridRowSpan > 1
        ? `span ${node.gridRowSpan}`
        : undefined,
    columnGap: node.columnGap ?? (node.gap !== undefined ? Math.max(0, node.gap) : undefined),
    rowGap: node.rowGap ?? (node.gap !== undefined ? Math.max(0, node.gap) : undefined),
    paddingTop: node.paddingTop ?? node.padding,
    paddingRight: node.paddingRight ?? node.padding,
    paddingBottom: node.paddingBottom ?? node.padding,
    paddingLeft: node.paddingLeft ?? node.padding,
    alignItems:
      node.align === "start" ? "flex-start" : node.align === "end" ? "flex-end" : node.align,
    justifyContent:
      node.type === "text"
        ? node.style.textVerticalAlign === "center"
          ? "center"
          : node.style.textVerticalAlign === "bottom"
            ? "flex-end"
            : "flex-start"
        : node.justify === "start"
          ? "flex-start"
          : node.justify === "end"
            ? "flex-end"
            : node.justify,
    isolation: node.style.paints ? "isolate" : undefined,
    background: node.style.paints
      ? simplePaint
      : node.style.gradientFrom && node.style.gradientTo
        ? `linear-gradient(${node.style.gradientAngle ?? 180}deg, ${node.style.gradientFrom}, ${node.style.gradientTo})`
        : fill,
    color,
    borderColor: borderColor ?? "#000000",
    borderStyle: node.style.borderStyle ?? "solid",
    borderTopWidth: node.style.borderTopWidth ?? border,
    borderRightWidth: node.style.borderRightWidth ?? border,
    borderBottomWidth: node.style.borderBottomWidth ?? border,
    borderLeftWidth: node.style.borderLeftWidth ?? border,
    borderRadius: `${node.style.radiusTopLeft ?? radius}px ${node.style.radiusTopRight ?? radius}px ${node.style.radiusBottomRight ?? radius}px ${node.style.radiusBottomLeft ?? radius}px`,
    opacity: node.style.opacity,
    boxShadow: shadowCss(node.style),
    outline: node.style.outlineWidth
      ? `${node.style.outlineWidth}px solid ${node.style.outlineColor ?? "#000000"}`
      : undefined,
    filter: effectCss(node.style),
    backdropFilter: node.style.backdropBlur ? `blur(${node.style.backdropBlur}px)` : undefined,
    mixBlendMode: node.style.blendMode,
    transform:
      [
        node.style.rotation ? `rotate(${node.style.rotation}deg)` : undefined,
        node.style.flipX ? "scaleX(-1)" : undefined,
        node.style.flipY ? "scaleY(-1)" : undefined,
      ]
        .filter(Boolean)
        .join(" ") || undefined,
    fontSize: node.style.fontSize,
    fontWeight: node.style.fontWeight,
    lineHeight:
      node.style.lineHeightMode === "auto"
        ? "normal"
        : node.style.lineHeightMode === "px"
          ? `${node.style.lineHeightPx ?? (node.style.fontSize ?? 16) * (node.style.lineHeight ?? 1.35)}px`
          : node.style.lineHeightMode === "percent"
            ? (node.style.lineHeight ?? 1.35)
            : node.style.lineHeight,
    textAlign: node.style.textAlign,
    fontFamily: renderFontFamily(
      node.style.fontFamily ?? (node.type === "text" ? "system-ui" : undefined),
      node.style.fontSource === "local" ? node.style.fontFace : undefined,
    ),
    letterSpacing: node.style.letterSpacing,
    fontStyle: node.style.fontStyle,
    textDecoration: node.richText ? "none" : node.style.textDecoration,
    overflow:
      node.style.maxLines ||
      (node.type === "text" &&
        node.style.textWrap === "nowrap" &&
        node.style.textOverflow === "ellipsis")
        ? "hidden"
        : (node.style.overflow ??
          (["artboard", "image"].includes(node.type) ? "hidden" : undefined)),
    textTransform: node.style.textCase,
    whiteSpace:
      node.type === "text" ? (node.style.textWrap === "nowrap" ? "pre" : "pre-wrap") : undefined,
    ...constraintStyle(node, parent, absolute),
    ...strokeStyle(node, tokens),
    ...(node.vectorPath
      ? {
          background: undefined,
          borderTopWidth: 0,
          borderRightWidth: 0,
          borderBottomWidth: 0,
          borderLeftWidth: 0,
          borderImageSource: undefined,
          borderImageOutset: undefined,
        }
      : {}),
  };
}

export function imageStyle(node: DesignNode): CSSProperties {
  return {
    display: "block",
    width: "100%",
    height: "100%",
    objectFit: node.style.objectFit ?? "contain",
    objectPosition: `${node.style.objectPositionX ?? 50}% ${node.style.objectPositionY ?? 50}%`,
    transform: node.style.objectScale ? `scale(${node.style.objectScale})` : undefined,
    transformOrigin: `${node.style.objectPositionX ?? 50}% ${node.style.objectPositionY ?? 50}%`,
  };
}
