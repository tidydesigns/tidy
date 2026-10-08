import type { CSSProperties } from "react";
import type { DesignDocument, DesignNode } from "./document";
import { resolveVariantNodes, componentFamily } from "./component-variants";
import { containingFrameWidth, responsiveNode } from "./responsive-layout";
import { nodeStyle } from "./node-style";
import { nodePaints } from "./paints";
import { nodeStrokePaints } from "./strokes";

export type TokenBinding = { property: string; name: string; value?: string; missing: boolean };
export function layerHandoff(document: DesignDocument, id: string) {
  const nodes = resolveVariantNodes(document.nodes);
  const original = nodes.find((node) => node.id === id);
  if (!original) return null;
  const frameWidth = containingFrameWidth(original, nodes);
  const node = responsiveNode(original, frameWidth);
  const parentNode = nodes.find((item) => item.id === node.parentId);
  const parent = parentNode ? responsiveNode(parentNode, frameWidth) : undefined;
  const siblings = nodes.filter((item) => item.parentId === node.parentId);
  const flowIndex = siblings
    .slice(
      0,
      siblings.findIndex((item) => item.id === id),
    )
    .filter((item) => item.visible && item.positionMode !== "absolute").length;
  const style = nodeStyle(node, parent?.layout ?? "absolute", document.tokens, parent, flowIndex);
  const bindings: TokenBinding[] = [];
  const bind = (property: string, name: string | undefined, fallback?: string) => {
    if (name)
      bindings.push({
        property,
        name,
        value: document.tokens[name] ?? fallback,
        missing: document.tokens[name] === undefined,
      });
  };
  bind("Text", node.style.colorToken, node.style.color);
  const paints = [
    ...nodePaints(node).map((paint, i) => ({ paint, label: `Fill ${i + 1}` })),
    ...nodeStrokePaints(node).map((paint, i) => ({ paint, label: `Stroke ${i + 1}` })),
  ];
  for (const { paint, label } of paints) {
    if (!paint.visible) continue;
    if (paint.type === "solid") bind(label, paint.token, paint.color);
    if (paint.type === "linear" || paint.type === "radial")
      paint.stops.forEach((stop, i) => bind(`${label}, stop ${i + 1}`, stop.token, stop.color));
  }
  const assets = [
    ...new Set([
      ...(node.assetId ? [node.assetId] : []),
      ...paints.flatMap(({ paint }) =>
        paint.visible && paint.type === "image" && paint.assetId ? [paint.assetId] : [],
      ),
    ]),
  ];
  const family = componentFamily(document.nodes, original);
  const master =
    family?.master ??
    (original.isComponent
      ? original
      : document.nodes.find((item) => item.id === original.instanceOf));
  const component = master
    ? {
        name: master.name,
        variant: family ? (original.variant ?? family.variants.default) : undefined,
      }
    : undefined;
  const sourceKey = document.source
    ? `${document.source.project}:${document.source.route}`
    : undefined;
  const provenance = node.importKey
    ? node
    : (document.nodes.find((item) => item.id === node.componentSourceId) ?? node);
  const matchingSource =
    sourceKey &&
    (provenance.importKey === sourceKey || provenance.importKey?.startsWith(`${sourceKey}#`));
  const source = [
    ["Source path", provenance.sourcePath],
    ["Source key", provenance.sourceKey],
    ["Import", provenance.importKey],
    ...(matchingSource
      ? [
          ["Project", document.source?.project],
          ["Route", document.source?.route],
          ["Revision", document.source?.revision],
        ]
      : []),
  ].filter((row): row is [string, string] => Boolean(row[1]));
  return {
    node,
    style,
    frameWidth,
    bindings,
    assets,
    component,
    source,
    breakpoints: (node.responsiveBreakpoints ?? [])
      .filter((rule) => frameWidth <= rule.frameMaxWidth)
      .map((rule) => rule.frameMaxWidth),
  };
}

const unitless = new Set([
  "opacity",
  "zIndex",
  "fontWeight",
  "lineHeight",
  "flex",
  "flexGrow",
  "flexShrink",
  "order",
  "gridColumn",
  "gridRow",
  "WebkitLineClamp",
]);
export function styleDeclarations(style: CSSProperties) {
  return Object.entries(style)
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .map(([key, value]) => {
      const property = key.startsWith("--")
        ? key
        : key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`).replace(/^ms-/, "-ms-");
      return [
        property,
        typeof value === "number" && value !== 0 && !unitless.has(key) && !key.startsWith("--")
          ? `${value}px`
          : String(value),
      ] as const;
    });
}

function block(selector: string, declarations: Iterable<readonly [string, string]>) {
  const rows = [...declarations].filter(([, value]) => value);
  return rows.length
    ? `${selector} {\n${rows.map(([property, value]) => `  ${property}: ${value};`).join("\n")}\n}`
    : "";
}

/** Capture renderer-owned CSS, excluding canvas selection decoration and child layers. */
export function handoffCss(style: CSSProperties, element?: HTMLElement | null, text = false) {
  const declarations = new Map(styleDeclarations(style));
  if (element) {
    for (const property of Array.from(element.style)) {
      if (!["outline", "outline-offset", "cursor"].includes(property))
        declarations.set(property, element.style.getPropertyValue(property));
    }
    const computed = getComputedStyle(element);
    for (const [property, value] of declarations) {
      if (value.includes("var(")) declarations.set(property, computed.getPropertyValue(property));
    }
    if (text) {
      for (const property of [
        "font-family",
        "font-size",
        "font-weight",
        "font-style",
        "line-height",
        "letter-spacing",
        "color",
        "text-align",
      ])
        if (!declarations.has(property))
          declarations.set(property, computed.getPropertyValue(property));
    }
  }
  const blocks = [block(".tidy-layer", declarations)];
  if (element) {
    const visit = (parent: Element, selector: string) => {
      Array.from(parent.children).forEach((child, index) => {
        if (child.hasAttribute("data-node-id") || child.hasAttribute("data-stroke-measure")) return;
        const target = `${selector} > :nth-child(${index + 1})`;
        if (child instanceof HTMLElement || child instanceof SVGElement) {
          const css = block(
            target,
            Array.from(child.style).map((key) => [key, child.style.getPropertyValue(key)] as const),
          );
          if (css) blocks.push(css);
        }
        visit(child, target);
      });
    };
    visit(element, ".tidy-layer");
  }
  return (
    "/* Generated from the current Tidy renderer. Apply to matching layer markup. */\n" +
    blocks.join("\n\n")
  );
}

export function handoffFacts(node: DesignNode, style: CSSProperties, measured?: DesignNode["box"]) {
  const box = measured ?? node.box;
  const format = (value: number) => `${Math.round(value * 100) / 100}px`;
  const facts: [string, string][] = [
    ["Size", `${format(box.width)} × ${format(box.height)}`],
    ["Position", `${format(box.x)}, ${format(box.y)}`],
  ];
  const css = new Map(styleDeclarations(style));
  for (const property of [
    "display",
    "flex-direction",
    "grid-template-columns",
    "column-gap",
    "row-gap",
    "padding-top",
    "padding-right",
    "padding-bottom",
    "padding-left",
    ...(node.type === "text"
      ? ["font-family", "font-size", "font-weight", "line-height", "letter-spacing", "color"]
      : ["background"]),
  ]) {
    const value = css.get(property);
    if (value) facts.push([property, value]);
  }
  return facts;
}
