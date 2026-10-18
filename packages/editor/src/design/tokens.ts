import { parseDesignDocument, type DesignDocument } from "./document";

import { mapNodeStyles } from "./node-styles";
import { mapPaintTokens } from "./paints";
import {
  bindingPath,
  mapTokenBindings,
  resolveNodeTokens,
  resolvedDesignTokens,
  typographyProperties,
  type DesignTokens,
  type TokenBinding,
} from "./design-tokens";
import type { DesignNode, VariantNodeChanges } from "./document";
import { equalJsonValues } from "./json-value";

const colorBindings = {
  fillToken: "fill",
  colorToken: "color",
  borderColorToken: "borderColor",
} as const;

export function renameColorToken(
  document: DesignDocument,
  name: string,
  next: string,
): DesignDocument {
  if (name === next) return document;
  if (!Object.hasOwn(document.tokens, name) && !Object.hasOwn(document.designTokens ?? {}, name))
    throw new Error("Token not found.");
  if (Object.hasOwn(document.tokens, next) || Object.hasOwn(document.designTokens ?? {}, next))
    throw new Error("A token with that name already exists.");
  const tokens = Object.fromEntries(
    Object.entries(document.tokens).map(([key, value]) => [key === name ? next : key, value]),
  );
  return parseDesignDocument({
    ...document,
    tokens,
    ...(document.designTokens
      ? {
          designTokens: Object.fromEntries(
            Object.entries(document.designTokens).map(([key, token]) => [
              key === name ? next : key,
              "alias" in token && token.alias === name ? { ...token, alias: next } : token,
            ]),
          ),
        }
      : {}),
    nodes: document.nodes.map((node) =>
      mapNodeStyles(
        mapTokenBindings(node, (token) => (token === name ? next : token)),
        (style) => ({
          ...style,
          ...(style.strokePaints
            ? {
                strokePaints: mapPaintTokens(style.strokePaints, (token, color) => ({
                  token: token === name ? next : token,
                  color,
                })),
              }
            : {}),
          ...(style.paints
            ? {
                paints: mapPaintTokens(style.paints, (token, color) => ({
                  token: token === name ? next : token,
                  color,
                })),
              }
            : {}),
          ...Object.fromEntries(
            Object.keys(colorBindings)
              .filter((key) => style[key as keyof typeof colorBindings] === name)
              .map((key) => [key, next]),
          ),
        }),
      ),
    ),
  });
}

export function removeColorToken(document: DesignDocument, name: string): DesignDocument {
  const tokens = { ...document.tokens };
  const resolved = resolvedDesignTokens(document).get(name);
  const value = resolved?.type === "color" && "value" in resolved ? resolved.value : undefined;
  delete tokens[name];
  const designTokens = Object.fromEntries(
    Object.entries(document.designTokens ?? {})
      .filter(([key]) => key !== name)
      .map(([key, token]) => [key, "alias" in token && token.alias === name ? resolved! : token]),
  );
  const materialize = <T extends DesignNode | VariantNodeChanges>(
    source: T,
    base: DesignNode,
  ): T => {
    const current = resolveNodeTokens(
      {
        ...base,
        ...source,
        style: { ...base.style, ...source.style },
        box: { ...base.box, ...source.box },
      },
      document,
    );
    const output = {
      ...source,
      ...(source.tokenBindings ? { tokenBindings: { ...source.tokenBindings } } : {}),
    };
    for (const [binding, token] of Object.entries(source.tokenBindings ?? {})) {
      if (token !== name) continue;
      output.tokenBindings![binding as TokenBinding] = null;
      if (binding === "textStyle")
        output.style = {
          ...source.style,
          ...Object.fromEntries(typographyProperties.map((key) => [key, current.style[key]])),
        };
      else {
        const [group, key] = bindingPath(binding as TokenBinding).split(".");
        if (group === "box" && key)
          output.box = { ...output.box, [key]: current.box[key as "width"] } as T["box"];
        else if (group === "style" && key)
          output.style = { ...output.style, [key]: current.style[key as "radius"] };
        else Object.assign(output, { [group!]: current[group as keyof DesignNode] });
      }
    }
    return output;
  };
  return parseDesignDocument({
    ...document,
    tokens,
    ...(document.designTokens ? { designTokens } : {}),
    nodes: document.nodes.map((node) =>
      mapNodeStyles(
        {
          ...materialize(node, node),
          ...(node.variants
            ? {
                variants: {
                  ...node.variants,
                  options: Object.fromEntries(
                    Object.entries(node.variants.options).map(([key, option]) => [
                      key,
                      {
                        ...option,
                        ...(option.root ? { root: materialize(option.root, node) } : {}),
                        ...(option.children
                          ? {
                              children: Object.fromEntries(
                                Object.entries(option.children).map(([id, patch]) => [
                                  id,
                                  materialize(
                                    patch,
                                    document.nodes.find((item) => item.id === id)!,
                                  ),
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
        },
        (source) => {
          const style = { ...source };
          for (const [binding, property] of Object.entries(colorBindings) as [
            keyof typeof colorBindings,
            (typeof colorBindings)[keyof typeof colorBindings],
          ][]) {
            if (style[binding] === name) {
              style[binding] = undefined;
              if (value) style[property] = value;
            }
          }
          if (style.strokePaints)
            style.strokePaints = mapPaintTokens(style.strokePaints, (token, color) =>
              token === name ? { token: undefined, color: value ?? color } : { token, color },
            );
          if (style.paints)
            style.paints = mapPaintTokens(style.paints, (token, color) =>
              token === name ? { token: undefined, color: value ?? color } : { token, color },
            );
          return style;
        },
      ),
    ),
  });
}

export const renameDesignToken = renameColorToken;
export const removeDesignToken = removeColorToken;

/** Merge a source token graph without changing destination definitions; remap dependencies too. */
export function importTokenDefinitions(
  current: Pick<DesignDocument, "tokens" | "designTokens">,
  incoming: Pick<DesignDocument, "tokens" | "designTokens">,
  referenced?: Set<string>,
) {
  const tokens = { ...current.tokens },
    designTokens: DesignTokens = { ...current.designTokens };
  const names = new Map<string, string>();
  resolvedDesignTokens(incoming);
  const definition = (document: typeof incoming, name: string) =>
    Object.hasOwn(document.designTokens ?? {}, name)
      ? document.designTokens![name]
      : Object.hasOwn(document.tokens, name)
        ? document.tokens[name]
        : undefined;
  function add(name: string): string | undefined {
    if (names.has(name)) return names.get(name);
    const source = definition(incoming, name);
    if (!source) return undefined;
    const value =
      typeof source !== "string" && "alias" in source
        ? { ...source, alias: add(source.alias)! }
        : source;
    let next = name;
    for (
      let suffix = 2;
      definition({ tokens, designTokens }, next) !== undefined &&
      !equalJsonValues(definition({ tokens, designTokens }, next), value);
      suffix++
    )
      next = `${name.slice(0, 56)}_${suffix}`;
    names.set(name, next);
    if (typeof value === "string") tokens[next] = value;
    else designTokens[next] = value;
    return next;
  }
  for (const name of referenced ??
    new Set([...Object.keys(incoming.tokens), ...Object.keys(incoming.designTokens ?? {})]))
    add(name);
  const mapStyle = (style: DesignNode["style"]): DesignNode["style"] => ({
    ...style,
    ...Object.fromEntries(
      Object.keys(colorBindings)
        .filter((key) => style[key as keyof typeof colorBindings])
        .map((key) => [key, names.get(style[key as keyof typeof colorBindings]!)]),
    ),
    ...(style.paints
      ? {
          paints: mapPaintTokens(style.paints, (token, color) => ({
            token: names.get(token),
            color,
          })),
        }
      : {}),
    ...(style.strokePaints
      ? {
          strokePaints: mapPaintTokens(style.strokePaints, (token, color) => ({
            token: names.get(token),
            color,
          })),
        }
      : {}),
  });
  return {
    tokens,
    ...(Object.keys(designTokens).length || current.designTokens ? { designTokens } : {}),
    node: (node: DesignNode) =>
      mapNodeStyles(
        mapTokenBindings(node, (name) => names.get(name) ?? null),
        mapStyle,
      ),
    style: (node: DesignNode) => mapStyle(node.style),
  };
}
