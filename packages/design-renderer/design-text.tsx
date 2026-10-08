import type { CSSProperties, ReactNode } from "react";
import type { DesignNode } from "@bella/design/document";
import { renderFontFamily } from "./font-family";
import { textParagraphs, type TextRun } from "@bella/design/rich-text";

function Run({
  run,
  node,
  interactiveLinks,
}: {
  run: TextRun;
  node: DesignNode;
  interactiveLinks: boolean;
}) {
  const style: CSSProperties = {
    ...(node.style.fontFace && (run.bold !== undefined || run.italic !== undefined)
      ? { fontFamily: renderFontFamily(node.style.fontFamily) }
      : {}),
    ...(run.bold !== undefined ? { fontWeight: run.bold ? 700 : 400 } : {}),
    ...(run.italic !== undefined ? { fontStyle: run.italic ? "italic" : "normal" } : {}),
    ...(node.richText || run.underline !== undefined || run.strike !== undefined
      ? {
          textDecoration:
            [
              (run.underline ?? (node.richText && node.style.textDecoration === "underline")) &&
                "underline",
              (run.strike ?? (node.richText && node.style.textDecoration === "line-through")) &&
                "line-through",
            ]
              .filter(Boolean)
              .join(" ") || "none",
        }
      : {}),
  };
  return run.href ? (
    <a
      href={run.href}
      style={{ color: "inherit", ...style }}
      onClick={interactiveLinks ? undefined : (event) => event.preventDefault()}
    >
      {run.text}
    </a>
  ) : (
    <span style={style}>{run.text}</span>
  );
}

/** Canvas, review, thumbnails and exports share runs, list numbering and paragraph geometry. */
export function DesignText({
  node,
  interactiveLinks = true,
}: {
  node: DesignNode;
  interactiveLinks?: boolean;
}) {
  const paragraphs = textParagraphs({ text: node.text ?? "", richText: node.richText });
  const spacing = node.style.paragraphSpacing ?? 0;
  const style: CSSProperties = {
    display: "block",
    minWidth: 0,
    width: "100%",
    flex: "0 0 auto",
    whiteSpace: "inherit",
    overflowWrap: "break-word",
    ...(node.style.maxLines
      ? {
          display: "-webkit-box",
          WebkitBoxOrient: "vertical",
          WebkitLineClamp: node.style.maxLines,
          overflow: "hidden",
        }
      : {}),
  };
  const ellipsis = node.style.textWrap === "nowrap" && node.style.textOverflow === "ellipsis";
  const children: ReactNode[] = [];
  let items: ReactNode[] = [],
    list: "bullet" | "ordered" | undefined;
  function flush() {
    if (items.length)
      children.push(
        list === "bullet" ? (
          <ul key={children.length} style={{ margin: 0, paddingLeft: "1.5em" }}>
            {items}
          </ul>
        ) : (
          <ol key={children.length} style={{ margin: 0, paddingLeft: "1.5em" }}>
            {items}
          </ol>
        ),
      );
    items = [];
  }
  for (const [index, paragraph] of paragraphs.entries()) {
    const content = paragraph.runs.some((run) => run.text) ? (
      paragraph.runs.map((run, i) => (
        <Run key={i} run={run} node={node} interactiveLinks={interactiveLinks} />
      ))
    ) : (
      <br />
    );
    const paragraphStyle: CSSProperties = {
      marginTop: index ? spacing : 0,
      ...(ellipsis ? { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } : {}),
    };
    if (paragraph.list !== list) flush();
    list = paragraph.list;
    if (list)
      items.push(
        <li key={index} data-text-paragraph style={paragraphStyle}>
          {content}
        </li>,
      );
    else
      children.push(
        <span
          key={`p-${index}`}
          data-text-paragraph
          style={{ display: "block", ...paragraphStyle }}
        >
          {content}
        </span>,
      );
  }
  flush();
  return (
    <span data-design-text style={style}>
      {children}
    </span>
  );
}
