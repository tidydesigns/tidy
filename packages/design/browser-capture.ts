import { captureGradientStack } from "./capture-gradients";
import { parseCssShadows } from "./effects";
import type { DesignNode } from "./document";
import { blankDesignDocument } from "./document-defaults";
import type { WebCapture } from "./web-capture";
import { captureSourceUrl, MAX_CAPTURE_BYTES } from "./capture-source";

import { rasterTiles, type RasterTile } from "./raster-tiles";
import { rasterizeElement } from "./rasterize-element";
import {
  currentViewport,
  decodeCaptureImage,
  effectBounds,
  intersectBounds,
  isProtectedElement,
  protectedBounds,
  rasterEffect,
  sameViewport,
  type CaptureViewport,
} from "./capture-effects";

const MAX_ASSET_BASE64_BYTES = 13_000_000; // Leave 3 MB for nodes and capture metadata.

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
const colorContexts = new WeakMap<Document, CanvasRenderingContext2D | null>();
const resolvedColors = new Map<string, string>();

export function cssColor(value: string, preserveTransparent = false): string | undefined {
  if (value === "transparent") return preserveTransparent ? "#00000000" : undefined;
  if (value.startsWith("#")) return /^#[\da-f]{6}([\da-f]{2})?$/i.test(value) ? value : undefined;
  const match = value.match(
    /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/,
  );
  if (!match) {
    // Let the source browser convert CSS Color 4 (including wide-gamut colors)
    // to the sRGB pixels used by the design renderer. Never restyle the page.
    let color = resolvedColors.get(value);
    if (!color && typeof document !== "undefined") {
      try {
        if (!colorContexts.has(document)) {
          const canvas = document.createElement("canvas");
          canvas.width = canvas.height = 1;
          colorContexts.set(document, canvas.getContext("2d", { willReadFrequently: true }));
        }
        const context = colorContexts.get(document);
        if (!context) return undefined;
        context.fillStyle = "#010203";
        context.fillStyle = value;
        if (context.fillStyle === "#010203") {
          context.fillStyle = "#040506";
          context.fillStyle = value;
          if (context.fillStyle === "#040506") return undefined;
        }
        context.clearRect(0, 0, 1, 1);
        context.fillRect(0, 0, 1, 1);
        const channels = [...context.getImageData(0, 0, 1, 1).data];
        if (channels[3] === 255) channels.pop();
        color = `#${channels.map((part) => part.toString(16).padStart(2, "0")).join("")}`;
        if (resolvedColors.size >= 512) resolvedColors.clear();
        resolvedColors.set(value, color);
      } catch {
        return undefined;
      }
    }
    return color?.endsWith("00") && color.length === 9 && !preserveTransparent ? undefined : color;
  }
  const alpha = match[4] ? Number.parseFloat(match[4]) / (match[4].endsWith("%") ? 100 : 1) : 1;
  if (alpha === 0 && !preserveTransparent) return undefined;
  const channels = match.slice(1, 4).map((part) => clamp(Math.round(Number(part)), 0, 255));
  if (alpha < 1) channels.push(clamp(Math.round(alpha * 255), 0, 255));
  return `#${channels.map((part) => part.toString(16).padStart(2, "0")).join("")}`;
}

export function captureStyle(
  css: CSSStyleDeclaration,
  text = false,
  bounds?: Pick<DOMRect, "width" | "height">,
): DesignNode["style"] {
  const px = (value: string) => Number.parseFloat(value) || 0;
  const radius = (value = "0") => {
    const limit = bounds ? Math.min(bounds.width, bounds.height) / 2 : 5000;
    return clamp(
      value.includes("%") && bounds
        ? (px(value) / 100) * Math.min(bounds.width, bounds.height)
        : px(value),
      0,
      limit,
    );
  };
  const style: DesignNode["style"] = {
    opacity: clamp(Number.parseFloat(css.opacity) || (css.opacity === "0" ? 0 : 1), 0, 1),
    radius: radius(css.borderTopLeftRadius),
    radiusTopLeft: radius(css.borderTopLeftRadius),
    radiusTopRight: radius(css.borderTopRightRadius),
    radiusBottomRight: radius(css.borderBottomRightRadius),
    radiusBottomLeft: radius(css.borderBottomLeftRadius),
    borderColor: cssColor(css.borderTopColor, true),
    borderWidth: clamp(px(css.borderTopWidth), 0, 40),
    borderTopWidth: clamp(px(css.borderTopWidth), 0, 40),
    borderRightWidth: clamp(px(css.borderRightWidth), 0, 40),
    borderBottomWidth: clamp(px(css.borderBottomWidth), 0, 40),
    borderLeftWidth: clamp(px(css.borderLeftWidth), 0, 40),
    overflow: css.overflow === "hidden" || css.overflow === "clip" ? "hidden" : "visible",
    fill: cssColor(css.backgroundColor),
  };
  const visibleBorder = (["Top", "Right", "Bottom", "Left"] as const).find(
    (edge) => px(css[`border${edge}Width`]) > 0,
  );
  if (visibleBorder) style.borderColor = cssColor(css[`border${visibleBorder}Color`], true);
  const edges = ["Top", "Right", "Bottom", "Left"] as const;
  for (const edge of edges) {
    if (px(css[`border${edge}Width`]) <= 0) continue;
    const color = cssColor(css[`border${edge}Color`], true);
    if (color !== style.borderColor) style[`border${edge}Color`] = color;
  }
  const borderStyle = visibleBorder && css[`border${visibleBorder}Style`];
  if (borderStyle === "dotted" || borderStyle === "dashed") style.borderStyle = borderStyle;
  if (css.boxShadow && css.boxShadow !== "none") {
    const shadows = parseCssShadows(css.boxShadow, "captured-shadow", cssColor(css.color));
    if (shadows) style.shadows = shadows;
    else style.shadow = css.boxShadow.slice(0, 160);
  }
  if (text) {
    const size = clamp(px(css.fontSize) || 16, 6, 300);
    Object.assign(style, {
      fill: undefined,
      borderWidth: 0,
      borderTopWidth: 0,
      borderRightWidth: 0,
      borderBottomWidth: 0,
      borderLeftWidth: 0,
      borderTopColor: undefined,
      borderRightColor: undefined,
      borderBottomColor: undefined,
      borderLeftColor: undefined,
      shadow: undefined,
      shadows: undefined,
      radius: 0,
      radiusTopLeft: 0,
      radiusTopRight: 0,
      radiusBottomRight: 0,
      radiusBottomLeft: 0,
      color: cssColor(css.color) ?? "#000000",
      fontSize: size,
      fontFamily: css.fontFamily.slice(0, 100),
      fontWeight: clamp(px(css.fontWeight) || 400, 100, 900),
      lineHeight: css.lineHeight === "normal" ? 1.2 : clamp(px(css.lineHeight) / size, 0.5, 4),
      letterSpacing: clamp(px(css.letterSpacing), -100, 100),
      fontStyle: css.fontStyle === "italic" ? "italic" : "normal",
      textAlign: ["left", "center", "right"].includes(css.textAlign) ? css.textAlign : "left",
      textWrap: "nowrap",
      textDecoration: css.textDecorationLine.includes("underline")
        ? "underline"
        : css.textDecorationLine.includes("line-through")
          ? "line-through"
          : "none",
    });
  }
  return style;
}

export async function captureElement(
  root: Element,
  mode: WebCapture["mode"],
  screenshot?: string,
  screenshotViewport?: CaptureViewport,
  options?: { screenshotValid?: () => boolean; deadline?: number },
): Promise<WebCapture> {
  if (isProtectedElement(root))
    throw new Error(
      "Editable fields and embedded frames cannot be imported. Select the surrounding content.",
    );
  const deadline = Math.min(options?.deadline ?? Infinity, performance.now() + 20000);
  const rect = root.getBoundingClientRect();
  const fullPage = mode === "page";
  const originX = fullPage ? -window.scrollX : rect.left;
  const originY = fullPage ? -window.scrollY : rect.top;
  const width = Math.min(
    5000,
    Math.max(
      1,
      fullPage
        ? Math.max(
            document.documentElement.scrollWidth,
            document.body.scrollWidth,
            window.innerWidth,
          )
        : rect.width,
    ),
  );
  const height = Math.min(
    100000,
    Math.max(
      1,
      fullPage
        ? Math.max(
            document.documentElement.scrollHeight,
            document.body.scrollHeight,
            window.innerHeight,
          )
        : rect.height,
    ),
  );
  const result: WebCapture = {
    title:
      (fullPage
        ? document.title
        : root.getAttribute("aria-label") ||
          root.id ||
          `${root.tagName.toLowerCase()}: ${document.title}`
      )
        .trim()
        .slice(0, 120) || "Website capture",
    url: captureSourceUrl(location.href),
    mode,
    document: blankDesignDocument(),
    assets: [],
  };
  const warnings = new Set<string>();
  const warn = (message: string) => {
    if (warnings.size < 100) warnings.add(message);
  };
  if ((fullPage ? document.documentElement.scrollWidth : rect.width) > 5000)
    warn("Content wider than 5,000 px was clipped to Tidy's frame limit.");
  if ((fullPage ? document.documentElement.scrollHeight : rect.height) > 100000)
    warn("Content below 100,000 px was omitted.");
  const frames: DesignNode[] = [];
  // A selected transparent subtree still sits on its ancestors' painted canvas.
  let background = "#ffffff";
  const ancestors: Element[] = [];
  // The root's own fill is imported below; compositing it here too would double
  // the opacity of a translucent root.
  for (
    let ancestor: Element | null = root.parentElement;
    ancestor;
    ancestor = ancestor.parentElement
  )
    ancestors.push(ancestor);
  ancestors.reverse();
  const htmlCss = getComputedStyle(document.documentElement);
  // With an unpainted HTML root, browsers propagate the body's background to
  // the document canvas, beyond a 100vh body or fixed/sticky sidebar bounds.
  const bodyCanvasBackground =
    fullPage &&
    root === document.body &&
    !cssColor(htmlCss.backgroundColor) &&
    htmlCss.backgroundImage === "none";
  if (bodyCanvasBackground) ancestors.push(root);
  for (const ancestor of ancestors) {
    const color = cssColor(getComputedStyle(ancestor).backgroundColor);
    if (!color) continue;
    if (color.length === 7) background = color;
    else {
      const alpha = parseInt(color.slice(7), 16) / 255;
      background = `#${[1, 3, 5]
        .map((offset) =>
          Math.round(
            parseInt(color.slice(offset, offset + 2), 16) * alpha +
              parseInt(background.slice(offset, offset + 2), 16) * (1 - alpha),
          )
            .toString(16)
            .padStart(2, "0"),
        )
        .join("")}`;
    }
  }
  for (let y = 0; y < height; y += 5000) {
    const frame: DesignNode = {
      id: crypto.randomUUID(),
      parentId: null,
      type: "artboard",
      name: `${result.title}${height > 5000 ? ` (${frames.length + 1})` : ""}`.slice(0, 120),
      box: { x: frames.length * (width + 120), y: 0, width, height: Math.min(5000, height - y) },
      style: { fill: background, overflow: "hidden" },
      visible: true,
      locked: false,
      layout: "absolute",
    };
    frames.push(frame);
  }
  result.document.nodes.push(...frames);
  type CaptureParent = {
    bounds: Map<number, DOMRect>;
    nodes: Map<number, DesignNode>;
  };
  const add = (
    node: Omit<DesignNode, "id" | "parentId" | "visible" | "locked" | "layout">,
    bounds: DOMRect,
    parent?: CaptureParent,
  ) => {
    const added = new Map<number, DesignNode>();
    const x = bounds.left - originX,
      y = bounds.top - originY;
    if (
      bounds.width < 1 ||
      bounds.height < 1 ||
      x >= width ||
      x + bounds.width <= 0 ||
      y >= height ||
      y + bounds.height <= 0
    )
      return added;
    for (
      let index = Math.max(0, Math.floor(y / 5000));
      index < frames.length && index * 5000 < y + bounds.height;
      index++
    ) {
      if (result.document.nodes.length >= 5000) {
        warn(
          "The capture reached Tidy's 5,000-layer limit. Select a smaller portion for the remaining content.",
        );
        return added;
      }
      const parentNode = parent?.nodes.get(index);
      const parentBounds = parent?.bounds.get(index);
      if (parent && !parentNode) continue;
      // A clipping group can span multiple artboards. Give each copy the
      // corresponding slice, rather than clamping its original full height.
      const splitGroup = node.type === "container" && bounds.height > 5000;
      const top = splitGroup ? Math.max(bounds.top, originY + index * 5000) : bounds.top;
      const bottom = splitGroup
        ? Math.min(bounds.bottom, originY + index * 5000 + frames[index]!.box.height)
        : bounds.bottom;
      const style = { ...node.style };
      if (top > bounds.top)
        Object.assign(style, { radiusTopLeft: 0, radiusTopRight: 0, borderTopWidth: 0 });
      if (bottom < bounds.bottom)
        Object.assign(style, { radiusBottomLeft: 0, radiusBottomRight: 0, borderBottomWidth: 0 });
      const addedNode: DesignNode = {
        ...node,
        style,
        id: crypto.randomUUID(),
        parentId: parentNode?.id ?? frames[index]!.id,
        box: {
          x: clamp(
            parentBounds
              ? bounds.left -
                  parentBounds.left -
                  (parentNode!.style.borderLeftWidth ?? parentNode!.style.borderWidth ?? 0)
              : x,
            -100000,
            100000,
          ),
          y: clamp(
            parentBounds
              ? top -
                  parentBounds.top -
                  (parentNode!.style.borderTopWidth ?? parentNode!.style.borderWidth ?? 0)
              : top - originY - index * 5000,
            -100000,
            100000,
          ),
          width: clamp(bounds.width, 1, 5000),
          height: clamp(bottom - top, 1, 5000),
        },
        visible: true,
        locked: false,
        layout: "absolute",
      };
      result.document.nodes.push(addedNode);
      added.set(index, addedNode);
    }
    return added;
  };
  const startViewport = currentViewport();
  let viewport: HTMLImageElement | undefined;
  let privateRegions: ReturnType<typeof protectedBounds> = [];
  if (
    screenshot &&
    options?.screenshotValid?.() !== false &&
    (!screenshotViewport || sameViewport(screenshotViewport, startViewport))
  ) {
    viewport = new Image();
    viewport.src = screenshot;
    try {
      await decodeCaptureImage(viewport);
      privateRegions = protectedBounds();
    } catch {
      viewport = undefined;
    }
  }
  if (screenshot && !viewport)
    warn(
      "Screenshot fallbacks were unavailable or the viewport changed; effect layers may be approximated.",
    );
  let assetBytes = 0;
  const assetIds = new Map<string, string>();
  const decodedImages = new Map<string, Promise<HTMLImageElement>>();
  const renderedImages = new Map<string, string>();
  const assetJobs: { visible: boolean; run: () => Promise<void> }[] = [];
  const rasterLayers: (() => void)[] = [];
  const cropScreenshot = (canvas: HTMLCanvasElement, bounds: DOMRect) => {
    if (
      !viewport ||
      options?.screenshotValid?.() === false ||
      !sameViewport(startViewport, currentViewport())
    )
      return false;
    const context = canvas.getContext("2d");
    if (!context) return false;
    const overlaps = privateRegions.flatMap((region) => {
      const overlap = intersectBounds(bounds, region.bounds);
      return overlap ? [{ ...region, overlap }] : [];
    });
    // A custom element may have a closed shadow root. Blanking its whole box
    // would also erase public light-DOM content (e.g. GitHub's navigation).
    // Keep the inspectable DOM layers instead of overlaying a destructive crop.
    if (overlaps.some((region) => !region.backgrounds)) {
      warn(
        "Some screenshot effects overlapped uninspectable components; public DOM layers were retained with approximated effects.",
      );
      return false;
    }
    const ratioX = viewport.naturalWidth / startViewport.width,
      ratioY = viewport.naturalHeight / startViewport.height;
    context.drawImage(
      viewport,
      bounds.left * ratioX,
      bounds.top * ratioY,
      bounds.width * ratioX,
      bounds.height * ratioY,
      0,
      0,
      canvas.width,
      canvas.height,
    );
    for (const { overlap, backgrounds } of overlaps) {
      const sx = canvas.width / bounds.width,
        sy = canvas.height / bounds.height;
      // Start opaque so no private pixels survive translucent backgrounds.
      // Rebuild only CSS background colors, never sample the control's pixels.
      for (const color of ["#ffffff", ...backgrounds!]) {
        context.fillStyle = color;
        context.fillRect(
          Math.floor((overlap.left - bounds.left) * sx),
          Math.floor((overlap.top - bounds.top) * sy),
          Math.ceil(overlap.width * sx) + 1,
          Math.ceil(overlap.height * sy) + 1,
        );
      }
      warn(
        "Form controls, editable content and embedded frames were redacted from screenshot fallbacks.",
      );
    }
    return true;
  };
  const addRaster = (
    tiles: RasterTile[],
    bounds: DOMRect,
    name: string,
    overlay = false,
    parent?: CaptureParent,
  ) => {
    const bytes = tiles.reduce((sum, tile) => sum + tile.base64.length, 0);
    if (
      assetBytes + bytes > MAX_ASSET_BASE64_BYTES ||
      result.assets.length + tiles.length > 100 ||
      result.document.nodes.length + tiles.length + 1 > 4900
    )
      throw new Error("Raster capture budget exceeded.");
    assetBytes += bytes;
    const assets = tiles.map((tile) => {
      const id = crypto.randomUUID();
      result.assets.push({ id, mimeType: "image/png", base64: tile.base64 });
      return id;
    });
    const render = () => {
      if (tiles.length === 1) {
        add(
          {
            type: "image",
            name,
            assetId: assets[0],
            style: { objectFit: "fill" },
            box: { x: 0, y: 0, width: 1, height: 1 },
          },
          bounds,
          parent,
        );
        return;
      }
      // A single group keeps the tiled visual movable as one object in Tidy.
      const start = result.document.nodes.length;
      add(
        { type: "container", name, style: {}, box: { x: 0, y: 0, width: 1, height: 1 } },
        bounds,
        parent,
      );
      for (const group of result.document.nodes.slice(start))
        tiles.forEach((tile, index) => {
          result.document.nodes.push({
            id: crypto.randomUUID(),
            parentId: group.id,
            type: "image",
            name: `Raster tile ${index + 1}`,
            assetId: assets[index],
            box: {
              x: tile.x * bounds.width,
              y: tile.y * bounds.height,
              width: tile.width * bounds.width,
              height: tile.height * bounds.height,
            },
            style: { objectFit: "fill" },
            visible: true,
            locked: false,
            layout: "absolute",
          });
        });
    };
    if (overlay) rasterLayers.push(render);
    else render();
  };
  const rasterize = async (element: Element, reason: string, parent?: CaptureParent) => {
    const label = (
      element.id ||
      element.getAttribute("aria-label") ||
      element.getAttribute("class") ||
      element.tagName.toLowerCase()
    ).slice(0, 100);
    let visual: DOMRect;
    try {
      visual = effectBounds(element);
    } catch {
      warn(`${label}: visual group exceeded the capture complexity limit.`);
      return false;
    }
    const pixelRatio = 1; // Whole CSS pixels avoid Chromium snapping fractional replaced-image bounds.
    // Render directly on the source pixel grid; otherwise a fractional element
    // width gets scaled into a rounded PNG and then scaled a second time in Tidy.
    const original = new DOMRect(
      Math.floor(visual.left * pixelRatio) / pixelRatio,
      Math.floor(visual.top * pixelRatio) / pixelRatio,
      (Math.ceil(visual.right * pixelRatio) - Math.floor(visual.left * pixelRatio)) / pixelRatio,
      (Math.ceil(visual.bottom * pixelRatio) - Math.floor(visual.top * pixelRatio)) / pixelRatio,
    );
    if (
      original.width > 0 &&
      original.height > 0 &&
      original.width <= 5000 &&
      original.height <= 5000 &&
      result.assets.length < 100
    ) {
      try {
        const tiles = await rasterTiles(await rasterizeElement(element, original));
        addRaster(tiles, original, `${label}: ${reason}`.slice(0, 120), false, parent);
        warn(
          `${label}: ${reason} preserved as an isolated image with transparent edges; descendants are not separately editable.`,
        );
        return true;
      } catch {
        /* Unsupported resources fall back to the visible tab below. */
      }
    }
    // Snap screenshot crops to physical pixel boundaries to avoid resampling the
    // already-rasterized perspective edges when positioned back on the canvas.
    const ratio = 1; // Retain integer CSS bounds while sampling screenshot pixels at their full density.
    const snapped = new DOMRect(
      Math.floor(original.left * ratio) / ratio,
      Math.floor(original.top * ratio) / ratio,
      (Math.ceil(original.right * ratio) - Math.floor(original.left * ratio)) / ratio,
      (Math.ceil(original.bottom * ratio) - Math.floor(original.top * ratio)) / ratio,
    );
    const bounds = intersectBounds(
      snapped,
      new DOMRect(0, 0, startViewport.width, startViewport.height),
    );
    if (!viewport || !bounds || result.assets.length >= 100) {
      warn(
        `${label}: ${reason} could not be rasterized; geometry/effects are approximated. Capture this group in the visible viewport.`,
      );
      return false;
    }
    const canvas = document.createElement("canvas");
    const scale = Math.min(
      viewport.naturalWidth / startViewport.width,
      4096 / Math.max(bounds.width, bounds.height),
    );
    canvas.width = Math.max(1, Math.ceil(bounds.width * scale));
    canvas.height = Math.max(1, Math.ceil(bounds.height * scale));
    if (!cropScreenshot(canvas, bounds)) return false;
    try {
      const tiles = await rasterTiles(canvas.toDataURL("image/png").split(",")[1]!);
      // Pixels already include effects and overlaps. Paint opaque crops last.
      addRaster(tiles, bounds, `${label}: ${reason}`.slice(0, 120), true, parent);
    } catch {
      warn(
        `${label}: ${reason} exceeded the raster asset limit; effects are approximated. Capture a smaller region.`,
      );
      return false;
    }
    warn(
      `${label}: ${reason} flattened from the rendered tab, including its background and any overlapping content; descendants are not separately editable.`,
    );
    if (bounds.width < original.width || bounds.height < original.height)
      warn(
        `${label}: only the visible portion of this effect group was captured. Offscreen content was omitted; bring the complete group into view to capture it.`,
      );
    return true;
  };
  const asset = async (
    element: Element,
    bounds: DOMRect,
    css: CSSStyleDeclaration,
    backgroundUrl?: string,
    parent?: CaptureParent,
  ) => {
    const sourceUrl =
      backgroundUrl ??
      (element instanceof HTMLImageElement ? element.currentSrc || element.src : undefined);
    const imageKey =
      sourceUrl &&
      JSON.stringify([
        sourceUrl,
        bounds.width,
        bounds.height,
        css.objectFit,
        css.objectPosition,
        css.backgroundSize,
        css.backgroundPosition,
        window.devicePixelRatio,
      ]);
    const cachedPixels = imageKey && renderedImages.get(imageKey);
    if (!cachedPixels && result.assets.length >= 100 && element.localName !== "svg") {
      warn("Only 100 unique images could be imported; visible images were prioritized.");
      return;
    }
    const canvas = document.createElement("canvas");
    const scale = Math.min(
      window.devicePixelRatio || 1,
      1600 / Math.max(bounds.width, bounds.height),
    );
    canvas.width = Math.max(1, Math.ceil(bounds.width * scale));
    canvas.height = Math.max(1, Math.ceil(bounds.height * scale));
    const context = canvas.getContext("2d");
    if (!context) return;
    let base64: string | undefined;
    let fromScreenshot = false;
    let isolated = false;
    try {
      if (cachedPixels) base64 = cachedPixels;
      else if (element.tagName.toLowerCase() === "svg" && !backgroundUrl) {
        base64 = await rasterizeElement(element, bounds);
        isolated = true;
      } else {
        let source: CanvasImageSource;
        if (element instanceof HTMLCanvasElement && !backgroundUrl) source = element;
        else {
          const url =
            backgroundUrl ??
            (element instanceof HTMLImageElement ? element.currentSrc || element.src : undefined);
          if (!url || !/^(https?:|data:image\/|blob:)/i.test(url))
            throw new Error("Unrenderable image");
          let decoded = decodedImages.get(url);
          if (!decoded) {
            decoded = (async () => {
              const image = new Image();
              image.crossOrigin = "anonymous";
              image.src = url;
              await decodeCaptureImage(image, Math.min(3000, deadline - performance.now()));
              return image;
            })();
            decodedImages.set(url, decoded);
          }
          source = await decoded;
        }
        const sourceWidth =
          source instanceof HTMLImageElement
            ? source.naturalWidth
            : (source as HTMLCanvasElement).width;
        const sourceHeight =
          source instanceof HTMLImageElement
            ? source.naturalHeight
            : (source as HTMLCanvasElement).height;
        const fit = backgroundUrl ? css.backgroundSize : css.objectFit;
        if (["cover", "contain"].includes(fit) && sourceWidth && sourceHeight) {
          const ratio =
            fit === "cover"
              ? Math.max(canvas.width / sourceWidth, canvas.height / sourceHeight)
              : Math.min(canvas.width / sourceWidth, canvas.height / sourceHeight);
          const drawWidth = sourceWidth * ratio,
            drawHeight = sourceHeight * ratio;
          context.drawImage(
            source,
            (canvas.width - drawWidth) / 2,
            (canvas.height - drawHeight) / 2,
            drawWidth,
            drawHeight,
          );
        } else context.drawImage(source, 0, 0, canvas.width, canvas.height);
        base64 = canvas.toDataURL("image/png").split(",")[1];
      }
    } catch {
      // The browser screenshot can preserve tainted images, SVG, canvas and video in view.
      if (
        viewport &&
        intersectBounds(bounds, new DOMRect(0, 0, startViewport.width, startViewport.height))
      ) {
        // A partially visible image can still contribute the pixels in view.
        // Keep its crop bounds aligned with the imported layer.
        bounds = intersectBounds(
          bounds,
          new DOMRect(0, 0, startViewport.width, startViewport.height),
        )!;
        const ratio = 1;
        const left = Math.floor(bounds.left * ratio) / ratio,
          top = Math.floor(bounds.top * ratio) / ratio;
        bounds = new DOMRect(
          left,
          top,
          Math.ceil(bounds.right * ratio) / ratio - left,
          Math.ceil(bounds.bottom * ratio) / ratio - top,
        );
        // Preserve screenshot density and alignment, including small SVG icons.
        // Resizing also clears any origin taint from the failed direct draw.
        const screenshotScale = Math.min(
          viewport.naturalWidth / startViewport.width,
          4096 / Math.max(bounds.width, bounds.height),
        );
        canvas.width = Math.max(1, Math.round(bounds.width * screenshotScale));
        canvas.height = Math.max(1, Math.round(bounds.height * screenshotScale));
        if (cropScreenshot(canvas, bounds)) {
          base64 = canvas.toDataURL("image/png").split(",")[1];
          fromScreenshot = true;
          warn("Some visuals were rasterized from the visible tab.");
        }
      } else
        warn(
          "Some images or embedded visuals could not be read outside the visible viewport. Scroll to them and copy a smaller portion.",
        );
    }
    if (!base64) return;
    if (imageKey && !fromScreenshot) renderedImages.set(imageKey, base64);
    let id = assetIds.get(base64);
    if (!id) {
      if (result.assets.length >= 100) {
        warn("Only 100 unique images could be imported; visible images were prioritized.");
        return;
      }
      if (base64.length > 2_600_000 || assetBytes + base64.length > MAX_ASSET_BASE64_BYTES) {
        warn("Some images exceeded the capture's image size limit and were omitted.");
        return;
      }
      assetBytes += base64.length;
      id = crypto.randomUUID();
      assetIds.set(base64, id);
      result.assets.push({ id, mimeType: "image/png", base64 });
    }
    add(
      {
        type: "image",
        name: (
          element.getAttribute("alt") ||
          (backgroundUrl && "Background image") ||
          element.tagName.toLowerCase()
        ).slice(0, 120),
        style:
          fromScreenshot || isolated
            ? { objectFit: "fill" }
            : {
                ...captureStyle(css, false, bounds),
                fill: undefined,
                objectFit: "fill",
                ...(backgroundUrl && parent
                  ? {
                      opacity: 1,
                      borderWidth: 0,
                      borderTopWidth: 0,
                      borderRightWidth: 0,
                      borderBottomWidth: 0,
                      borderLeftWidth: 0,
                      shadow: undefined,
                      shadows: undefined,
                    }
                  : {}),
              },
        assetId: id,
        box: { x: 0, y: 0, width: 1, height: 1 },
      },
      bounds,
      parent,
    );
  };
  const queueAsset = (
    element: Element,
    bounds: DOMRect,
    css: CSSStyleDeclaration,
    backgroundUrl?: string,
    parent?: CaptureParent,
  ) => {
    let painted = intersectBounds(bounds, new DOMRect(originX, originY, width, height));
    if (!painted || bounds.width < 1 || bounds.height < 1) return;
    // Carousels often keep hundreds of loaded images outside their clipping
    // window. Those pixels cannot contribute to this import or its budget.
    for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
      const style = getComputedStyle(ancestor);
      const clipX = ["hidden", "clip", "auto", "scroll"].includes(
        style.overflowX || style.overflow,
      );
      const clipY = ["hidden", "clip", "auto", "scroll"].includes(
        style.overflowY || style.overflow,
      );
      if (clipX || clipY) {
        const box = ancestor.getBoundingClientRect();
        painted = intersectBounds(
          painted,
          new DOMRect(
            clipX ? box.left : painted.left,
            clipY ? box.top : painted.top,
            clipX ? box.width : painted.width,
            clipY ? box.height : painted.height,
          ),
        );
        if (!painted) return;
      }
      if (ancestor === root) break;
    }
    // Reserve paint order now; resolve image data later in viewport order.
    // The marker is replaced or removed before returning the document.
    const marker = { id: crypto.randomUUID() } as DesignNode;
    result.document.nodes.push(marker);
    assetJobs.push({
      visible: Boolean(
        intersectBounds(painted, new DOMRect(0, 0, startViewport.width, startViewport.height)),
      ),
      run: async () => {
        const index = result.document.nodes.indexOf(marker);
        result.document.nodes.splice(index, 1);
        const start = result.document.nodes.length;
        await asset(element, bounds, css, backgroundUrl, parent);
        const added = result.document.nodes.splice(start);
        result.document.nodes.splice(index, 0, ...added);
      },
    });
  };
  let visited = 0;
  let lastYield = performance.now();
  const visit = async (element: Element, depth: number, parent?: CaptureParent) => {
    if (performance.now() > deadline)
      throw new Error("This capture took too long. Select a smaller portion of the page.");
    if (++visited > 15000 || depth > 80 || result.document.nodes.length >= 5000) {
      warn("Some content exceeded the capture complexity limit. Select a smaller portion.");
      return;
    }
    if (performance.now() - lastYield > 8) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      lastYield = performance.now();
    }
    if (
      element.hasAttribute("data-bella-picker") ||
      ["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "HEAD"].includes(element.tagName)
    )
      return;
    if (isProtectedElement(element)) {
      warn("Form values and editable content were excluded from the capture.");
      return;
    }
    const css = getComputedStyle(element),
      bounds = element.getBoundingClientRect();
    if (css.display === "none" || css.visibility === "hidden" || css.opacity === "0") return;
    let effect = rasterEffect(css);
    for (const pseudo of ["::before", "::after"]) {
      const pseudoCss = getComputedStyle(element, pseudo);
      if (
        pseudoCss.content &&
        !["none", "normal"].includes(pseudoCss.content) &&
        pseudoCss.display !== "none" &&
        pseudoCss.visibility !== "hidden"
      )
        effect ??= rasterEffect(pseudoCss) ?? "Generated CSS content";
    }
    if (effect && (await rasterize(element, effect, parent))) return;
    const style = captureStyle(css, false, bounds);
    // The propagated color is already on every artboard. Painting it again at
    // body bounds would double the opacity of translucent canvas backgrounds.
    if (element === root && bodyCanvasBackground) style.fill = undefined;
    const paints = captureGradientStack(
      css,
      {
        width: Math.max(
          0.001,
          bounds.width -
            (parseFloat(css.borderLeftWidth) || 0) -
            (parseFloat(css.borderRightWidth) || 0),
        ),
        height: Math.max(
          0.001,
          bounds.height -
            (parseFloat(css.borderTopWidth) || 0) -
            (parseFloat(css.borderBottomWidth) || 0),
        ),
      },
      (value) => cssColor(value, true),
    );
    if (paints) {
      style.paints = [
        ...paints,
        ...(style.fill
          ? [
              {
                id: "css-background",
                type: "solid" as const,
                color: style.fill,
                visible: true,
                opacity: 1,
              },
            ]
          : []),
      ];
      style.fill = undefined;
    }
    if (
      (css.color && !cssColor(css.color)) ||
      (css.backgroundColor &&
        !cssColor(css.backgroundColor) &&
        css.backgroundColor !== "rgba(0, 0, 0, 0)" &&
        css.backgroundColor !== "transparent")
    )
      warn("Some advanced CSS colors were approximated.");
    const replaced = ["IMG", "SVG", "CANVAS", "VIDEO"].includes(element.tagName.toUpperCase());
    const clips = [css.overflow, css.overflowX, css.overflowY].some((value) =>
      ["hidden", "clip", "scroll", "auto"].includes(value),
    );
    let contentParent = parent;
    if (
      !replaced &&
      (style.paints ||
        style.fill ||
        style.borderWidth ||
        style.borderRightWidth ||
        style.borderBottomWidth ||
        style.borderLeftWidth ||
        style.shadow ||
        style.shadows ||
        clips ||
        style.opacity! < 1)
    ) {
      const nodes = add(
        {
          type: "container",
          name: (element.id || element.tagName.toLowerCase()).slice(0, 120),
          style,
          box: { x: 0, y: 0, width: 1, height: 1 },
        },
        bounds,
        parent,
      );
      if (clips || style.opacity! < 1) {
        for (const node of nodes.values()) node.style.overflow = clips ? "hidden" : "visible";
        contentParent = {
          bounds: new Map(
            [...nodes].map(([index, node]) => [
              index,
              new DOMRect(
                bounds.left,
                bounds.height > 5000 ? Math.max(bounds.top, originY + index * 5000) : bounds.top,
                bounds.width,
                node.box.height,
              ),
            ]),
          ),
          nodes,
        };
      }
    }
    if (["IFRAME", "OBJECT", "EMBED"].includes(element.tagName)) {
      warn("Embedded frames were omitted. Open the embedded page in its own tab to import it.");
      return;
    }
    const background = css.backgroundImage?.match(/^url\(["']?(.*?)["']?\)$/)?.[1];
    if (background) queueAsset(element, bounds, css, background, contentParent);
    else if (!paints && css.backgroundImage && css.backgroundImage !== "none")
      warn("Unsupported CSS gradients or background positioning were approximated.");
    if (replaced) {
      queueAsset(element, bounds, css, undefined, parent);
      return;
    }
    // Positioned content with explicit z-index must retain its paint order:
    // otherwise a later decorative forest can cover the hero's editable CTA.
    const children: { node: ChildNode; level: number }[] = [];
    const childLimit = Math.max(0, 15000 - visited);
    if (element.childNodes.length > childLimit)
      warn("Some content exceeded the capture complexity limit. Select a smaller portion.");
    for (let index = 0; index < Math.min(element.childNodes.length, childLimit); index++) {
      const node = element.childNodes[index]!;
      children.push({
        node,
        level: node instanceof Element ? Number.parseInt(getComputedStyle(node).zIndex) || 0 : 0,
      });
    }
    children.sort((a, b) => a.level - b.level);
    for (const { node: child } of children) {
      if (visited >= 15000 || result.document.nodes.length >= 5000) {
        warn("Some content exceeded the capture complexity limit. Select a smaller portion.");
        break;
      }
      if (child instanceof Element) {
        await visit(child, depth + 1, contentParent);
        continue;
      }
      if (child.nodeType !== Node.TEXT_NODE || !child.textContent?.trim()) continue;
      const range = document.createRange();
      const source = child.textContent.slice(0, 10000);
      let start = 0;
      while (start < source.length) {
        if (performance.now() > deadline)
          throw new Error("This capture took too long. Select a smaller portion of the page.");
        if (result.document.nodes.length >= 5000) {
          warn("Some content exceeded the capture complexity limit. Select a smaller portion.");
          break;
        }
        if (performance.now() - lastYield > 8) {
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
          lastYield = performance.now();
        }
        // Keep the browser's line breaks rather than reflowing tight glyph boxes
        // using the destination font's metrics. Binary search bounds the work.
        let end = source.length;
        range.setStart(child, start);
        range.setEnd(child, end);
        const rects = [...range.getClientRects()];
        if (rects.length > 1 && rects.some((rect) => Math.abs(rect.top - rects[0]!.top) > 1)) {
          let low = start + 1,
            high = end;
          while (low < high) {
            const mid = Math.ceil((low + high) / 2);
            range.setEnd(child, mid);
            const measured = [...range.getClientRects()];
            if (measured.every((rect) => Math.abs(rect.top - rects[0]!.top) <= 1)) low = mid;
            else high = mid - 1;
          }
          end = low;
        }
        let visibleStart = start,
          visibleEnd = end;
        if (!css.whiteSpace.startsWith("pre")) {
          while (visibleStart < visibleEnd && /\s/.test(source[visibleStart]!)) visibleStart++;
          while (visibleEnd > visibleStart && /\s/.test(source[visibleEnd - 1]!)) visibleEnd--;
        }
        start = end;
        if (visibleStart === visibleEnd) continue;
        range.setStart(child, visibleStart);
        range.setEnd(child, visibleEnd);
        const textBounds = range.getBoundingClientRect();
        let text = source.slice(visibleStart, visibleEnd);
        if (!css.whiteSpace.startsWith("pre")) text = text.replace(/\s+/g, " ");
        if (css.textTransform === "uppercase") text = text.toUpperCase();
        else if (css.textTransform === "lowercase") text = text.toLowerCase();
        const textStyle = captureStyle(css, true);
        const lineHeight = textStyle.fontSize! * textStyle.lineHeight!;
        const lineBounds = new DOMRect(
          textBounds.left,
          textBounds.top - (lineHeight - textBounds.height) / 2,
          textBounds.width,
          lineHeight,
        );
        add(
          {
            type: "text",
            name: text.slice(0, 120),
            text: text.slice(0, 10000),
            style: {
              ...textStyle,
              opacity: contentParent !== parent ? 1 : textStyle.opacity,
              textAlign: "left",
            },
            box: { x: 0, y: 0, width: 1, height: 1 },
          },
          lineBounds,
          contentParent,
        );
      }
      if (child.textContent.length > 10000)
        warn("A text layer exceeded 10,000 characters and was shortened.");
    }
    if (element.shadowRoot) {
      for (const child of element.shadowRoot.children) await visit(child, depth + 1, contentParent);
      warn("Open shadow DOM was imported; closed shadow roots cannot be inspected.");
    }
    for (const pseudo of ["::before", "::after"]) {
      const content = getComputedStyle(element, pseudo).content;
      if (content && content !== "none" && content !== "normal" && content !== '""')
        warn("Generated CSS content may be missing; text and shapes remain editable.");
    }
  };
  await visit(root, 0);
  assetJobs.sort((a, b) => Number(b.visible) - Number(a.visible));
  for (const job of assetJobs) {
    if (performance.now() > deadline)
      throw new Error("This capture took too long. Select a smaller portion of the page.");
    await job.run();
  }
  for (const render of rasterLayers) render();
  if (!sameViewport(startViewport, currentViewport()))
    throw new Error("The page moved or resized during capture. Try again with a stable viewport.");
  result.document.warnings = [...warnings].map((message) => ({ message }));
  if (new TextEncoder().encode(JSON.stringify(result)).byteLength > MAX_CAPTURE_BYTES - 1000)
    throw new Error("This capture is too large. Select a smaller portion of the page.");
  return result;
}
