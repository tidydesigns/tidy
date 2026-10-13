import type { FigNode } from "openfig-core";
import { normalizeRichText, type RichText, type TextRun } from "./rich-text";

export function figmaFontWeight(face = "Regular") {
  if (/black|heavy/i.test(face)) return 900;
  if (/extra.?bold|ultra.?bold/i.test(face)) return 800;
  if (/semi.?bold|demi.?bold/i.test(face)) return 600;
  if (/bold/i.test(face)) return 700;
  if (/medium/i.test(face)) return 500;
  if (/extra.?light|ultra.?light/i.test(face)) return 200;
  if (/light/i.test(face)) return 300;
  if (/thin|hairline/i.test(face)) return 100;
  return 400;
}

type Override = {
  styleID: number;
  fontName?: { family?: string; style?: string };
  textDecoration?: string;
  [key: string]: unknown;
};
/** Native Kiwi style IDs address UTF-16 characters, including both halves of emoji.
 * Keep supported marks editable; flag range properties the text model cannot express. */
export function figmaRichText(node: FigNode) {
  const data = node.textData as
    | { characters: string; characterStyleIDs?: number[]; styleOverrideTable?: Override[] }
    | undefined;
  if (!data?.characterStyleIDs?.some((id) => id !== 0)) return {};
  const styles = new Map((data.styleOverrideTable ?? []).map((value) => [value.styleID, value]));
  const paragraphs: RichText = [{ runs: [] }];
  let unsupported = false;
  const ignored = new Set(["styleID", "isOverrideOverTextStyle", "styleIdForText"]);
  for (let offset = 0; offset < data.characters.length;) {
    const id = data.characterStyleIDs[offset] ?? 0;
    let end = offset + 1;
    while (end < data.characters.length && (data.characterStyleIDs[end] ?? 0) === id) end++;
    // Never introduce a run boundary inside a surrogate pair.
    if (
      end < data.characters.length &&
      /[\uD800-\uDBFF]/.test(data.characters[end - 1]) &&
      /[\uDC00-\uDFFF]/.test(data.characters[end])
    )
      end++;
    const override = styles.get(id);
    const marks: Omit<TextRun, "text"> = {};
    if (id && !override) unsupported = true;
    if (override) {
      if (override.fontName) {
        const face = override.fontName.style ?? node.fontName?.style ?? "Regular";
        const weight = figmaFontWeight(face);
        if (face !== node.fontName?.style) {
          marks.italic = /italic|oblique/i.test(face);
          if (weight === 400 || weight === 700) marks.bold = weight === 700;
          else if (weight !== figmaFontWeight(node.fontName?.style)) unsupported = true;
        }
        if (override.fontName.family && override.fontName.family !== node.fontName?.family)
          unsupported = true;
      }
      if (override.textDecoration !== undefined) {
        marks.underline = override.textDecoration === "UNDERLINE";
        marks.strike = override.textDecoration === "STRIKETHROUGH";
      }
      for (const [key, value] of Object.entries(override)) {
        if (ignored.has(key) || key === "fontName" || key === "textDecoration") continue;
        if (JSON.stringify(value) !== JSON.stringify(node[key])) unsupported = true;
      }
    }
    const parts = data.characters.slice(offset, end).split("\n");
    for (const [index, text] of parts.entries()) {
      if (index) paragraphs.push({ runs: [] });
      const runs = paragraphs.at(-1)!.runs;
      const prior = runs.at(-1);
      if (
        prior &&
        JSON.stringify({ ...prior, text: "" }) === JSON.stringify({ ...marks, text: "" })
      )
        prior.text += text;
      else runs.push({ text, ...marks });
    }
    offset = end;
  }
  const richText = normalizeRichText(paragraphs);
  if (richText.length > 1000 || richText.reduce((n, p) => n + p.runs.length, 0) > 2000)
    return { unsupported: true };
  return { richText, unsupported };
}
