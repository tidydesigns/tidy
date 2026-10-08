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
  effectBounds,
  intersectBounds,
  protectedBounds,
  rasterEffect,
  sameViewport,
  type CaptureViewport,
} from "./capture-effects";

const MAX_ASSET_BASE64_BYTES = 13_000_000; // Leave 3 MB for nodes and capture metadata.

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

export function cssColor(value: string, preserveTransparent = false): string | undefined {
  if (value === "transparent") return preserveTransparent ? "#00000000" : undefined;
  if (value.startsWith("#")) return /^#[\da-f]{6}([\da-f]{2})?$/i.test(value) ? value : undefined;
  const match = value.match(
    /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/,
  );
  if (!match) return undefined;
  const alpha = match[4] ? Number.parseFloat(match[4]) / (match[4].endsWith("%") ? 100 : 1) : 1;
  if (alpha === 0 && !preserveTransparent) return undefined;
  const channels = match.slice(1, 4).map((part) => clamp(Math.round(Number(part)), 0, 255));
  if (alpha < 1) channels.push(clamp(Math.round(alpha * 255), 0, 255));
  return `#${channels.map((part) => part.toString(16).padStart(2, "0")).join("")}`;
}

export function captureStyle(css: CSSStyleDeclaration, text = false): DesignNode["style"] {
  const px = (value: string) => Number.parseFloat(value) || 0;
  const style: DesignNode["style"] = {
    opacity: clamp(Number.parseFloat(css.opacity) || (css.opacity === "0" ? 0 : 1), 0, 1),
    radius: clamp(px(css.borderTopLeftRadius), 0, 500),
    borderColor: cssColor(css.borderTopColor),
    borderWidth: clamp(px(css.borderTopWidth), 0, 40),
    overflow: css.overflow === "hidden" || css.overflow === "clip" ? "hidden" : "visible",
    fill: cssColor(css.backgroundColor),
  };
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
      shadow: undefined,
      shadows: undefined,
      radius: 0,
      color: cssColor(css.color) ?? "#000000",
      fontSize: size,
      fontFamily: css.fontFamily.slice(0, 100),
      fontWeight: clamp(px(css.fontWeight) || 400, 100, 900),
      lineHeight: css.lineHeight === "normal" ? 1.2 : clamp(px(css.lineHeight) / size, 0.5, 4),
      letterSpacing: clamp(px(css.letterSpacing), -100, 100),
      fontStyle: css.fontStyle === "italic" ? "italic" : "normal",
      textAlign: ["left", "center", "right"].includes(css.textAlign) ? css.textAlign : "left",
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
): Promise<WebCapture> {
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
          `${root.tagName.toLowerCase()} · ${document.title}`
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
  const background: string =
    cssColor(getComputedStyle(root).backgroundColor) ??
    cssColor(getComputedStyle(document.documentElement).backgroundColor) ??
    "#ffffff";
  for (let y = 0; y < height; y += 5000) {
    const frame: DesignNode = {
      id: crypto.randomUUID(),
      parentId: null,
      type: "artboard",
      name: `${result.title}${height > 5000 ? ` · ${frames.length + 1}` : ""}`.slice(0, 120),
      box: { x: frames.length * (width + 120), y: 0, width, height: Math.min(5000, height - y) },
      style: { fill: background, overflow: "hidden" },
      visible: true,
      locked: false,
      layout: "absolute",
    };
    frames.push(frame);
  }
  result.document.nodes.push(...frames);
  const add = (
    node: Omit<DesignNode, "id" | "parentId" | "visible" | "locked" | "layout">,
    bounds: DOMRect,
  ) => {
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
      return;
    for (
      let index = Math.max(0, Math.floor(y / 5000));
      index < frames.length && index * 5000 < y + bounds.height;
      index++
    ) {
      if (result.document.nodes.length >= 5000) {
        warn(
          "The capture reached Tidy's 5,000-layer limit. Select a smaller portion for the remaining content.",
        );
        return;
      }
      result.document.nodes.push({
        ...node,
        id: crypto.randomUUID(),
        parentId: frames[index]!.id,
        box: {
          x: clamp(x, -100000, 100000),
          y: clamp(y - index * 5000, -100000, 100000),
          width: clamp(bounds.width, 1, 5000),
          height: clamp(bounds.height, 1, 5000),
        },
        visible: true,
        locked: false,
        layout: "absolute",
      });
    }
  };
  const startViewport = currentViewport();
  let viewport: HTMLImageElement | undefined;
  let privateRegions: DOMRect[] = [];
  if (screenshot && (!screenshotViewport || sameViewport(screenshotViewport, startViewport))) {
    viewport = new Image();
    viewport.src = screenshot;
    try {
      await viewport.decode();
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
  const rasterLayers: (() => void)[] = [];
  const cropScreenshot = (canvas: HTMLCanvasElement, bounds: DOMRect) => {
    if (!viewport || !sameViewport(startViewport, currentViewport())) return false;
    const context = canvas.getContext("2d");
    if (!context) return false;
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
    for (const region of privateRegions) {
      const overlap = intersectBounds(bounds, region);
      if (!overlap) continue;
      // Overwrite with opaque pixels, never alpha-clear (which could reveal a lower crop).
      context.fillStyle = "#ffffff";
      const sx = canvas.width / bounds.width,
        sy = canvas.height / bounds.height;
      context.fillRect(
        Math.floor((overlap.left - bounds.left) * sx),
        Math.floor((overlap.top - bounds.top) * sy),
        Math.ceil(overlap.width * sx) + 1,
        Math.ceil(overlap.height * sy) + 1,
      );
      warn(
        "Form controls, editable content and embedded frames were redacted from screenshot fallbacks.",
      );
    }
    return true;
  };
  const addRaster = (tiles: RasterTile[], bounds: DOMRect, name: string, overlay = false) => {
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
        );
        return;
      }
      // A single group keeps the tiled visual movable as one object in Tidy.
      const start = result.document.nodes.length;
      add({ type: "container", name, style: {}, box: { x: 0, y: 0, width: 1, height: 1 } }, bounds);
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
  const rasterize = async (element: Element, reason: string) => {
    const label = (
      element.id ||
      element.getAttribute("aria-label") ||
      element.getAttribute("class") ||
      element.tagName.toLowerCase()
    ).slice(0, 100);
    const visual = effectBounds(element);
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
        addRaster(tiles, original, `${label} · ${reason}`.slice(0, 120));
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
      addRaster(tiles, bounds, `${label} · ${reason}`.slice(0, 120), true);
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
  ) => {
    if (result.assets.length >= 100) {
      warn("Only the first 100 images were imported.");
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
    try {
      let source: CanvasImageSource;
      if (element instanceof HTMLCanvasElement && !backgroundUrl) source = element;
      else {
        const url =
          backgroundUrl ??
          (element instanceof HTMLImageElement ? element.currentSrc || element.src : undefined);
        if (!url || !/^(https?:|data:image\/|blob:)/i.test(url))
          throw new Error("Unrenderable image");
        const image = new Image();
        image.crossOrigin = "anonymous";
        image.src = url;
        await Promise.race([
          image.decode(),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("Image timed out")), 3000),
          ),
        ]);
        source = image;
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
    } catch {
      // The browser screenshot can preserve tainted images, SVG, canvas and video in view.
      if (
        viewport &&
        bounds.left >= 0 &&
        bounds.top >= 0 &&
        bounds.right <= window.innerWidth &&
        bounds.bottom <= window.innerHeight
      ) {
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
    if (base64.length > 2_600_000 || assetBytes + base64.length > MAX_ASSET_BASE64_BYTES) {
      warn("Some images exceeded the capture's image size limit and were omitted.");
      return;
    }
    assetBytes += base64.length;
    const id = crypto.randomUUID();
    result.assets.push({ id, mimeType: "image/png", base64 });
    add(
      {
        type: "image",
        name: (
          element.getAttribute("alt") ||
          (backgroundUrl && "Background image") ||
          element.tagName.toLowerCase()
        ).slice(0, 120),
        style: fromScreenshot
          ? { objectFit: "fill" }
          : { ...captureStyle(css), fill: undefined, objectFit: "fill" },
        assetId: id,
        box: { x: 0, y: 0, width: 1, height: 1 },
      },
      bounds,
    );
  };
  let visited = 0;
  const visit = async (element: Element, depth: number) => {
    if (++visited > 15000 || depth > 80 || result.document.nodes.length >= 5000) {
      warn("Some content exceeded the capture complexity limit. Select a smaller portion.");
      return;
    }
    if (
      element.hasAttribute("data-bella-picker") ||
      ["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "HEAD"].includes(element.tagName)
    )
      return;
    const css = getComputedStyle(element),
      bounds = element.getBoundingClientRect();
    if (css.display === "none" || css.visibility === "hidden" || css.opacity === "0") return;
    let effect = rasterEffect(css);
    for (const pseudo of ["::before", "::after"]) {
      const pseudoCss = getComputedStyle(element, pseudo);
      if (pseudoCss.content && !["none", "normal"].includes(pseudoCss.content))
        effect ??= rasterEffect(pseudoCss);
    }
    if (effect && (await rasterize(element, effect))) return;
    const style = captureStyle(css);
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
    if (style.paints || style.fill || style.borderWidth || style.shadow)
      add(
        {
          type: "container",
          name: (element.id || element.tagName.toLowerCase()).slice(0, 120),
          style,
          box: { x: 0, y: 0, width: 1, height: 1 },
        },
        bounds,
      );
    if (css.transform && css.transform !== "none")
      warn("CSS transforms were approximated using rendered bounds.");
    if ((css.filter && css.filter !== "none") || (css.clipPath && css.clipPath !== "none"))
      warn("Some CSS filters or clipping effects were approximated.");
    if (["IFRAME", "OBJECT", "EMBED"].includes(element.tagName)) {
      warn("Embedded frames were omitted. Open the embedded page in its own tab to import it.");
      return;
    }
    const background = css.backgroundImage?.match(/^url\(["']?(.*?)["']?\)$/)?.[1];
    if (background) await asset(element, bounds, css, background);
    else if (!paints && css.backgroundImage && css.backgroundImage !== "none")
      warn("Unsupported CSS gradients or background positioning were approximated.");
    if (["IMG", "SVG", "CANVAS", "VIDEO"].includes(element.tagName.toUpperCase())) {
      await asset(element, bounds, css);
      return;
    }
    // Form values can contain secrets. Capture the control's appearance, never its value.
    if (["INPUT", "TEXTAREA", "SELECT"].includes(element.tagName)) {
      warn("Form values were excluded from the capture.");
      return;
    }
    // Positioned content with explicit z-index must retain its paint order:
    // otherwise a later decorative forest can cover the hero's editable CTA.
    const stackingLevel = (node: ChildNode) =>
      node instanceof Element ? Number.parseInt(getComputedStyle(node).zIndex) || 0 : 0;
    const children = [...element.childNodes].sort((a, b) => stackingLevel(a) - stackingLevel(b));
    for (const child of children) {
      if (child instanceof Element) {
        await visit(child, depth + 1);
        continue;
      }
      if (child.nodeType !== Node.TEXT_NODE || !child.textContent?.trim()) continue;
      const range = document.createRange();
      range.selectNodeContents(child);
      const textBounds = range.getBoundingClientRect();
      let text = child.textContent;
      if (!css.whiteSpace.startsWith("pre")) text = text.replace(/\s+/g, " ").trim();
      if (css.textTransform === "uppercase") text = text.toUpperCase();
      else if (css.textTransform === "lowercase") text = text.toLowerCase();
      add(
        {
          type: "text",
          name: text.slice(0, 120),
          text: text.slice(0, 10000),
          style: captureStyle(css, true),
          box: { x: 0, y: 0, width: 1, height: 1 },
        },
        textBounds,
      );
      if (text.length > 10000) warn("A text layer exceeded 10,000 characters and was shortened.");
    }
    if (element.shadowRoot) {
      for (const child of element.shadowRoot.children) await visit(child, depth + 1);
      warn("Open shadow DOM was imported; closed shadow roots cannot be inspected.");
    }
    for (const pseudo of ["::before", "::after"]) {
      const content = getComputedStyle(element, pseudo).content;
      if (content && content !== "none" && content !== "normal" && content !== '""')
        warn("Generated CSS content may be missing; text and shapes remain editable.");
    }
  };
  await visit(root, 0);
  for (const render of rasterLayers) render();
  if (!sameViewport(startViewport, currentViewport()))
    throw new Error("The page moved or resized during capture. Try again with a stable viewport.");
  result.document.warnings = [...warnings].map((message) => ({ message }));
  if (new TextEncoder().encode(JSON.stringify(result)).byteLength > MAX_CAPTURE_BYTES - 1000)
    throw new Error("This capture is too large. Select a smaller portion of the page.");
  return result;
}
