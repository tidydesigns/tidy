import * as z from "zod";
import { richTextPlain } from "./rich-text-runtime";

export {
  richTextPlain,
  textParagraphs,
  textFontSegments,
  normalizeRichText,
  replacePlainText,
} from "./rich-text-runtime";

export const textLinkSchema = z
  .string()
  .max(2000)
  .refine(
    (value) =>
      /^(https?:\/\/|mailto:|tel:|\/(?!\/)|#)/i.test(value) && !/[\u0000-\u0020]/.test(value),
    "Use an http(s), mailto, tel, root-relative or fragment URL.",
  );
export const textRunSchema = z
  .object({
    text: z.string().max(10000),
    bold: z.boolean().optional(),
    italic: z.boolean().optional(),
    underline: z.boolean().optional(),
    strike: z.boolean().optional(),
    href: textLinkSchema.optional(),
  })
  .strict();
export const richTextSchema = z
  .array(
    z
      .object({
        runs: z.array(textRunSchema).min(1).max(2000),
        list: z.enum(["bullet", "ordered"]).optional(),
      })
      .strict(),
  )
  .min(1)
  .max(1000)
  .superRefine((paragraphs, ctx) => {
    if (
      richTextPlain(paragraphs).length > 10000 ||
      paragraphs.reduce((n, p) => n + p.runs.length, 0) > 2000
    )
      ctx.addIssue({
        code: "custom",
        message: "Text supports at most 10,000 characters and 2,000 runs.",
      });
  });
export type TextRun = z.infer<typeof textRunSchema>;
export type RichText = z.infer<typeof richTextSchema>;
export type TextContent = { text: string; richText?: RichText };
