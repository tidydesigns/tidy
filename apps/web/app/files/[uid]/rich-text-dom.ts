import {
  normalizeRichText,
  richTextPlain,
  textLinkSchema,
  type RichText,
  type TextRun,
} from "@bella/design/rich-text";

const ignored = new Set([
  "SCRIPT",
  "STYLE",
  "IFRAME",
  "OBJECT",
  "SVG",
  "IMG",
  "VIDEO",
  "AUDIO",
  "TEMPLATE",
]);
type Marks = Omit<TextRun, "text">;
const blocks = new Set(["DIV", "P", "LI", "H1", "H2", "H3", "BLOCKQUOTE", "PRE", "UL", "OL"]);
const isBlock = (element: Element) =>
  blocks.has(element.tagName) || element.hasAttribute("data-text-paragraph");
function marksFor(element: Element, inherited: Marks): Marks {
  const marks = { ...inherited };
  const tag = element.tagName;
  const style = element instanceof HTMLElement ? element.style : undefined;
  if (["B", "STRONG"].includes(tag)) marks.bold = true;
  if (["I", "EM"].includes(tag)) marks.italic = true;
  if (tag === "U") marks.underline = true;
  if (["S", "STRIKE", "DEL"].includes(tag)) marks.strike = true;
  if (style?.fontWeight)
    marks.bold = style.fontWeight === "bold" || Number(style.fontWeight) >= 600;
  if (style?.fontStyle) marks.italic = style.fontStyle === "italic";
  const decoration = style?.textDecorationLine || style?.textDecoration;
  if (decoration) {
    marks.underline = decoration.includes("underline");
    marks.strike = decoration.includes("line-through");
  }
  const href = element.getAttribute("href");
  if (tag === "A" && href && textLinkSchema.safeParse(href).success) marks.href = href;
  return marks;
}

/** Only authored text and supported formatting enter the document; pasted markup never executes. */
export function readEditableRichText(root: Node): { text: string; richText: RichText } {
  const paragraphs: RichText = [];
  let current: RichText[number] | undefined;
  function flush() {
    if (current) paragraphs.push(current);
    current = undefined;
  }
  function visit(node: Node, marks: Marks = {}, list?: "bullet" | "ordered") {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent?.replaceAll("\u00a0", " ") ?? "";
      if (
        !text.trim() &&
        node.parentElement &&
        Array.from(node.parentElement.children).some(isBlock)
      )
        return;
      if (text) {
        current ??= { runs: [], ...(list ? { list } : {}) };
        current.runs.push({ text, ...marks });
      }
      return;
    }
    if (!(node instanceof Element) || ignored.has(node.tagName.toUpperCase())) return;
    const next = marksFor(node, marks);
    if (node.tagName === "UL" || node.tagName === "OL") {
      flush();
      for (const child of node.childNodes)
        visit(child, next, node.tagName === "UL" ? "bullet" : "ordered");
      flush();
      return;
    }
    const block = isBlock(node);
    if (block) {
      flush();
      // Browsers wrap inserted block fragments in the existing paragraph. The wrapper is not an extra empty line.
      if (!Array.from(node.children).some(isBlock))
        current = { runs: [], ...(list ? { list } : {}) };
    }
    if (node.tagName === "BR") {
      // A sole/trailing placeholder BR represents an empty paragraph, not an extra line.
      if (node.parentNode?.childNodes.length !== 1 && node.nextSibling) {
        current ??= { runs: [] };
        flush();
        current = { runs: [], ...(list ? { list } : {}) };
      } else current ??= { runs: [], ...(list ? { list } : {}) };
    } else for (const child of node.childNodes) visit(child, next, list);
    if (block) flush();
  }
  const base: Marks = {};
  if (root instanceof HTMLElement && root.hasAttribute("data-rich-text-editor")) {
    // Native editing may remove spans that match the layer's inherited font. Capture their effective emphasis.
    const computed = getComputedStyle(root);
    base.bold = Number(computed.fontWeight) >= 600 || computed.fontWeight === "bold";
    base.italic = computed.fontStyle === "italic";
    base.underline = computed.textDecorationLine.includes("underline");
    base.strike = computed.textDecorationLine.includes("line-through");
  }
  for (const child of root.childNodes) visit(child, base);
  flush();
  const richText = normalizeRichText(paragraphs.length ? paragraphs : [{ runs: [{ text: "" }] }]);
  return { text: richTextPlain(richText), richText };
}

export function richTextElements(value: RichText, spacing = 0, fontFamily?: string): HTMLElement[] {
  const roots: HTMLElement[] = [];
  let group: HTMLElement | undefined, kind: "bullet" | "ordered" | undefined;
  for (const [index, paragraph] of value.entries()) {
    if (paragraph.list && kind !== paragraph.list) {
      group = document.createElement(paragraph.list === "bullet" ? "ul" : "ol");
      group.style.margin = "0";
      group.style.paddingLeft = "1.5em";
      roots.push(group);
    }
    const element = document.createElement(paragraph.list ? "li" : "div");
    element.dataset.textParagraph = "";
    element.style.marginTop = index ? `${spacing}px` : "0px";
    for (const run of paragraph.runs) {
      const span = document.createElement(run.href ? "a" : "span");
      if (run.href) span.setAttribute("href", run.href);
      if (fontFamily && (run.bold !== undefined || run.italic !== undefined))
        span.style.fontFamily = fontFamily;
      if (run.bold !== undefined) span.style.fontWeight = run.bold ? "700" : "400";
      if (run.italic !== undefined) span.style.fontStyle = run.italic ? "italic" : "normal";
      if (run.underline !== undefined || run.strike !== undefined)
        span.style.textDecoration =
          [run.underline && "underline", run.strike && "line-through"].filter(Boolean).join(" ") ||
          "none";
      span.textContent = run.text;
      element.appendChild(span);
    }
    if (!paragraph.runs.some((run) => run.text))
      element.replaceChildren(document.createElement("br"));
    if (paragraph.list) group!.appendChild(element);
    else {
      roots.push(element);
      group = undefined;
    }
    kind = paragraph.list;
  }
  return roots;
}

export function sanitizeRichPaste(html: string, plain: string): string {
  const template = document.createElement("template");
  template.innerHTML = html;
  const value = html
    ? readEditableRichText(template.content).richText
    : plain
        .replace(/\r\n?/g, "\n")
        .split("\n")
        .map((text) => ({ runs: [{ text }] }));
  const holder = document.createElement("div");
  // Explicit normal marks protect pasted runs from destination-layer emphasis.
  const explicit = html
    ? value.map((paragraph) => ({
        ...paragraph,
        runs: paragraph.runs.map((run) => ({
          bold: false,
          italic: false,
          underline: false,
          strike: false,
          ...run,
        })),
      }))
    : value;
  for (const element of richTextElements(explicit)) holder.appendChild(element);
  return holder.innerHTML;
}
