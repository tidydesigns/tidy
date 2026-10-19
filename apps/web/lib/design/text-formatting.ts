import {
  textLinkSchema,
  textParagraphs,
  type TextContent,
  type TextRun,
} from "@tidy/design/rich-text";
import type { DesignNode } from "./document";

export type TextCommand =
  | "bold"
  | "italic"
  | "underline"
  | "strikeThrough"
  | "insertUnorderedList"
  | "insertOrderedList"
  | "createLink"
  | "unlink";
export type TextFormatting = {
  marks: Record<TextCommand, boolean | "mixed">;
  href: string;
};
type TextNode = Pick<DesignNode, "text" | "richText" | "style">;

function sharedMark(values: boolean[]): boolean | "mixed" {
  return values.every(Boolean) ? true : values.some(Boolean) ? "mixed" : false;
}

export function nodeTextFormatting(node: TextNode): TextFormatting {
  const paragraphs = textParagraphs({
    text: node.text ?? "",
    richText: node.richText,
  });
  const runs = paragraphs.flatMap((paragraph) => paragraph.runs);
  const href = runs[0]?.href ?? "";
  return {
    marks: {
      bold: sharedMark(runs.map((run) => run.bold ?? (node.style.fontWeight ?? 400) >= 600)),
      italic: sharedMark(runs.map((run) => run.italic ?? node.style.fontStyle === "italic")),
      underline: sharedMark(
        runs.map((run) => run.underline ?? node.style.textDecoration === "underline"),
      ),
      strikeThrough: sharedMark(
        runs.map((run) => run.strike ?? node.style.textDecoration === "line-through"),
      ),
      insertUnorderedList: sharedMark(paragraphs.map((paragraph) => paragraph.list === "bullet")),
      insertOrderedList: sharedMark(paragraphs.map((paragraph) => paragraph.list === "ordered")),
      createLink: sharedMark(runs.map((run) => Boolean(run.href))),
      unlink: sharedMark(runs.map((run) => Boolean(run.href))),
    },
    href: runs.every((run) => run.href === href) ? href : "",
  };
}

export function formatNodeText({
  node,
  command,
  value,
}: {
  node: TextNode;
  command: TextCommand;
  value?: string;
}): TextContent {
  const content = { text: node.text ?? "", richText: node.richText };
  const paragraphs = textParagraphs(content);
  const enabled = nodeTextFormatting(node).marks[command] !== true;
  if (command === "insertUnorderedList" || command === "insertOrderedList") {
    return {
      ...content,
      richText: paragraphs.map((paragraph) => ({
        ...paragraph,
        list: enabled ? (command === "insertUnorderedList" ? "bullet" : "ordered") : undefined,
      })),
    };
  }
  const inlineCommand = command;
  const link = inlineCommand === "createLink" ? textLinkSchema.safeParse(value) : null;
  if (link && !link.success) return content;
  function formatRun(run: TextRun): TextRun {
    switch (inlineCommand) {
      case "bold":
        return { ...run, bold: enabled };
      case "italic":
        return { ...run, italic: enabled };
      case "underline":
        return { ...run, underline: enabled };
      case "strikeThrough":
        return { ...run, strike: enabled };
      case "createLink":
        return link?.success ? { ...run, href: link.data } : run;
      case "unlink":
        return { ...run, href: undefined };
      default: {
        const exhaustive: never = inlineCommand;
        return exhaustive;
      }
    }
  }
  return {
    ...content,
    richText: paragraphs.map((paragraph) => ({
      ...paragraph,
      runs: paragraph.runs.map(formatRun),
    })),
  };
}
