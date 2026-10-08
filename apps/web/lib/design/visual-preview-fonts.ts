import type { DesignDocument } from "@bella/design/document";
import { documentFontReferences } from "./fonts/recovery";
import { fontFamilies, genericFonts, webFontByName } from "./fonts/catalog";
import { fontCssForText } from "./fonts/export-css";
import { resolvedDocumentNodes } from "@bella/design/design-tokens";

export type PreviewFonts = { css: string; warnings: string[] };
export const VISUAL_PREVIEW_MAX_BYTES = 512_000;

async function boundedBytes(response: Response, signal: AbortSignal) {
  if (!response.ok || !response.body) throw new Error("Font resource unavailable.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > VISUAL_PREVIEW_MAX_BYTES) throw new Error("Font resource exceeds preview budget.");
      chunks.push(value);
    }
    return Buffer.concat(chunks);
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** Only catalogued Google fonts are fetched. No document URL is used as a fetch destination. */
export async function packagePreviewFonts(
  documents: DesignDocument[],
  fetcher: (input: string, init?: RequestInit) => Promise<Response> = fetch,
): Promise<PreviewFonts> {
  const warnings = new Set<string>(),
    css: string[] = [];
  const references = documents.flatMap((document) => [
    ...documentFontReferences({ ...document, nodes: resolvedDocumentNodes(document) }),
    ...document.nodes.flatMap((node) =>
      Object.keys(node.variants?.options ?? {}).flatMap((variant) =>
        documentFontReferences({
          ...document,
          nodes: resolvedDocumentNodes(document, new Map([[node.id, variant]])),
        }),
      ),
    ),
  ]);
  const groups = new Map<
    string,
    { family: string; weight: number; italic: boolean; text: string }
  >();
  for (const reference of references) {
    const family = fontFamilies(reference.style.fontFamily ?? "system-ui")[0] ?? "system-ui";
    if (genericFonts.has(family.toLowerCase())) continue;
    if (
      reference.style.fontSource === "local" ||
      reference.style.fontSource === "system" ||
      !webFontByName.has(family.toLowerCase())
    ) {
      warnings.add(
        `Font ${family} is device-dependent and cannot be embedded. A fallback may change text metrics.`,
      );
      continue;
    }
    const weight = reference.style.fontWeight ?? 400,
      italic = reference.style.fontStyle === "italic";
    const key = `${family}:${weight}:${italic}`;
    const group = groups.get(key) ?? { family, weight, italic, text: "" };
    group.text += reference.text;
    groups.set(key, group);
  }
  const deadline = AbortSignal.timeout(20_000);
  let size = 0;
  for (const group of groups.values()) {
    if (!group.text) continue;
    try {
      const signal = AbortSignal.any([deadline, AbortSignal.timeout(5_000)]);
      const params = new URLSearchParams({
        family: `${group.family}:ital,wght@${group.italic ? 1 : 0},${group.weight}`,
        display: "swap",
        text: [...new Set([...group.text])].join(""),
      });
      const response = await fetcher(`https://fonts.googleapis.com/css2?${params}`, {
        signal,
        redirect: "error",
        headers: { "User-Agent": "Mozilla/5.0" },
      });
      let faces = fontCssForText(
        (await boundedBytes(response, signal)).toString("utf8"),
        group.weight,
        group.italic,
        group.text,
      );
      const urls = [
        ...new Set(
          [...faces.matchAll(/url\(([^)]+)\)/g)].map((match) =>
            match[1].replace(/^["']|["']$/g, ""),
          ),
        ),
      ];
      if (!faces || !urls.length) throw new Error("Font face unavailable.");
      for (const url of urls) {
        const parsed = new URL(url);
        if (
          parsed.protocol !== "https:" ||
          parsed.hostname !== "fonts.gstatic.com" ||
          parsed.port ||
          parsed.username ||
          parsed.password
        )
          throw new Error("Unsupported font host.");
        const font = await boundedBytes(await fetcher(url, { signal, redirect: "error" }), signal);
        const data = `data:font/woff2;base64,${font.toString("base64")}`;
        faces = faces.replaceAll(url, data);
      }
      size += Buffer.byteLength(faces);
      if (size > VISUAL_PREVIEW_MAX_BYTES) throw new Error("Font resources exceed preview budget.");
      css.push(faces);
    } catch {
      warnings.add(
        `Font ${group.family} (${group.weight}${group.italic ? " italic" : ""}) could not be embedded. A fallback may change text metrics.`,
      );
    }
  }
  return { css: css.join("\n"), warnings: [...warnings] };
}
