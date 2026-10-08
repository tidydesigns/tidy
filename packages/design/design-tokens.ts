import type { DesignDocument, DesignNode, DesignNodeChanges, VariantNodeChanges } from "./document";
import { bindingKinds, type TokenBinding } from "./token-bindings";
import type { DesignToken } from "./token-schema";
import { resolveVariantNodes } from "./component-variants";

type TokenDocument = Pick<DesignDocument, "tokens" | "designTokens">;
export const typographyProperties = [
  "fontFamily",
  "fontSource",
  "fontFace",
  "fontSize",
  "fontWeight",
  "fontStyle",
  "lineHeight",
  "lineHeightMode",
  "lineHeightPx",
  "letterSpacing",
  "paragraphSpacing",
  "textCase",
  "textDecoration",
] as const;
const styleProperties = new Set<string>([
  "radius",
  "radiusTopLeft",
  "radiusTopRight",
  "radiusBottomLeft",
  "radiusBottomRight",
  ...typographyProperties,
]);
export function bindingPath(binding: TokenBinding) {
  return binding === "width" || binding === "height"
    ? `box.${binding}`
    : styleProperties.has(binding)
      ? `style.${binding}`
      : binding;
}

export function tokenBindingExclusions(paths: readonly string[]) {
  const result = [...paths];
  const excluded = (path: string) =>
    paths.some((key) => path === key || path.startsWith(`${key}.`));
  for (const binding of Object.keys(bindingKinds) as TokenBinding[]) {
    const token = `tokenBindings.${binding}`;
    const properties =
      binding === "textStyle"
        ? typographyProperties.map((key) => `style.${key}`)
        : [bindingPath(binding)];
    if (excluded(token) || properties.some(excluded)) result.push(token, ...properties);
  }
  return result;
}

/** Resolve aliases once per document. Old color records retain their original wire format. */
const tokenCache = new WeakMap<object, WeakMap<object, Map<string, DesignToken>>>();
const emptyTokens = {};
export function resolvedDesignTokens(document: TokenDocument): Map<string, DesignToken> {
  const typed = document.designTokens ?? emptyTokens;
  let colors = tokenCache.get(typed);
  if (!colors) {
    colors = new WeakMap();
    tokenCache.set(typed, colors);
  }
  const cached = colors.get(document.tokens);
  if (cached) return cached;
  const result = new Map<string, DesignToken>();
  const visiting = new Set<string>();
  function resolve(name: string): DesignToken {
    const prior = result.get(name);
    if (prior) return prior;
    if (visiting.has(name)) throw new Error(`Token alias cycle at ${name}.`);
    const token =
      document.designTokens && Object.hasOwn(document.designTokens, name)
        ? document.designTokens[name]
        : undefined;
    if (token && Object.hasOwn(document.tokens, name))
      throw new Error(`Duplicate token name: ${name}.`);
    if (!token) {
      if (!Object.hasOwn(document.tokens, name)) throw new Error(`Token not found: ${name}.`);
      const color: DesignToken = { type: "color", value: document.tokens[name]! };
      result.set(name, color);
      return color;
    }
    visiting.add(name);
    const value = "alias" in token ? resolve(token.alias) : token;
    visiting.delete(name);
    if (value.type !== token.type) throw new Error(`Token ${name} aliases a different type.`);
    result.set(name, value);
    return value;
  }
  for (const name of [...Object.keys(document.tokens), ...Object.keys(typed)]) resolve(name);
  colors.set(document.tokens, result);
  return result;
}

const nodeCache = new WeakMap<DesignNode, { key: string; node: DesignNode }>();
export function resolveNodeTokens(node: DesignNode, document: TokenDocument): DesignNode {
  const entries = Object.entries(node.tokenBindings ?? {}).filter((entry) => Boolean(entry[1]));
  if (!entries.length) return node;
  const tokens = resolvedDesignTokens(document);
  const values = entries.map(([binding, name]) => {
    const token = tokens.get(name!);
    if (!token || token.type !== bindingKinds[binding as TokenBinding] || !("value" in token))
      throw new Error(
        `Layer ${node.id}: ${binding} needs a ${bindingKinds[binding as TokenBinding]} token (${name}).`,
      );
    if (binding === "textStyle" && node.type !== "text")
      throw new Error("Text styles require a text layer.");
    return [binding, token.value] as const;
  });
  const key = JSON.stringify(values);
  const cached = nodeCache.get(node);
  if (cached?.key === key) return cached.node;
  const result = { ...node, box: { ...node.box }, style: { ...node.style } };
  // Individual typography bindings override a reusable text style.
  const text = values.find(([key]) => key === "textStyle")?.[1];
  if (typeof text === "object") Object.assign(result.style, text);
  for (const [binding, value] of values) {
    if (binding === "textStyle") continue;
    if (binding === "width" || binding === "height")
      Object.assign(result.box, { [binding]: value });
    else if (styleProperties.has(binding)) Object.assign(result.style, { [binding]: value });
    else Object.assign(result, { [binding]: value });
  }
  if (node.tokenBindings?.width) result.widthMode = "fixed";
  if (node.tokenBindings?.height) result.heightMode = "fixed";
  nodeCache.set(node, { key, node: result });
  return result;
}

/** Materialize inherited token values before a variant's literal overrides detach a binding. */
export function resolvedDocumentNodes(
  document: TokenDocument & Pick<DesignDocument, "nodes">,
  selections?: ReadonlyMap<string, string>,
  skipFamilies?: ReadonlySet<string>,
) {
  const bases = document.nodes.map((node) => resolveNodeTokens(node, document));
  return resolveVariantNodes(bases, selections, skipFamilies).map((node) =>
    resolveNodeTokens(node, document),
  );
}

export function resolvedColorTokens(document: TokenDocument): Record<string, string> {
  if (!Object.values(document.designTokens ?? {}).some((token) => token.type === "color"))
    return document.tokens;
  return Object.fromEntries(
    [...resolvedDesignTokens(document)].flatMap(([name, token]) =>
      token.type === "color" && "value" in token ? [[name, token.value]] : [],
    ),
  );
}

/** A literal edit detaches just that binding; unrelated bindings remain live. */
export function detachChangedBindings(
  node: DesignNode,
  changes: DesignNodeChanges | VariantNodeChanges,
  exclusions: readonly string[] = [],
) {
  const bindings = { ...node.tokenBindings };
  const changed = (path: string) => {
    if (exclusions.some((key) => path === key || path.startsWith(`${key}.`))) return false;
    const [group, property] = path.split(".") as [string, string | undefined];
    return property
      ? Object.hasOwn((changes as Record<string, unknown>)[group] ?? {}, property)
      : Object.hasOwn(changes, group);
  };
  for (const binding of Object.keys(bindingKinds) as TokenBinding[]) {
    if (!bindings[binding]) continue;
    if (Object.hasOwn(changes.tokenBindings ?? {}, binding)) continue;
    if (
      binding === "textStyle"
        ? typographyProperties.some((key) => changed(`style.${key}`))
        : changed(bindingPath(binding)) ||
          (binding === "width" && changed("widthMode")) ||
          (binding === "height" && changed("heightMode"))
    )
      bindings[binding] = null;
  }
  return bindings;
}

/** Preserve current values only for bindings being detached by this edit. */
export function materializeChangedBindings(
  node: DesignNode,
  changes: DesignNodeChanges,
  document: TokenDocument,
  exclusions: readonly string[] = [],
) {
  if (!node.tokenBindings) return node;
  const detached = detachChangedBindings(node, changes, exclusions);
  const keys = (Object.keys(node.tokenBindings) as TokenBinding[]).filter(
    (key) =>
      node.tokenBindings?.[key] &&
      (detached[key] === null || changes.tokenBindings?.[key] === null) &&
      !exclusions.includes(`tokenBindings.${key}`),
  );
  if (!keys.length) return node;
  const resolved = resolveNodeTokens(node, document);
  const result = { ...node, box: { ...node.box }, style: { ...node.style } };
  for (const key of keys) {
    if (key === "textStyle")
      Object.assign(
        result.style,
        Object.fromEntries(
          typographyProperties.map((property) => [property, resolved.style[property]]),
        ),
      );
    else if (key === "width" || key === "height") result.box[key] = resolved.box[key];
    else if (styleProperties.has(key))
      Object.assign(result.style, { [key]: resolved.style[key as keyof DesignNode["style"]] });
    else Object.assign(result, { [key]: resolved[key as keyof DesignNode] });
  }
  return result;
}

export function mapTokenBindings<T extends DesignNode | VariantNodeChanges>(
  node: T,
  map: (name: string, binding: TokenBinding) => string | null,
): T {
  const remap = (bindings: DesignNode["tokenBindings"]) =>
    bindings
      ? Object.fromEntries(
          Object.entries(bindings).map(([key, name]) => [
            key,
            name ? map(name, key as TokenBinding) : name,
          ]),
        )
      : bindings;
  return {
    ...node,
    ...(node.tokenBindings ? { tokenBindings: remap(node.tokenBindings) } : {}),
    ...("variants" in node && node.variants
      ? {
          variants: {
            ...node.variants,
            options: Object.fromEntries(
              Object.entries(node.variants.options).map(([name, option]) => [
                name,
                {
                  ...option,
                  ...(option.root ? { root: mapTokenBindings(option.root, map) } : {}),
                  ...(option.children
                    ? {
                        children: Object.fromEntries(
                          Object.entries(option.children).map(([id, patch]) => [
                            id,
                            mapTokenBindings(patch, map),
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
