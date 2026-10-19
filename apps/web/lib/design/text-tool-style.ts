import type { DesignNode } from "./document";

export type TextToolStyle = Pick<
  DesignNode["style"],
  | "fontFamily"
  | "fontSource"
  | "fontFace"
  | "fontSize"
  | "fontWeight"
  | "fontStyle"
  | "lineHeight"
  | "lineHeightMode"
  | "lineHeightPx"
  | "letterSpacing"
  | "paragraphSpacing"
  | "textAlign"
  | "textVerticalAlign"
  | "textDecoration"
  | "textCase"
  | "color"
> &
  Required<Pick<DesignNode["style"], "fontSize" | "fontWeight" | "color">>;

/** Reuse typography without inheriting geometry, clipping, effects, or token references. */
export function textToolStyle({ style }: Pick<DesignNode, "style">): TextToolStyle {
  return {
    fontFamily: style.fontFamily,
    fontSource: style.fontSource,
    fontFace: style.fontFace,
    fontSize: style.fontSize ?? 16,
    fontWeight: style.fontWeight ?? 400,
    fontStyle: style.fontStyle,
    lineHeight: style.lineHeight,
    lineHeightMode: style.lineHeightMode,
    lineHeightPx: style.lineHeightPx,
    letterSpacing: style.letterSpacing,
    paragraphSpacing: style.paragraphSpacing,
    textAlign: style.textAlign,
    textVerticalAlign: style.textVerticalAlign,
    textDecoration: style.textDecoration,
    textCase: style.textCase,
    color: style.color ?? "#1e1e1e",
  };
}
