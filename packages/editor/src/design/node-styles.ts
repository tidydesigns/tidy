import type { DesignNode, VariantNodeChanges } from "./document";

/** Visit base, interaction and variant paints without injecting creation defaults. */
export function mapNodeStyles(
  node: DesignNode,
  map: (style: DesignNode["style"]) => DesignNode["style"],
): DesignNode {
  const states = (value: DesignNode["states"]) =>
    value
      ? Object.fromEntries(
          Object.entries(value).map(([name, style]) => [name, style ? map(style) : style]),
        )
      : value;
  const changes = (patch: VariantNodeChanges): VariantNodeChanges => ({
    ...patch,
    ...(patch.style ? { style: map(patch.style) } : {}),
    ...(patch.states ? { states: states(patch.states) } : {}),
  });
  return {
    ...node,
    style: map(node.style),
    ...(node.states ? { states: states(node.states) } : {}),
    ...(node.variants
      ? {
          variants: {
            ...node.variants,
            options: Object.fromEntries(
              Object.entries(node.variants.options).map(([name, option]) => [
                name,
                {
                  ...(option.root ? { root: changes(option.root) } : {}),
                  ...(option.children
                    ? {
                        children: Object.fromEntries(
                          Object.entries(option.children).map(([id, patch]) => [
                            id,
                            changes(patch),
                          ]),
                        ),
                      }
                    : {}),
                },
              ]),
            ),
          },
        }
      : {}),
  };
}
