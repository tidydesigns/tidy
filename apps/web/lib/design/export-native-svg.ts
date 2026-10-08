import type { DesignNode } from "./document";
import { nodePaints } from "./paints";
import { cornerPath, paintDefinition, strokeSvg, strokeOutsets } from "./strokes";
import { nodeEffects } from "@bella/design/effects";
import { xml } from "./export-dom";
import type { ExportBounds } from "./export-plan";

function roundedPath(node: DesignNode, width: number, height: number) {
  const radius = node.style.radius ?? 0;
  return cornerPath(
    0,
    0,
    width,
    height,
    [
      node.style.radiusTopLeft ?? radius,
      node.style.radiusTopRight ?? radius,
      node.style.radiusBottomRight ?? radius,
      node.style.radiusBottomLeft ?? radius,
    ].map((r) => ({ x: r, y: r })) as [
      { x: number; y: number },
      { x: number; y: number },
      { x: number; y: number },
      { x: number; y: number },
    ],
    node.style.cornerSmoothing,
  );
}
function svgSource(source: string) {
  // The caller supplies renderer-generated vector markup from validated nodes.
  // This detached XML document is serialized for export, never mounted as HTML.
  if (!source.startsWith("data:image/svg+xml")) return null;
  const comma = source.indexOf(","),
    header = source.slice(0, comma),
    data = source.slice(comma + 1);
  const svg = new DOMParser().parseFromString(
    header.includes(";base64") ? atob(data) : decodeURIComponent(data),
    "image/svg+xml",
  );
  if (svg.querySelector("parsererror")) throw new Error("An SVG image in this export is invalid.");
  return svg.documentElement;
}
function namespace(svg: Element, prefix: string) {
  for (const element of [svg, ...svg.querySelectorAll("*")])
    for (const attribute of [...element.attributes]) {
      if (attribute.name === "id") element.setAttribute("id", prefix + attribute.value);
      else {
        let value = attribute.value.replace(/url\(#([^)]*)\)/g, (_m, id) => `url(#${prefix}${id})`);
        if (attribute.localName === "href")
          value = value.replace(/^#(.+)$/, (_m, id) => `#${prefix}${id}`);
        element.setAttribute(attribute.name, value);
      }
    }
}
function nestedSvg(
  source: string,
  prefix: string,
  x: number,
  y: number,
  width: number,
  height: number,
) {
  const svg = svgSource(source);
  if (!svg) throw new Error("Expected native vector geometry.");
  namespace(svg, prefix);
  svg.setAttribute("x", String(x));
  svg.setAttribute("y", String(y));
  svg.setAttribute("width", String(width));
  svg.setAttribute("height", String(height));
  svg.setAttribute("overflow", "visible");
  return new XMLSerializer().serializeToString(svg);
}
function imageSvg(
  image: HTMLImageElement | SVGElement,
  node: DesignNode,
  width: number,
  height: number,
  prefix: string,
) {
  if (image instanceof SVGElement) {
    const svg = image.cloneNode(true) as SVGElement;
    namespace(svg, prefix);
    svg.setAttribute("x", "0");
    svg.setAttribute("y", "0");
    svg.setAttribute("width", String(width));
    svg.setAttribute("height", String(height));
    return new XMLSerializer().serializeToString(svg);
  }
  if (image.hasAttribute("data-vector-path")) {
    const [top, right, bottom, left] = strokeOutsets({
      ...node,
      box: { ...node.box, width, height },
    });
    return nestedSvg(image.src, prefix, -left, -top, width + left + right, height + top + bottom);
  }
  const naturalWidth = Number(image.dataset.exportNaturalWidth) || width,
    naturalHeight = Number(image.dataset.exportNaturalHeight) || height;
  const fit = node.style.objectFit ?? (node.type === "vector" ? "contain" : "cover");
  const factor =
    fit === "fill"
      ? 1
      : (fit === "contain" ? Math.min : Math.max)(width / naturalWidth, height / naturalHeight);
  const scale = node.style.objectScale ?? 1,
    w = (fit === "fill" ? width : naturalWidth * factor) * scale,
    h = (fit === "fill" ? height : naturalHeight * factor) * scale;
  const x = ((width - w) * (node.style.objectPositionX ?? 50)) / 100,
    y = ((height - h) * (node.style.objectPositionY ?? 50)) / 100;
  return `<image href="${xml(image.src)}" x="${x}" y="${y}" width="${w}" height="${h}" preserveAspectRatio="none"/>`;
}
function filterSvg(node: DesignNode, id: string) {
  const effects = nodeEffects(node.style).filter((e) => e.visible);
  if (!effects.length) return "";
  let source = "SourceGraphic";
  const body = effects
    .map((effect, index) => {
      const result = `f${index}`,
        input = source;
      source = result;
      if (effect.type === "blur")
        return `<feGaussianBlur in="${input}" stdDeviation="${effect.amount}" result="${result}"/>`;
      if (
        effect.type === "hueRotate" ||
        effect.type === "saturation" ||
        effect.type === "grayscale"
      )
        return `<feColorMatrix in="${input}" type="${effect.type === "hueRotate" ? "hueRotate" : "saturate"}" values="${effect.type === "hueRotate" ? effect.amount : effect.type === "grayscale" ? 1 - effect.amount / 100 : effect.amount / 100}" result="${result}"/>`;
      const slope = effect.amount / 100,
        intercept = effect.type === "contrast" ? 0.5 * (1 - slope) : 0;
      return `<feComponentTransfer in="${input}" result="${result}">${["R", "G", "B"].map((channel) => `<feFunc${channel} type="linear" slope="${slope}" intercept="${intercept}"/>`).join("")}</feComponentTransfer>`;
    })
    .join("");
  return `<filter id="${id}" x="-100%" y="-100%" width="300%" height="300%" color-interpolation-filters="sRGB">${body}</filter>`;
}
/** Measure actual wrapped paragraphs without transforms, preserving line breaks and font metrics. */
function textSvg(clone: HTMLElement) {
  const measurement = clone.cloneNode(true) as HTMLElement;
  measurement.style.transform = "none";
  measurement.style.left = "-20000px";
  measurement.style.top = "0";
  measurement.style.position = "fixed";
  measurement.style.opacity = "0";
  measurement.style.pointerEvents = "none";
  document.body.appendChild(measurement);
  try {
    const content = measurement.querySelector<HTMLElement>("[data-design-text]");
    if (!content) return "";
    const origin = measurement.getBoundingClientRect(),
      walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT),
      context = document.createElement("canvas").getContext("2d");
    if (!context) throw new Error("Text measurement is unavailable in this browser.");
    type Run = {
      x: number;
      y: number;
      width: number;
      text: string;
      key: string;
      style: CSSStyleDeclaration;
    };
    const runs: Run[] = [];
    while (walker.nextNode()) {
      const text = walker.currentNode as Text,
        parent = text.parentElement!,
        style = getComputedStyle(parent);
      context.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
      const metrics = context.measureText("Mg"),
        ascent = metrics.fontBoundingBoxAscent || metrics.actualBoundingBoxAscent;
      let offset = 0;
      for (const character of text.data) {
        const range = document.createRange();
        range.setStart(text, offset);
        offset += character.length;
        range.setEnd(text, offset);
        const rect = range.getBoundingClientRect();
        if (!rect.height || (rect.width === 0 && /^\s$/.test(character))) continue;
        const value =
          style.textTransform === "uppercase"
            ? character.toUpperCase()
            : style.textTransform === "lowercase"
              ? character.toLowerCase()
              : character;
        const x = rect.x - origin.x,
          y = rect.y - origin.y + ascent,
          key = [
            style.fontFamily,
            style.fontSize,
            style.fontWeight,
            style.fontStyle,
            style.color,
            style.letterSpacing,
            style.textDecorationLine,
            y.toFixed(3),
          ].join("|");
        const previous = runs.at(-1);
        if (previous?.key === key && Math.abs(previous.x + previous.width - x) < 1) {
          previous.text += value;
          previous.width = rect.right - origin.x - previous.x;
        } else runs.push({ x, y, width: rect.width, text: value, key, style });
      }
    }
    return runs
      .map(
        (run) =>
          `<text x="${run.x}" y="${run.y}" xml:space="preserve" fill="${xml(run.style.color)}" font-family="${xml(run.style.fontFamily)}" font-size="${xml(run.style.fontSize)}" font-weight="${xml(run.style.fontWeight)}" font-style="${xml(run.style.fontStyle)}" letter-spacing="${xml(run.style.letterSpacing === "normal" ? "0" : run.style.letterSpacing)}" text-decoration="${xml(run.style.textDecorationLine)}">${xml(run.text)}</text>`,
      )
      .join("");
  } finally {
    measurement.remove();
  }
}

export function nativeSvg(
  clones: readonly HTMLElement[],
  nodes: ReadonlyMap<string, DesignNode>,
  tokens: Record<string, string>,
  bounds: ExportBounds,
  width: number,
  height: number,
  fontCss: string,
) {
  let serial = 0;
  const unsupported: string[] = [];
  const draw = (clone: HTMLElement, root = false): string => {
    const node = nodes.get(clone.dataset.nodeId!);
    if (!node || !node.visible || (!root && clone.style.opacity === "0")) return "";
    const prefix = `n${++serial}-`,
      w = Number(clone.dataset.exportWidth),
      h = Number(clone.dataset.exportHeight),
      matrix = clone.dataset.exportMatrix ?? "1 0 0 1 0 0";
    const reasons = [
      node.mask ? "vector masks" : "",
      node.vectorBoolean ? "boolean geometry" : "",
      node.vectorPath && "contours" in node.vectorPath ? "authored vector geometry" : "",
      node.richText?.some((paragraph) => paragraph.list) ? "text lists" : "",
      node.style.backdropBlur ? "backdrop blur" : "",
      node.style.shadows?.length || node.style.shadow ? "box shadows" : "",
      node.style.maxLines || node.style.textOverflow === "ellipsis" ? "text truncation" : "",
      node.style.textCase === "capitalize" ? "capitalized text" : "",
      node.style.outlineWidth ? "outlines" : "",
    ].filter(Boolean);
    if (reasons.length) unsupported.push(`${node.name}: ${reasons.join(", ")}`);
    const path = roundedPath(node, w, h),
      defs: string[] = [`<clipPath id="${prefix}clip"><path d="${path}"/></clipPath>`];
    const filter = filterSvg(node, `${prefix}filter`);
    if (filter) defs.push(filter);
    const vector = clone.querySelector<HTMLImageElement>(":scope > img[data-vector-path]");
    let body = "";
    if (vector) body = imageSvg(vector, { ...node, vectorPath: node.vectorPath }, w, h, prefix);
    else {
      const fills = [...nodePaints(node)].reverse().filter((p) => p.visible);
      body = fills
        .map((paint, index) => {
          if (paint.type === "image") {
            const layer = clone.querySelector<HTMLElement>(
                `[data-fill-id="${CSS.escape(paint.id)}"]`,
              ),
              image = layer?.querySelector<HTMLImageElement | SVGElement>(
                "img,svg[data-image-crop]",
              );
            if (!image) {
              if (paint.assetId) unsupported.push(`${node.name}: image fill could not be measured`);
              return "";
            }
            const imageNode = {
              ...node,
              type: "image" as const,
              style: {
                ...node.style,
                objectFit: paint.fit,
                imageCrop: paint.crop,
                objectScale: undefined,
                objectPositionX: paint.positionX,
                objectPositionY: paint.positionY,
              },
            };
            return `<g clip-path="url(#${prefix}clip)" opacity="${paint.opacity}" style="mix-blend-mode:${paint.blendMode ?? "normal"}">${imageSvg(image, imageNode, w, h, `${prefix}paint${index}-`)}</g>`;
          }
          const definition = paintDefinition(
            paint,
            `${prefix}paint${index}`,
            { width: w, height: h },
            tokens,
          );
          if (paint.type === "radial" && paint.rotation)
            definition.definition = definition.definition.replace(
              " scale(",
              ` rotate(${paint.rotation}) scale(`,
            );
          defs.push(definition.definition);
          return `<path d="${path}" fill="${xml(definition.fill)}" opacity="${paint.opacity}" style="mix-blend-mode:${paint.blendMode ?? "normal"}"/>`;
        })
        .join("");
      if (node.type === "text") body += textSvg(clone);
      if (node.type === "image" || node.type === "vector") {
        const image = clone.querySelector<HTMLImageElement | SVGElement>(
          ":scope > img, :scope > svg[data-image-crop]",
        );
        if (image)
          body += `<g clip-path="url(#${prefix}clip)">${imageSvg(image, node, w, h, `${prefix}image-`)}</g>`;
      }
      const stroke = strokeSvg({ ...node, box: { ...node.box, width: w, height: h } }, tokens, {
        width: w,
        height: h,
      });
      body += nestedSvg(
        `data:image/svg+xml,${encodeURIComponent(stroke)}`,
        `${prefix}stroke-`,
        ...(() => {
          const [top, right, bottom, left] = strokeOutsets({
            ...node,
            box: { ...node.box, width: w, height: h },
          });
          return [-left, -top, w + left + right, h + top + bottom] as [
            number,
            number,
            number,
            number,
          ];
        })(),
      );
    }
    const children = [...clone.children]
      .filter((e): e is HTMLElement => e instanceof HTMLElement && Boolean(e.dataset.nodeId))
      .map((e) => draw(e))
      .join("");
    body +=
      clone.style.overflow === "hidden" || clone.style.overflow === "clip"
        ? `<g clip-path="url(#${prefix}clip)">${children}</g>`
        : children;
    const maskImage = clone.style.maskImage || clone.style.webkitMaskImage;
    if (maskImage && maskImage !== "none") {
      const source = /^url\(["']?(.*?)["']?\)$/.exec(maskImage)?.[1];
      if (source?.startsWith("data:image/svg+xml")) {
        const size = (clone.style.maskSize || `${w}px ${h}px`).split(" ").map(parseFloat),
          position = (clone.style.maskPosition || "0px 0px").split(" ").map(parseFloat);
        defs.push(
          `<mask id="${prefix}mask" maskUnits="userSpaceOnUse" x="${position[0]}" y="${position[1]}" width="${size[0]}" height="${size[1]}" mask-type="alpha"><image href="${xml(source)}" x="${position[0]}" y="${position[1]}" width="${size[0]}" height="${size[1]}"/></mask>`,
        );
        body = `<g mask="url(#${prefix}mask)">${body}</g>`;
      } else unsupported.push(`${node.name}: external masks`);
    }
    return `<g transform="matrix(${matrix})" opacity="${root ? (node.style.opacity ?? 1) : clone.style.opacity || 1}" style="mix-blend-mode:${node.style.blendMode ?? "normal"};isolation:isolate"${filter ? ` filter="url(#${prefix}filter)"` : ""}><defs>${defs.join("")}</defs>${body}</g>`;
  };
  const body = clones.map((c) => draw(c, true)).join("");
  return {
    svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${bounds.width} ${bounds.height}"><style>${xml(fontCss)}</style>${body}</svg>`,
    unsupported: [...new Set(unsupported)],
  };
}
