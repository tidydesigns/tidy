import { AgentOperationError } from "./contracts";
import { textFontSegments } from "@tidy/design/rich-text-runtime";
import type { DesignNode } from "@tidy/design/document";
import { fontCssForText } from "@tidy/editor/design/fonts/export-css";
import {
  fontFamilies,
  googleFontUrl,
  closestFontStyle,
  genericFonts,
} from "@tidy/editor/design/fonts/font-utils";

import type { RenderDiagnostic } from "./render-diagnostics";
import { bundledCanvasFontCss } from "../../../scripts/canvas-fonts";

declare const TIDY_CANVAS_FONT_CSS: Record<string, string> | undefined;
const cached = new Map<string, string>();
let bundled: Promise<Record<string, string>> | undefined;
let catalog: Promise<typeof import("@tidy/editor/design/fonts/catalog")> | undefined;

async function fontResource(url: string, host: string, signal: AbortSignal) {
  const parsed = new URL(url);
  if (
    parsed.protocol !== "https:" ||
    parsed.hostname !== host ||
    parsed.port ||
    parsed.username ||
    parsed.password
  )
    throw new Error("Unsupported font resource URL.");
  const response = await fetch(parsed, {
    signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]),
    redirect: "error",
  });
  if (!response.ok || Number(response.headers.get("content-length")) > 4 * 1024 * 1024)
    throw new Error("Font resource is unavailable or too large.");
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Empty font response.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 4 * 1024 * 1024) throw new Error("Font resource exceeds 4 MB.");
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  return Buffer.concat(chunks);
}

export async function canvasFonts(nodes: DesignNode[], signal: AbortSignal) {
  const diagnostics: RenderDiagnostic[] = [];
  const requests = new Map<
    string,
    {
      family: string;
      weight: number;
      italic: boolean;
      text: string;
      source?: string;
      face?: string;
    }
  >();
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const visibility = new Map<string, boolean>();
  const visible = (node: DesignNode): boolean => {
    const cached = visibility.get(node.id);
    if (cached !== undefined) return cached;
    const parent = node.parentId ? byId.get(node.parentId) : undefined;
    const result = node.visible && (!parent || visible(parent));
    visibility.set(node.id, result);
    return result;
  };
  for (const node of nodes) {
    if (node.type !== "text" || !visible(node)) continue;
    for (const segment of textFontSegments({ ...node, text: node.text ?? "" })) {
      const family = fontFamilies(node.style.fontFamily ?? "system-ui")[0] ?? "system-ui";
      const key = JSON.stringify([
        family,
        segment.weight,
        segment.italic,
        node.style.fontSource,
        segment.face,
      ]);
      const prior = requests.get(key);
      requests.set(key, {
        family,
        weight: segment.weight,
        italic: segment.italic,
        text: (prior?.text ?? "") + segment.text,
        source: node.style.fontSource,
        face: segment.face,
      });
    }
  }
  if (requests.size > 64)
    throw new AgentOperationError("BUSY", "Preview supports at most 64 distinct font faces.");
  const owned =
    typeof TIDY_CANVAS_FONT_CSS === "object"
      ? TIDY_CANVAS_FONT_CSS
      : await (bundled ??= bundledCanvasFontCss());
  const styles = new Set<string>();
  let bytes = 0;
  for (const request of requests.values()) {
    signal.throwIfAborted();
    const { family, weight, italic, text, source, face } = request;
    const resource = `${face ?? family} ${weight}${italic ? " italic" : ""}`;
    if (source === "local" || face) {
      diagnostics.push({
        kind: "missing_font",
        resource,
        message:
          "Local font bytes and embedding permission are unavailable to the isolated renderer.",
      });
      continue;
    }
    const bundledFamily = Object.keys(owned).find(
      (name) => name.toLowerCase() === family.toLowerCase(),
    );
    const bundledCss =
      bundledFamily &&
      !italic &&
      weight >= 400 &&
      weight <= (bundledFamily === "Instrument Sans" ? 700 : 400) &&
      /^[\u0000-\u00ff\u0131\u0152\u0153\u02bb\u02bc\u02c6\u02da\u02dc\u2000-\u206f\u20ac\u2122\u2191\u2193\u2212\u2215\ufeff\ufffd]*$/.test(
        text,
      )
        ? owned[bundledFamily]
        : undefined;
    const font =
      !bundledCss && source !== "system" && !genericFonts.has(family.toLowerCase())
        ? (await (catalog ??= import("@tidy/editor/design/fonts/catalog"))).webFontByName.get(
            family.toLowerCase(),
          )
        : undefined;
    if ((!bundledCss && !font) || source === "system") {
      diagnostics.push({
        kind: "font_substitution",
        resource,
        message:
          "This font uses the host font environment; portable fidelity cannot be guaranteed.",
      });
      continue;
    }
    try {
      let css: string;
      if (bundledCss) {
        css = bundledCss;
      } else {
        if (!font) throw new Error("Font metadata is unavailable.");
        const style = closestFontStyle(font, weight, italic);
        if (style.weight !== weight || style.italic !== italic) {
          diagnostics.push({
            kind: "font_substitution",
            resource,
            message: `Requested style is unavailable; the editor's closest style is ${style.weight}${style.italic ? " italic" : " normal"}.`,
          });
        }
        const url = googleFontUrl(font);
        let stylesheet = cached.get(url);
        if (!stylesheet) {
          stylesheet = (await fontResource(url, "fonts.googleapis.com", signal)).toString("utf8");
          if (cached.size >= 32) cached.delete(cached.keys().next().value!);
          cached.set(url, stylesheet);
        }
        css = fontCssForText(stylesheet, style.weight, style.italic, text);
        if (!css) throw new Error("No font subsets cover the requested text.");
        if (/<|@import|local\s*\(/i.test(css)) throw new Error("Unsupported font stylesheet.");
        for (const match of [...css.matchAll(/url\(([^)]+)\)/g)]) {
          const url = match[1].replace(/^['"]|['"]$/g, "");
          let data = cached.get(url);
          if (!data) {
            data = `data:font/woff2;base64,${(await fontResource(url, "fonts.gstatic.com", signal)).toString("base64")}`;
            if (cached.size >= 32) cached.delete(cached.keys().next().value!);
            cached.set(url, data);
          }
          css = css.replace(match[0], `url(${data})`);
        }
      }
      bytes += Buffer.byteLength(css);
      if (bytes > 8 * 1024 * 1024) throw new Error("Embedded preview fonts exceed 8 MB.");
      styles.add(css);
    } catch (error) {
      signal.throwIfAborted();
      diagnostics.push({
        kind: "missing_font",
        resource,
        message: error instanceof Error ? error.message : "Font embedding failed.",
      });
    }
  }
  return { css: [...styles].join("\n"), diagnostics, requests: [...requests.values()] };
}
