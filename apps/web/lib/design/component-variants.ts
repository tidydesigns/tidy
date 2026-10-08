export * from "@bella/design/component-variants";

import type { DesignNode } from "./document";
import { componentFamily, resolveVariantNodes } from "@bella/design/component-variants";
import { remapInteractions } from "@bella/design/prototype";

/** Detach deleted sources with their current appearance and prune variant child references. */
export function removeComponentReferences(
  nodes: DesignNode[],
  removed: ReadonlySet<string>,
): DesignNode[] {
  const rendered = new Map(resolveVariantNodes(nodes).map((node) => [node.id, node]));
  const remaining = nodes
    .filter((node) => !removed.has(node.id))
    .map((node) => {
      const detached = Boolean(
        (node.instanceOf && removed.has(node.instanceOf)) ||
        (node.componentSourceId && removed.has(node.componentSourceId)),
      );
      const result = detached
        ? {
            ...rendered.get(node.id)!,
            instanceOf: undefined,
            componentSourceId: undefined,
            instanceOverrides: undefined,
            variant: undefined,
          }
        : { ...node };
      if (result.componentProperties)
        result.componentProperties = Object.fromEntries(
          Object.entries(result.componentProperties).filter(
            ([, property]) => !removed.has(property.targetId),
          ),
        );
      if (result.linkTo && removed.has(result.linkTo)) result.linkTo = undefined;
      result.interactions = remapInteractions(result.interactions, (id) =>
        removed.has(id) ? undefined : id,
      );
      if (result.variants)
        result.variants = {
          ...result.variants,
          options: Object.fromEntries(
            Object.entries(result.variants.options).map(([name, option]) => [
              name,
              {
                ...option,
                children: option.children
                  ? Object.fromEntries(
                      Object.entries(option.children).filter(([id]) => !removed.has(id)),
                    )
                  : undefined,
              },
            ]),
          ),
        };
      return result;
    });
  const byId = new Map(remaining.map((node) => [node.id, node]));
  return remaining.map((node) => ({
    ...node,
    interactions: node.interactions?.filter(({ action }) => {
      if (action.type !== "setVariant") return true;
      const target = byId.get(action.target);
      return Boolean(
        target && componentFamily(remaining, target)?.variants.options[action.variant],
      );
    }),
  }));
}
