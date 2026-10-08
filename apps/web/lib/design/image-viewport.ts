import type { DesignNode } from "./document";

/** The image element occupies the content box; fills occupy the padding box. Both exclude CSS borders. */
export function imageViewport(node: DesignNode, box = node.box, fill = false) {
  const border = node.style.borderWidth ?? 0;
  const left =
    (node.style.borderLeftWidth ?? border) + (fill ? 0 : (node.paddingLeft ?? node.padding ?? 0));
  const right =
    (node.style.borderRightWidth ?? border) + (fill ? 0 : (node.paddingRight ?? node.padding ?? 0));
  const top =
    (node.style.borderTopWidth ?? border) + (fill ? 0 : (node.paddingTop ?? node.padding ?? 0));
  const bottom =
    (node.style.borderBottomWidth ?? border) +
    (fill ? 0 : (node.paddingBottom ?? node.padding ?? 0));
  return {
    x: box.x + left,
    y: box.y + top,
    width: Math.max(1, box.width - left - right),
    height: Math.max(1, box.height - top - bottom),
  };
}
