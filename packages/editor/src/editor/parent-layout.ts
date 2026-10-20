import type { DesignNode } from "../design/document";
import type { ParentLayout } from "../design/node-style";
import { responsiveNode } from "../design/responsive-layout";
import { equalJsonValues } from "../design/json-value";

export type ParentRenderLayout = ParentLayout & Pick<DesignNode, "vectorBoolean" | "mask">;

export function createParentLayouts() {
  const cache = new Map<string, { node: DesignNode; width: number; layout: ParentRenderLayout }>();
  return {
    remove: (id: string) => cache.delete(id),
    get(node: DesignNode | undefined, width: number): ParentRenderLayout | undefined {
      if (!node) return undefined;
      const previous = cache.get(node.id);
      if (previous?.node === node && previous.width === width) return previous.layout;
      const rendered = responsiveNode(node, width);
      const layout: ParentRenderLayout = {
        layout: rendered.layout,
        wrap: rendered.wrap,
        gap: rendered.gap,
        columnGap: rendered.columnGap,
        rowGap: rendered.rowGap,
        box: { width: rendered.box.width, height: rendered.box.height },
        style: {
          borderWidth: rendered.style.borderWidth,
          borderLeftWidth: rendered.style.borderLeftWidth,
          borderRightWidth: rendered.style.borderRightWidth,
          borderTopWidth: rendered.style.borderTopWidth,
          borderBottomWidth: rendered.style.borderBottomWidth,
        },
        vectorBoolean: rendered.vectorBoolean,
        mask: rendered.mask,
      };
      const result =
        previous && equalJsonValues(previous.layout, layout) ? previous.layout : layout;
      cache.set(node.id, { node, width, layout: result });
      return result;
    },
  };
}
