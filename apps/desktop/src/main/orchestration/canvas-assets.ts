import { z } from "zod";
import { inspectSvgElements, type SvgElementData } from "@tidy/editor/design/svg-path-import";

export const CANVAS_ASSET_INPUT_LIMITS = {
  inline_image_encoded_bytes: 900000,
  inline_svg_characters: 340 * 1024,
  inline_svg_encoded_bytes: 900000,
} as const;

export const canvasImportAssetSchema = z
  .object({
    design_id: z.uuid(),
    expected_version: z.string().min(1).max(256),
    source: z.discriminatedUnion("kind", [
      z
        .object({
          kind: z.literal("inline_image"),
          data_url: z
            .string()
            .max(CANVAS_ASSET_INPUT_LIMITS.inline_image_encoded_bytes)
            .regex(/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/),
        })
        .strict(),
      z
        .object({ kind: z.literal("project_relative_path"), path: z.string().min(1).max(500) })
        .strict(),
      z
        .object({
          kind: z.literal("inline_svg"),
          svg: z
            .string()
            .min(1)
            .max(CANVAS_ASSET_INPUT_LIMITS.inline_svg_characters)
            .refine(
              (svg) =>
                Buffer.byteLength(JSON.stringify(svg)) <=
                CANVAS_ASSET_INPUT_LIMITS.inline_svg_encoded_bytes,
              "Encoded SVG exceeds the request budget.",
            ),
        })
        .strict(),
    ]),
  })
  .strict();

export function validateSvgElements(root: SvgElementData) {
  const forbidden = new Set([
    "script",
    "foreignobject",
    "iframe",
    "object",
    "embed",
    "audio",
    "video",
    "set",
  ]);
  const css = (value: string) => {
    if (
      /[\\@<>]/.test(value) ||
      [...value.matchAll(/url\s*\(\s*([^)]*)\)/gi)].some(
        (match) => !/^(['"]?)#[^'"\s()]+\1$/.test(match[1].trim()),
      )
    )
      throw new Error("SVG styles must be static and self-contained.");
  };
  const visit = (element: SvgElementData) => {
    const name = element.name.toLowerCase();
    if (forbidden.has(name) || name.startsWith("animate") || name === "style")
      throw new Error(
        "SVG scripts, style elements, animation and embedded documents are unsupported.",
      );
    for (const [name, value] of Object.entries(element.attributes)) {
      if (/^on/i.test(name) || /^(?:xml:base|src)$/i.test(name))
        throw new Error("SVG event handlers and external resources are unsupported.");
      if (/^(?:href|xlink:href)$/i.test(name) && !value.startsWith("#"))
        throw new Error("SVG references must remain inside the artwork.");
      if (
        [
          "style",
          "fill",
          "stroke",
          "filter",
          "clip-path",
          "mask",
          "cursor",
          "marker-start",
          "marker-mid",
          "marker-end",
        ].includes(name) ||
        /url\s*\(/i.test(value)
      )
        css(value);
    }
    element.children.forEach(visit);
  };
  visit(root);
  return inspectSvgElements(root);
}
