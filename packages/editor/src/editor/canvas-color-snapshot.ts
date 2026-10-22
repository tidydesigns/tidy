import type { DesignNode } from "../design/document";
import { embedDesignImages } from "../design/export-images";
import { foreignObjectSvg } from "../design/export-dom";
import { fontRegistry } from "../design/fonts/runtime";
import { mapConcurrent } from "../lib/map-concurrent";
import { textFontSegments } from "@tidy/design/rich-text-runtime";

const snapshotProperties =
  `display position inset width height min-width min-height max-width max-height box-sizing
margin padding overflow overflow-clip-margin content-visibility contain contain-intrinsic-size visibility opacity color background background-size background-position
background-repeat background-origin background-clip background-blend-mode border-top border-right border-bottom border-left border-radius border-top-left-radius
border-top-right-radius border-bottom-left-radius border-bottom-right-radius corner-shape border-image box-shadow
outline filter backdrop-filter mix-blend-mode isolation z-index transform transform-origin translate rotate scale
perspective perspective-origin transform-style backface-visibility font font-family font-size font-weight font-style
font-stretch font-variation-settings font-feature-settings font-kerning font-synthesis line-height letter-spacing
word-spacing text-align text-align-last text-transform text-decoration text-indent text-shadow text-rendering
white-space word-break overflow-wrap vertical-align -webkit-text-fill-color -webkit-text-stroke flex flex-direction
flex-wrap align-items align-self align-content justify-content justify-items justify-self gap row-gap column-gap
order grid-template-columns grid-template-rows grid-auto-columns grid-auto-rows grid-auto-flow grid-column grid-row
aspect-ratio object-fit object-position clip-path mask-image mask-size mask-position mask-repeat mask-mode
mask-composite fill fill-opacity fill-rule stroke stroke-width stroke-opacity stroke-dasharray stroke-dashoffset
stroke-linecap stroke-linejoin stroke-miterlimit paint-order vector-effect stop-color stop-opacity color-interpolation`.split(
    /\s+/,
  );

const instanceProperties = new Set([
  "inset",
  "transform",
  "translate",
  "rotate",
  "scale",
  "z-index",
  "order",
  "grid-column",
  "grid-row",
  "mask-image",
]);

export async function canvasColorSnapshot({
  surface,
  nodes,
  signal,
}: {
  surface: HTMLElement;
  nodes: readonly DesignNode[];
  signal: AbortSignal;
}) {
  await new Promise<void>((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
  signal.throwIfAborted();
  const bounds = surface.getBoundingClientRect();
  const clone = surface.cloneNode(false);
  if (!(clone instanceof HTMLElement)) throw new Error("Canvas unavailable.");
  const sharedStyles = new Map<string, string>();
  const visibleIds = new Set<string>();
  let deadline = performance.now() + 6;
  async function copy(from: Element, to: Element) {
    if (performance.now() > deadline) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      signal.throwIfAborted();
      deadline = performance.now() + 6;
    }
    const style = getComputedStyle(from);
    if (style.display === "none") {
      to.setAttribute("style", "display:none");
      return;
    }
    const shared: string[] = [],
      instance: string[] = [];
    for (const key of snapshotProperties) {
      const declaration = `${key}:${style.getPropertyValue(key)};`;
      (instanceProperties.has(key) ? instance : shared).push(declaration);
    }
    const css = shared.join("");
    let name = sharedStyles.get(css);
    if (!name) {
      name = `snapshot-${sharedStyles.size}`;
      sharedStyles.set(css, name);
    }
    to.setAttribute("class", name);
    to.setAttribute("style", instance.join(""));
    if (style.contentVisibility === "hidden") return;
    if (from instanceof HTMLElement && from.dataset.nodeId) visibleIds.add(from.dataset.nodeId);
    to.removeAttribute("data-original-src");
    for (const child of from.childNodes) {
      if (!(child instanceof Element)) {
        if (child.nodeType === Node.TEXT_NODE) to.appendChild(child.cloneNode());
        continue;
      }
      if (
        !from.closest("[data-node-id]") &&
        !child.matches("[data-node-id]") &&
        !child.querySelector("[data-node-id]")
      )
        continue;
      if (
        child.matches(
          "button, textarea, [data-selection-controls], [data-canvas-control], [data-stroke-measure]",
        )
      )
        continue;
      const next = child.cloneNode(false);
      if (!(next instanceof Element)) continue;
      await copy(child, next);
      to.appendChild(next);
    }
  }
  await copy(surface, clone);
  Object.assign(clone.style, {
    position: "relative",
    left: "0",
    top: "0",
    margin: "0",
    transform: "none",
    width: `${bounds.width}px`,
    height: `${bounds.height}px`,
    overflow: "hidden",
  });
  const fonts = new Map<string, Array<Parameters<typeof fontRegistry.exportCss>[0][number]>>();
  for (const node of nodes) {
    if (!node.visible || node.type !== "text" || !visibleIds.has(node.id)) continue;
    const family = node.style.fontFamily ?? "system-ui";
    const segments = fonts.get(family) ?? [];
    segments.push(
      ...textFontSegments({ ...node, text: node.text ?? "" }).map((segment) => ({
        family,
        ...segment,
        source: node.style.fontSource,
      })),
    );
    fonts.set(family, segments);
  }
  const [fontStyles] = await Promise.all([
    mapConcurrent([...fonts.values()], 4, (segments) => {
      signal.throwIfAborted();
      return fontRegistry.exportCss(segments, signal).catch(() => {
        signal.throwIfAborted();
        return "";
      });
    }),
    embedDesignImages(clone, signal),
  ]);
  const fontCss =
    fontStyles.join("\n") + [...sharedStyles].map(([css, name]) => `.${name}{${css}}`).join("");
  signal.throwIfAborted();
  const scale = Math.min(
    window.devicePixelRatio || 1,
    2,
    Math.sqrt(8_000_000 / (bounds.width * bounds.height)),
  );
  const width = Math.max(1, Math.round(bounds.width * scale));
  const height = Math.max(1, Math.round(bounds.height * scale));
  const image = new Image();
  image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(foreignObjectSvg([clone], { x: 0, y: 0, width: bounds.width, height: bounds.height }, width, height, fontCss))}`;
  const cancelDecode = () => {
    image.src = "";
  };
  signal.addEventListener("abort", cancelDecode, { once: true });
  try {
    signal.throwIfAborted();
    await image.decode();
  } finally {
    signal.removeEventListener("abort", cancelDecode);
  }
  signal.throwIfAborted();
  const bitmap = document.createElement("canvas");
  bitmap.width = width;
  bitmap.height = height;
  const context = bitmap.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("Canvas sampling unavailable.");
  context.drawImage(image, 0, 0);
  context.getImageData(0, 0, 1, 1);
  return {
    bitmap,
    bounds,
    scaleX: width / bounds.width,
    scaleY: height / bounds.height,
    colorAt(x: number, y: number) {
      const px = Math.floor(((x - bounds.left) * width) / bounds.width);
      const py = Math.floor(((y - bounds.top) * height) / bounds.height);
      if (px < 0 || py < 0 || px >= width || py >= height) return;
      const bytes = context.getImageData(px, py, 1, 1).data;
      if (!bytes[3]) return;
      return `#${Array.from(bytes.subarray(0, bytes[3] === 255 ? 3 : 4), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
    },
    dispose() {
      bitmap.width = bitmap.height = 0;
    },
  };
}
