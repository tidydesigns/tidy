import type { DesignNode } from "./document";

export function renderedNodeBox(element: HTMLElement): DesignNode["box"] {
  const style = getComputedStyle(element);
  return {
    x: parseFloat(style.left) || element.offsetLeft,
    y: parseFloat(style.top) || element.offsetTop,
    width: parseFloat(style.width),
    height: parseFloat(style.height),
  };
}

/** Read the untransformed padding box used by positioned children. */
export function renderedParentSize(element: HTMLElement) {
  const style = getComputedStyle(element.parentElement!);
  return {
    width: Math.max(
      1,
      parseFloat(style.width) -
        parseFloat(style.borderLeftWidth) -
        parseFloat(style.borderRightWidth),
    ),
    height: Math.max(
      1,
      parseFloat(style.height) -
        parseFloat(style.borderTopWidth) -
        parseFloat(style.borderBottomWidth),
    ),
  };
}
