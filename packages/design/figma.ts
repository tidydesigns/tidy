import { expandFigmaInstances } from "./figma-instances";
import { Inflate, Unzip, UnzipInflate } from "fflate";
import { Decompress } from "fzstd";
import { compileSchema, decodeBinarySchema } from "kiwi-schema";
import {
  nodeId as figNodeId,
  resolveVectorNodePaths,
  resolveGradientGeometry,
  type FigDocument,
  type FigNode,
  type FigColor,
  type FigPaint,
} from "openfig-core";
import {
  parseDesignDocument,
  type DesignDocument,
  type DesignNode,
  type DesignPaint,
} from "./document";

export type FigmaAsset = { id: string; mimeType: string; bytes: Uint8Array };
export type FigmaImport = { document: DesignDocument; assets: FigmaAsset[]; name: string };
import { FIGMA_LIMITS } from "./figma-input";
export { FIGMA_LIMITS, isFigmaClipboard, figmaClipboardBytes } from "./figma-input";
const decoder = new TextDecoder();
function fail(message: string): never {
  throw new Error(message);
}
function nodeId(node: FigNode): string {
  return figNodeId(node) ?? fail("Figma layer has no identity.");
}

function expand(data: Uint8Array, maximum: number): Uint8Array {
  const parts: Uint8Array[] = [];
  let size = 0;
  const receive = (chunk: Uint8Array) => {
    size += chunk.length;
    if (size > maximum) fail("Expanded Figma data is too large. Export fewer pages.");
    parts.push(chunk.slice());
  };
  const stream =
    data[0] === 0x28 && data[1] === 0xb5 && data[2] === 0x2f && data[3] === 0xfd
      ? new Decompress(receive)
      : new Inflate(receive);
  for (let i = 0; i < data.length; i += 4096)
    stream.push(data.subarray(i, i + 4096), i + 4096 >= data.length);
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of parts) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}
/** Bounded decoding shared by native clipboard payloads and exported .fig files. */
export function decodeFigma(input: Uint8Array): FigDocument {
  if (!input.length || input.length > FIGMA_LIMITS.inputBytes)
    fail("Choose a Figma file under 32 MB.");
  const images = new Map<string, Uint8Array>();
  let binary = input;
  if (input[0] === 0x50 && input[1] === 0x4b) {
    let total = 0;
    let canvas: Uint8Array | undefined;
    const unzip = new Unzip((file) => {
      if (file.originalSize && file.originalSize > FIGMA_LIMITS.expandedBytes)
        fail("Expanded Figma file is too large.");
      const relevant =
        file.name === "canvas.fig" || /(?:^|\/)images\/[a-fA-F0-9]+$/.test(file.name);
      if (!relevant) return;
      const parts: Uint8Array[] = [];
      let size = 0;
      file.ondata = (error, chunk, final) => {
        if (error) throw error;
        total += chunk.length;
        size += chunk.length;
        if (total > FIGMA_LIMITS.expandedBytes) fail("Expanded Figma file is too large.");
        parts.push(chunk.slice());
        if (final) {
          const bytes = new Uint8Array(size);
          let offset = 0;
          for (const part of parts) {
            bytes.set(part, offset);
            offset += part.length;
          }
          if (file.name === "canvas.fig") {
            if (canvas) fail("Figma archive contains multiple canvases.");
            canvas = bytes;
          } else images.set(file.name.split("/").at(-1)!.toLowerCase(), bytes);
        }
      };
      file.start();
    });
    unzip.register(UnzipInflate);
    for (let i = 0; i < input.length; i += 4096)
      unzip.push(input.subarray(i, i + 4096), i + 4096 >= input.length);
    if (!canvas) fail("This archive has no Figma Design canvas.");
    binary = canvas;
  }
  if (binary.length < 20 || decoder.decode(binary.subarray(0, 8)) !== "fig-kiwi")
    fail(
      "Use a Figma Design .fig export or copy Design layers. FigJam and Slides are not supported.",
    );
  const view = new DataView(binary.buffer, binary.byteOffset, binary.byteLength);
  const chunks: Uint8Array[] = [];
  for (let offset = 12; offset < binary.length;) {
    if (offset + 4 > binary.length) fail("Figma data is truncated.");
    const length = view.getUint32(offset, true);
    offset += 4;
    if (length > binary.length - offset) fail("Figma data is truncated.");
    if (chunks.length >= 64) fail("Figma data contains too many sections.");
    chunks.push(binary.subarray(offset, offset + length));
    offset += length;
  }
  if (chunks.length < 2) fail("Figma data is missing its schema or layers.");
  const schema = decodeBinarySchema(expand(chunks[0], 2_000_000));
  // Kiwi compiles schemas to JS. Only safe identifiers may enter that compiler.
  const safe = (name: string) =>
    /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) &&
    !["__proto__", "constructor", "prototype"].includes(name);
  if (
    (schema.package !== null && !safe(schema.package)) ||
    schema.definitions.length > 1000 ||
    schema.definitions.some(
      (d) =>
        !safe(d.name) ||
        d.fields.length > 2000 ||
        d.fields.some((f) => !safe(f.name) || (f.type !== null && !safe(f.type))),
    )
  )
    fail("Unsupported Figma schema.");
  const compiled = compileSchema(schema) as {
    decodeMessage(bytes: Uint8Array): { nodeChanges?: FigNode[]; blobs?: unknown[] };
  };
  const message = compiled.decodeMessage(expand(chunks[1], FIGMA_LIMITS.expandedBytes));
  if (!Array.isArray(message.nodeChanges) || message.nodeChanges.length > 50_000)
    fail("Figma file contains too many layers. Export fewer pages.");
  const nodes = message.nodeChanges.filter((n) => n.phase !== "REMOVED");
  const nodeMap = new Map<string, FigNode>();
  const childrenMap = new Map<string, FigNode[]>();
  for (const node of nodes) {
    const id = nodeId(node);
    if (!id || nodeMap.has(id)) fail("Figma file has invalid or duplicate layer identities.");
    nodeMap.set(id, node);
    if (node.parentIndex?.guid) {
      const p = nodeId({ guid: node.parentIndex.guid } as FigNode);
      const children = childrenMap.get(p) ?? [];
      children.push(node);
      childrenMap.set(p, children);
    }
  }
  for (const children of childrenMap.values())
    children.sort((a, b) =>
      (a.parentIndex?.position ?? "") < (b.parentIndex?.position ?? "")
        ? -1
        : (a.parentIndex?.position ?? "") === (b.parentIndex?.position ?? "")
          ? 0
          : 1,
    );
  return {
    header: { prelude: "fig-kiwi", version: view.getUint32(8, true) },
    nodes,
    nodeMap,
    childrenMap,
    schema,
    compiledSchema: compiled,
    message,
    rawChunks: chunks,
    images,
  };
}

function color(c: FigColor | undefined, opacity = 1) {
  if (!c) return "#000000";
  const byte = (v: number) =>
    Math.round(Math.max(0, Math.min(1, v)) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${byte(c.r)}${byte(c.g)}${byte(c.b)}${byte((c.a ?? 1) * opacity)}`;
}
const numeric = (value: unknown, fallback: number) =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;
function mime(bytes: Uint8Array) {
  if (bytes[0] === 0x89 && decoder.decode(bytes.subarray(1, 4)) === "PNG") return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
  if (
    decoder.decode(bytes.subarray(0, 4)) === "RIFF" &&
    decoder.decode(bytes.subarray(8, 12)) === "WEBP"
  )
    return "image/webp";
  return null;
}

export function convertFigma(
  doc: FigDocument,
  name = "Figma import",
  selectedPages?: string[],
): FigmaImport {
  const expanded = expandFigmaInstances(doc);
  doc = expanded.document;
  const requiredMasters = new Set<string>();
  const designTokens: NonNullable<DesignDocument["designTokens"]> = {};
  let variableSnapshot = false;
  const tokenNames = new Map<string, string>();
  const assets: FigmaAsset[] = [],
    nodes: DesignNode[] = [],
    warnings: DesignDocument["warnings"] = [];
  const ids = new Map(doc.nodes.map((n) => [nodeId(n), crypto.randomUUID()]));
  const assetIds = new Map<string, string>();
  const pages: NonNullable<DesignDocument["pages"]> = [];
  const visited = new Set<string>();
  let omittedWarnings = 0;
  const warningGroups = new Map<
    string,
    { warning: DesignDocument["warnings"][number]; count: number; first: string }
  >();
  const warn = (node: FigNode, message: string) => {
    const existing = warningGroups.get(message);
    if (existing) {
      existing.count++;
      existing.warning.message =
        `${message} (${existing.count} layers; first: ${existing.first})`.slice(0, 500);
      return;
    }
    if (warnings.length < 499) {
      const warning = {
        nodeId: ids.get(nodeId(node)),
        message: `${node.name || node.type}: ${message}`.slice(0, 500),
      };
      warnings.push(warning);
      warningGroups.set(message, { warning, count: 1, first: node.name || node.type });
    } else omittedWarnings++;
  };
  const image = (paint: FigPaint, node: FigNode) => {
    const hash = paint.image?.hash;
    const blobIndex = paint.image?.dataBlob;
    const key =
      typeof hash === "string"
        ? hash.toLowerCase()
        : hash instanceof Uint8Array
          ? Array.from(hash, (b) => b.toString(16).padStart(2, "0")).join("")
          : typeof blobIndex === "number"
            ? `blob:${blobIndex}`
            : "";
    if (assetIds.has(key)) return assetIds.get(key);
    let bytes = doc.images.get(key);
    // Native clipboard images may be carried as message blobs.
    if (!bytes && typeof paint.image?.dataBlob === "number") {
      const blobs = (doc.message as { blobs?: { bytes?: Uint8Array }[] }).blobs;
      bytes = blobs?.[paint.image.dataBlob]?.bytes;
    }
    const mimeType = bytes ? mime(bytes) : null;
    if (!bytes || !mimeType) {
      warn(node, "Image bytes are unavailable. Import the .fig file containing this image.");
      return undefined;
    }
    if (bytes.length > FIGMA_LIMITS.assetBytes || assets.length >= FIGMA_LIMITS.assets)
      fail("Figma images exceed this import's limit. Use smaller images or selections.");
    const id = crypto.randomUUID();
    assetIds.set(key || id, id);
    assets.push({ id, mimeType, bytes: bytes.slice() });
    return id;
  };
  const paints = (values: FigPaint[] | undefined, node: FigNode): DesignPaint[] =>
    (values ?? []).flatMap<DesignPaint>((paint, i) => {
      const base = {
        id: `paint-${i}`,
        opacity: numeric(paint.opacity, 1),
        visible: paint.visible !== false,
        ...(["NORMAL", "MULTIPLY", "SCREEN", "OVERLAY", "DARKEN", "LIGHTEN"].includes(
          paint.blendMode ?? "",
        )
          ? {
              blendMode: (paint.blendMode ?? "NORMAL").toLowerCase() as
                | "normal"
                | "multiply"
                | "screen"
                | "overlay"
                | "darken"
                | "lighten",
            }
          : {}),
      };
      if (
        paint.blendMode &&
        !["NORMAL", "MULTIPLY", "SCREEN", "OVERLAY", "DARKEN", "LIGHTEN"].includes(paint.blendMode)
      )
        warn(node, `Unsupported ${paint.blendMode} paint blending.`);
      if (paint.type === "SOLID") {
        const value = color(paint.color);
        const alias = (
          paint as FigPaint & {
            colorVar?: { value?: { alias?: { guid?: { sessionID: number; localID: number } } } };
          }
        ).colorVar?.value?.alias?.guid;
        let token: string | undefined;
        if (alias) {
          variableSnapshot = true;
          const variable = doc.nodeMap.get(`${alias.sessionID}:${alias.localID}`);
          const identity = `${alias.sessionID}:${alias.localID}:${value}`;
          token = tokenNames.get(identity);
          if (!token) {
            const slug = (name: string) =>
              name.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
            let base = slug(variable?.name ?? "color") || "color";
            if (!/^[a-zA-Z]/.test(base)) base = `color-${base}`;
            base = base.slice(0, 54);
            token = base;
            const collection = variable?.variableSetID?.guid;
            const collectionName = collection
              ? doc.nodeMap.get(`${collection.sessionID}:${collection.localID}`)?.name
              : undefined;
            if (Object.hasOwn(designTokens, token))
              token = `${base}-${slug(collectionName ?? "variant").slice(0, 8)}`;
            let suffix = 2;
            const proposed = token;
            while (Object.hasOwn(designTokens, token))
              token = `${proposed.slice(0, 58)}-${suffix++}`;
            tokenNames.set(identity, token);
          }
          designTokens[token] = { type: "color", value };
        }
        return [{ ...base, type: "solid" as const, color: value, ...(token ? { token } : {}) }];
      }
      if (paint.type === "IMAGE") {
        const assetId = image(paint, node);
        if (!assetId) return [];
        if (
          paint.transform &&
          JSON.stringify(paint.transform) !==
            JSON.stringify({ m00: 1, m01: 0, m02: 0, m10: 0, m11: 1, m12: 0 })
        )
          warn(node, "Image crop/transform is approximated.");
        return [
          {
            ...base,
            type: "image" as const,
            assetId,
            fit:
              (paint as FigPaint & { imageScaleMode?: string }).imageScaleMode === "FIT"
                ? ("contain" as const)
                : ("cover" as const),
            positionX: 50,
            positionY: 50,
          },
        ];
      }
      if (
        (paint.type === "GRADIENT_LINEAR" || paint.type === "GRADIENT_RADIAL") &&
        paint.stops &&
        paint.stops.length >= 2
      ) {
        const stops = paint.stops.map((s, j) => ({
          id: `stop-${j}`,
          position: s.position,
          color: color(s.color),
        }));
        const geometry = resolveGradientGeometry(
          {
            type: paint.type === "GRADIENT_LINEAR" ? "linear" : "radial",
            transform: paint.transform ?? { m00: 1, m01: 0, m02: 0, m10: 0, m11: 1, m12: 0 },
          },
          numeric(node.size?.x, 1),
          numeric(node.size?.y, 1),
        );
        if (geometry?.type === "linear") {
          return [
            {
              ...base,
              type: "linear" as const,
              stops,
              angle: 180,
              start: geometry.start,
              end: geometry.end,
            },
          ];
        }
        if (geometry?.type === "radial") {
          return [
            {
              ...base,
              type: "radial" as const,
              stops,
              centerX: geometry.center.x / numeric(node.size?.x, 1),
              centerY: geometry.center.y / numeric(node.size?.y, 1),
              radiusX: geometry.radiusX / numeric(node.size?.x, 1),
              radiusY: geometry.radiusY / numeric(node.size?.y, 1),
              rotation: (geometry.angle * 180) / Math.PI,
            },
          ];
        }
        warn(node, "Gradient transform is singular; using its first colour.");
        return [{ ...base, type: "solid" as const, color: stops[0].color }];
      }
      warn(node, `Unsupported ${paint.type} paint.`);
      return [];
    });
  function visit(n: FigNode, parentId: string | null, pageId: string, depth: number) {
    const key = nodeId(n);
    if (visited.has(key) || depth > FIGMA_LIMITS.depth)
      fail("Figma layer hierarchy is cyclic or too deeply nested.");
    visited.add(key);
    if (nodes.length >= FIGMA_LIMITS.nodes)
      fail(
        `This selection exceeds ${FIGMA_LIMITS.nodes.toLocaleString()} editable layers. Import fewer pages or frames.`,
      );
    const t = n.transform ?? { m00: 1, m01: 0, m02: 0, m10: 0, m11: 1, m12: 0 };
    const sx = Math.hypot(t.m00, t.m10),
      sy = Math.hypot(t.m01, t.m11);
    const width = numeric(n.size?.x, 1) * sx,
      height = numeric(n.size?.y, 1) * sy;
    if (width > 5000 || height > 5000)
      fail(`${n.name}: layer dimensions exceed 5,000 units. Resize this frame before importing.`);
    if (
      (doc.childrenMap.get(key)?.length ?? 0) > 0 &&
      (Math.abs(sx - 1) > 0.001 || Math.abs(sy - 1) > 0.001)
    )
      warn(n, "Scaled container children may require adjustment.");
    const rotation = (Math.atan2(t.m10, t.m00) * 180) / Math.PI;
    const determinant = t.m00 * t.m11 - t.m01 * t.m10;
    const style: DesignNode["style"] = {
      rotation,
      opacity: numeric(n.opacity, 1),
      radius: numeric(n.cornerRadius, 0),
      cornerSmoothing: numeric(n.cornerSmoothing, 0),
      ...(typeof n.rectangleTopLeftCornerRadius === "number"
        ? { radiusTopLeft: n.rectangleTopLeftCornerRadius }
        : {}),
      ...(typeof n.rectangleTopRightCornerRadius === "number"
        ? { radiusTopRight: n.rectangleTopRightCornerRadius }
        : {}),
      ...(typeof n.rectangleBottomLeftCornerRadius === "number"
        ? { radiusBottomLeft: n.rectangleBottomLeftCornerRadius }
        : {}),
      ...(typeof n.rectangleBottomRightCornerRadius === "number"
        ? { radiusBottomRight: n.rectangleBottomRightCornerRadius }
        : {}),
      paints: paints(n.fillPaints, n),
      borderWidth: n.strokePaints?.some((paint) => paint.visible !== false)
        ? numeric(n.strokeWeight, 0)
        : 0,
      strokePosition:
        n.strokeAlign === "OUTSIDE" ? "outside" : n.strokeAlign === "CENTER" ? "center" : "inside",
      overflow:
        ["FRAME", "SYMBOL", "INSTANCE"].includes(n.type) && !n.frameMaskDisabled && !n.resizeToFit
          ? "hidden"
          : "visible",
    };
    if (determinant < 0) style.flipY = true;
    if (Math.abs(t.m00 * t.m01 + t.m10 * t.m11) > 0.001) warn(n, "Skew transform is approximated.");
    const strokes = paints(n.strokePaints, n).filter(
      (p): p is Exclude<DesignPaint, { type: "image" }> => p.type !== "image",
    );
    if (strokes.length) style.strokePaints = strokes;
    const node: DesignNode = {
      id: ids.get(key)!,
      parentId,
      pageId,
      name: (n.name || n.type).slice(0, 120),
      type:
        n.type === "TEXT"
          ? "text"
          : n.type === "FRAME" && parentId === null
            ? "artboard"
            : "container",
      box: {
        x:
          numeric(t.m02, 0) +
          (t.m00 * numeric(n.size?.x, 1) + t.m01 * numeric(n.size?.y, 1) - width) / 2,
        y:
          numeric(t.m12, 0) +
          (t.m10 * numeric(n.size?.x, 1) + t.m11 * numeric(n.size?.y, 1) - height) / 2,
        width: Math.max(1, width),
        height: Math.max(1, height),
      },
      style,
      visible: n.visible !== false,
      locked: n.locked === true,
      sourceKey: key,
      layout: "absolute",
    };
    if (n.type === "TEXT") {
      node.text = n.textData?.characters ?? "";
      const textPaint = style.paints?.find((p) => p.type === "solid" && p.visible);
      if (textPaint?.type === "solid") {
        style.color = textPaint.color;
        style.colorToken = textPaint.token;
      } else style.color = "#000000";
      style.paints = undefined;
      style.fontFamily = n.fontName?.family ?? "Arial";
      style.fontSize = numeric(n.fontSize, 16);
      const face = n.fontName?.style ?? "Regular";
      style.fontWeight = /black|heavy/i.test(face)
        ? 900
        : /extra.?bold/i.test(face)
          ? 800
          : /semi.?bold/i.test(face)
            ? 600
            : /bold/i.test(face)
              ? 700
              : /medium/i.test(face)
                ? 500
                : /light/i.test(face)
                  ? 300
                  : 400;
      style.fontStyle = /italic|oblique/i.test(face) ? "italic" : "normal";
      style.textAlign =
        n.textAlignHorizontal === "CENTER"
          ? "center"
          : n.textAlignHorizontal === "RIGHT"
            ? "right"
            : "left";
      if (n.lineHeight?.units === "PIXELS") {
        style.lineHeightMode = "px";
        style.lineHeightPx = numeric(n.lineHeight.value, style.fontSize * 1.2);
      } else if (n.lineHeight?.units === "PERCENT") {
        style.lineHeightMode = "percent";
        style.lineHeight = numeric(n.lineHeight.value, 120) / 100;
      } else style.lineHeightMode = "auto";
      if (n.letterSpacing?.units === "PIXELS")
        style.letterSpacing = numeric(n.letterSpacing.value, 0);
      else if (n.letterSpacing?.units === "PERCENT")
        style.letterSpacing = (style.fontSize * numeric(n.letterSpacing.value, 0)) / 100;
      if (
        (n.textData as { characterStyleIDs?: number[] } | undefined)?.characterStyleIDs?.some(
          (id: number) => id !== 0,
        )
      )
        warn(n, "Mixed text formatting is approximated with the layer's base style.");
    } else if (
      ["VECTOR", "ELLIPSE", "LINE", "REGULAR_POLYGON", "STAR", "BOOLEAN_OPERATION"].includes(n.type)
    ) {
      const geometry = resolveVectorNodePaths(doc, n);
      const outlined = !geometry.fill.length && geometry.stroke.length > 0;
      const paths = outlined ? geometry.stroke : geometry.fill;
      if (outlined) {
        style.paints = strokes;
        style.strokePaints = undefined;
        style.borderWidth = 0;
        warn(
          n,
          "Stroke imported as editable outline paths; stroke width is baked into the geometry.",
        );
      }
      if (paths.length) {
        node.type = "vector";
        node.vectorPath = {
          d: paths.map((p) => p.svgPath).join(" "),
          viewBox: {
            x: 0,
            y: 0,
            width: Math.max(1, numeric(n.size?.x, 1)),
            height: Math.max(1, numeric(n.size?.y, 1)),
          },
          fillRule: paths.some((p) => p.windingRule === "ODD") ? "evenodd" : "nonzero",
        };
        if (paths.some((p) => p.styleID !== 0)) warn(n, "Vector region styles are approximated.");
      } else if (n.type === "ELLIPSE") {
        node.type = "vector";
        node.vectorPath = {
          d: `M ${width / 2} 0 A ${width / 2} ${height / 2} 0 1 1 ${width / 2} ${height} A ${width / 2} ${height / 2} 0 1 1 ${width / 2} 0 Z`,
          viewBox: { x: 0, y: 0, width: Math.max(1, width), height: Math.max(1, height) },
          fillRule: "nonzero",
        };
      } else warn(n, "Editable vector geometry is unavailable.");
    } else if (
      ![
        "FRAME",
        "RECTANGLE",
        "ROUNDED_RECTANGLE",
        "GROUP",
        "SECTION",
        "SYMBOL",
        "INSTANCE",
      ].includes(n.type)
    )
      warn(n, `Unsupported ${n.type} layer; imported as a container.`);
    if (n.type === "SYMBOL" && !expanded.links.has(key)) node.isComponent = true;
    const linked = expanded.links.get(key);
    if (linked) {
      node.instanceOf = ids.get(linked.master);
      node.componentSourceId = ids.get(linked.source);
      requiredMasters.add(linked.master);
    }
    if (n.type === "INSTANCE" && (!linked || expanded.unsupported.has(key)))
      warn(
        n,
        "Some component overrides or dependencies could not be resolved; inspect this instance.",
      );
    const nativeStack =
      (n.stackMode === "HORIZONTAL" || n.stackMode === "VERTICAL") &&
      !n.stackReverseZIndex &&
      n.stackPrimaryAlignItems !== "SPACE_EVENLY";
    if (nativeStack) {
      const horizontal = n.stackMode === "HORIZONTAL";
      node.layout = horizontal ? "flex-row" : "flex-column";
      const hug = (value: unknown) =>
        typeof value === "string" && value.startsWith("RESIZE_TO_FIT");
      node.widthMode = hug(horizontal ? n.stackPrimarySizing : n.stackCounterSizing)
        ? "hug"
        : "fixed";
      node.heightMode = hug(horizontal ? n.stackCounterSizing : n.stackPrimarySizing)
        ? "hug"
        : "fixed";
      node.gap = numeric(n.stackSpacing, 0);
      node.paddingLeft = numeric(n.stackHorizontalPadding, numeric(n.stackPadding, 0));
      node.paddingTop = numeric(n.stackVerticalPadding, numeric(n.stackPadding, 0));
      node.paddingRight = numeric(n.stackPaddingRight, node.paddingLeft);
      node.paddingBottom = numeric(n.stackPaddingBottom, node.paddingTop);
      node.align =
        n.stackCounterAlignItems === "CENTER"
          ? "center"
          : n.stackCounterAlignItems === "MAX"
            ? "end"
            : n.stackCounterAlignItems === "BASELINE"
              ? "baseline"
              : "start";
      const justify = n.stackPrimaryAlignItems ?? n.stackJustify;
      node.justify =
        justify === "CENTER"
          ? "center"
          : justify === "MAX"
            ? "end"
            : justify === "SPACE_BETWEEN"
              ? "space-between"
              : "start";
      node.wrap = n.stackWrap === "WRAP";
    } else if (n.stackMode && n.stackMode !== "NONE")
      warn(n, "Unsupported Auto Layout preserved at its measured positions.");
    if (n.type === "TEXT") {
      style.textVerticalAlign =
        n.textAlignVertical === "CENTER"
          ? "center"
          : n.textAlignVertical === "BOTTOM"
            ? "bottom"
            : "top";
      node.widthMode = n.textAutoResize === "WIDTH_AND_HEIGHT" ? "hug" : "fixed";
      node.heightMode = ["WIDTH_AND_HEIGHT", "HEIGHT"].includes(n.textAutoResize) ? "hug" : "fixed";
      if (n.textAutoResize === "WIDTH_AND_HEIGHT") style.textWrap = "nowrap";
      style.paragraphSpacing = numeric(n.paragraphSpacing, 0);
      if (n.textDecoration === "UNDERLINE") style.textDecoration = "underline";
      if (n.textDecoration === "STRIKETHROUGH") style.textDecoration = "line-through";
    }
    const originalParent =
      parentId && n.parentIndex
        ? doc.nodeMap.get(nodeId({ guid: n.parentIndex.guid } as FigNode))
        : undefined;
    if (
      originalParent &&
      ["HORIZONTAL", "VERTICAL"].includes(originalParent.stackMode ?? "") &&
      !originalParent.stackReverseZIndex
    ) {
      const horizontal = originalParent.stackMode === "HORIZONTAL";
      node.positionMode = n.stackPositioning === "ABSOLUTE" ? "absolute" : "auto";
      if (n.stackChildPrimaryGrow > 0) {
        if (horizontal) node.widthMode = "fill";
        else node.heightMode = "fill";
      }
      if (n.stackChildAlignSelf === "STRETCH") {
        node.alignSelf = "stretch";
        if (horizontal) node.heightMode = "fill";
        else node.widthMode = "fill";
      } else if (n.stackChildAlignSelf === "CENTER") node.alignSelf = "center";
      else if (n.stackChildAlignSelf === "MAX") node.alignSelf = "end";
    }
    if (n.isMask || n.mask) warn(n, "Mask behaviour is not imported yet.");
    if (n.boundVariables || n.variableBindings) warn(n, "Variable bindings are not imported yet.");
    for (const effect of n.effects ?? []) {
      if (effect.visible === false) continue;
      if (effect.type === "DROP_SHADOW" || effect.type === "INNER_SHADOW") {
        style.shadows ??= [];
        style.shadows.push({
          id: `effect-${style.shadows.length}`,
          x: numeric(effect.offset?.x, 0),
          y: numeric(effect.offset?.y, 0),
          blur: numeric(effect.radius, 0),
          spread: numeric(effect.spread, 0),
          color: color(effect.color, numeric(effect.opacity, 1)),
          inset: effect.type === "INNER_SHADOW",
          visible: true,
        });
      } else if (effect.type === "FOREGROUND_BLUR") style.blur = numeric(effect.radius, 0);
      else if (effect.type === "BACKGROUND_BLUR") style.backdropBlur = numeric(effect.radius, 0);
      else warn(n, `Unsupported ${effect.type} effect.`);
    }
    nodes.push(node);
    for (const child of doc.childrenMap.get(key) ?? []) visit(child, node.id, pageId, depth + 1);
  }
  if (selectedPages && !selectedPages.length) fail("Choose at least one Figma page.");
  const sourcePages = doc.nodes.filter(
    (n) =>
      n.type === "CANVAS" &&
      !n.internalOnly &&
      (!selectedPages || selectedPages.includes(nodeId(n))),
  );
  if (selectedPages && sourcePages.length !== new Set(selectedPages).size)
    fail("Selected Figma pages are unavailable.");
  if (sourcePages.length)
    for (const p of sourcePages) {
      const id = ids.get(nodeId(p))!;
      pages.push({ id, name: p.name.slice(0, 120) || "Page" });
      for (const root of doc.childrenMap.get(nodeId(p)) ?? []) visit(root, null, id, 0);
    }
  else {
    const id = "page-1";
    pages.push({ id, name: "Page 1" });
    const roots = doc.nodes.filter(
      (n) =>
        !["DOCUMENT", "CANVAS"].includes(n.type) &&
        (!n.parentIndex ||
          !doc.nodeMap.has(nodeId({ guid: n.parentIndex.guid } as FigNode)) ||
          ["DOCUMENT", "CANVAS"].includes(
            doc.nodeMap.get(nodeId({ guid: n.parentIndex.guid } as FigNode))!.type,
          )),
    );
    for (const root of roots) visit(root, null, id, 0);
  }
  for (const masterKey of requiredMasters) {
    if (visited.has(masterKey)) continue;
    const master = doc.nodeMap.get(masterKey);
    if (!master) continue;
    let dependencyPage = pages.find((page) => page.id === "figma-components");
    if (!dependencyPage) {
      dependencyPage = { id: "figma-components", name: "Imported components" };
      pages.push(dependencyPage);
    }
    visit(master, null, dependencyPage.id, 0);
  }
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const identity = new Set([
    "id",
    "parentId",
    "pageId",
    "name",
    "sourceKey",
    "isComponent",
    "instanceOf",
    "componentSourceId",
    "instanceOverrides",
  ]);
  function changedPaths(before: unknown, after: unknown, prefix: string): string[] {
    if (JSON.stringify(before) === JSON.stringify(after)) return [];
    if (
      before &&
      after &&
      typeof before === "object" &&
      typeof after === "object" &&
      !Array.isArray(before) &&
      !Array.isArray(after)
    ) {
      const a = before as Record<string, unknown>,
        b = after as Record<string, unknown>;
      return [...new Set([...Object.keys(a), ...Object.keys(b)])].flatMap((key) =>
        changedPaths(a[key], b[key], prefix ? `${prefix}.${key}` : key),
      );
    }
    return [prefix];
  }
  for (const node of nodes) {
    if (!node.instanceOf || !node.componentSourceId) continue;
    const source = byId.get(node.componentSourceId);
    if (!source) continue;
    node.instanceOverrides = changedPaths(source, node, "").filter(
      (path) => !identity.has(path.split(".")[0]),
    );
  }
  if (!nodes.length) fail("No editable Design layers were found in this Figma selection.");
  if (variableSnapshot) {
    if (warnings.length < 499)
      warnings.push({
        message:
          "Variable colours imported as named snapshots. Collection modes and aliases are not linked.",
      });
    else omittedWarnings++;
  }
  if (omittedWarnings)
    warnings.push({
      message: `${omittedWarnings} additional layers use the same approximations. This import is not fully faithful.`,
    });
  return {
    name: name.slice(0, 120),
    assets,
    document: parseDesignDocument({
      schemaVersion: 1,
      legacyConverted: true,
      nodes,
      pages,
      tokens: {},
      designTokens,
      warnings,
      editedNodeIds: [],
    }),
  };
}
export function importFigma(input: Uint8Array, name?: string, pages?: string[]) {
  return convertFigma(decodeFigma(input), name, pages);
}

export type FigmaPage = { id: string; name: string; nodeCount: number };
export function figmaPages(doc: FigDocument): FigmaPage[] {
  function count(id: string, visiting = new Set<string>()): number {
    if (visiting.has(id) || visiting.size > FIGMA_LIMITS.depth)
      fail("Figma hierarchy is cyclic or too deeply nested.");
    visiting.add(id);
    let size = 0;
    for (const child of doc.childrenMap.get(id) ?? []) size += 1 + count(nodeId(child), visiting);
    visiting.delete(id);
    return size;
  }
  return doc.nodes
    .filter((node) => node.type === "CANVAS" && !node.internalOnly)
    .map((node) => ({ id: nodeId(node), name: node.name, nodeCount: count(nodeId(node)) }));
}
