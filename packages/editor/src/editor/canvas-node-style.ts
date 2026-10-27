import type { CSSProperties } from "react";

const defaults = [
  ["boxSizing", "border-box"],
  ["flexDirection", "row"],
  ["flexWrap", "nowrap"],
  ["borderColor", "#000000"],
  ["borderTopColor", "#000000"],
  ["borderRightColor", "#000000"],
  ["borderBottomColor", "#000000"],
  ["borderLeftColor", "#000000"],
  ["borderStyle", "solid"],
  ["borderTopWidth", 0],
  ["borderRightWidth", 0],
  ["borderBottomWidth", 0],
  ["borderLeftWidth", 0],
  ["borderRadius", "0px 0px 0px 0px"],
] as const satisfies readonly (readonly [keyof CSSProperties, string | number])[];

export function omitCanvasStyleDefaults(style: CSSProperties): CSSProperties {
  for (const [property, value] of defaults)
    if (style[property] === value) style[property] = undefined;
  return style;
}
