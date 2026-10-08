import * as z from "zod";

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

export function richTextPlain(value: RichText): string {
  return value.map((paragraph) => paragraph.runs.map((run) => run.text).join("")).join("\n");
}
export function textParagraphs(node: TextContent): RichText {
  return node.richText ?? node.text.split("\n").map((text) => ({ runs: [{ text }] }));
}
/** Request/embed every face actually used by a rich text layer. */
export function textFontSegments(
  node: TextContent & {
    style: { fontWeight?: number; fontStyle?: "normal" | "italic"; fontFace?: string };
  },
) {
  return textParagraphs(node).flatMap((paragraph) =>
    paragraph.runs.map((run) => ({
      text: run.text,
      weight: run.bold === undefined ? (node.style.fontWeight ?? 400) : run.bold ? 700 : 400,
      italic: run.italic === undefined ? node.style.fontStyle === "italic" : run.italic,
      face: run.bold === undefined && run.italic === undefined ? node.style.fontFace : undefined,
    })),
  );
}
export function normalizeRichText(value: RichText): RichText {
  return value.map((paragraph) => {
    const runs: TextRun[] = [];
    for (const run of paragraph.runs) {
      const { text, ...marks } = run;
      const clean = Object.fromEntries(
        Object.entries(marks).filter(([, value]) => value !== undefined),
      );
      const prior = runs.at(-1);
      const { text: _text, ...previous } = prior ?? { text: "" };
      void _text;
      if (prior && JSON.stringify(previous) === JSON.stringify(clean)) prior.text += text;
      else if (text) runs.push({ text, ...clean });
    }
    return {
      ...(paragraph.list ? { list: paragraph.list } : {}),
      runs: runs.length ? runs : [{ text: "" }],
    };
  });
}

/** Plain-content edits retain untouched formatting and inherit marks at the insertion point. */
export function replacePlainText(node: TextContent, text: string): TextContent {
  if (!node.richText || text === node.text) return { text, richText: node.richText };
  let start = 0,
    suffix = 0;
  while (start < Math.min(text.length, node.text.length) && text[start] === node.text[start])
    start++;
  while (
    suffix < Math.min(text.length, node.text.length) - start &&
    text.at(-suffix - 1) === node.text.at(-suffix - 1)
  )
    suffix++;
  const chars: { char: string; marks: Omit<TextRun, "text">; list?: "bullet" | "ordered" }[] = [];
  for (const [index, paragraph] of node.richText.entries()) {
    if (index) chars.push({ char: "\n", marks: {}, list: paragraph.list });
    for (const { text, ...marks } of paragraph.runs)
      for (let i = 0; i < text.length; i++)
        chars.push({ char: text.charAt(i), marks, list: paragraph.list });
  }
  const inherited: { marks: Omit<TextRun, "text">; list?: "bullet" | "ordered" } = (start <
  node.text.length - suffix
    ? chars[start]
    : chars[start - 1]) ??
    chars[start] ?? { marks: {} };
  const inserted = text
    .slice(start, text.length - suffix)
    .split("")
    .map((char) => ({ ...inherited, char }));
  const result = [...chars.slice(0, start), ...inserted, ...chars.slice(chars.length - suffix)];
  const paragraphs: RichText = [{ runs: [], list: result[0]?.list ?? node.richText[0]?.list }];
  for (const item of result) {
    if (item.char === "\n") paragraphs.push({ runs: [], list: item.list });
    else paragraphs.at(-1)!.runs.push({ text: item.char, ...item.marks });
  }
  return { text, richText: normalizeRichText(paragraphs) };
}
