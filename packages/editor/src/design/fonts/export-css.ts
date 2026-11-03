const fontFaceOpeningPattern = /@font-face\s*\{/g;
const fontStylePattern = /font-style:\s*([^;]+)/;
const fontWeightPattern = /font-weight:\s*(\d+)(?:\s+(\d+))?/;
const unicodeRangePattern = /unicode-range:\s*([^;]+)/;
const unicodePrefixPattern = /^U\+/i;
const unicodeWildcardPattern = /\?/g;
/** Keep only styles and Unicode subsets needed by the exported text. */
export function fontCssForText(css: string, weight: number, italic: boolean, text: string) {
  const blocks: string[] = [];
  fontFaceOpeningPattern.lastIndex = 0;
  const opening = fontFaceOpeningPattern;
  let match: RegExpExecArray | null;
  // Move past each block once. An unterminated block must not rescan its remaining
  // contents for every nested @font-face prefix.
  while ((match = opening.exec(css))) {
    const end = css.indexOf("}", opening.lastIndex);
    if (end === -1) break;
    blocks.push(css.slice(match.index, end + 1));
    opening.lastIndex = end + 1;
  }
  return blocks
    .filter((block) => {
      const style = fontStylePattern.exec(block)?.[1].trim() ?? "normal";
      if ((style === "italic") !== italic) return false;
      const bounds = fontWeightPattern.exec(block);
      if (bounds && (weight < Number(bounds[1]) || weight > Number(bounds[2] ?? bounds[1])))
        return false;
      const ranges = unicodeRangePattern.exec(block)?.[1];
      if (!ranges) return true;
      return [...text].some((character) => {
        const code = character.codePointAt(0)!;
        return ranges.split(",").some((range) => {
          const values = range.trim().replace(unicodePrefixPattern, "").split("-");
          const start = Number.parseInt(values[0].replace(unicodeWildcardPattern, "0"), 16),
            end = Number.parseInt(
              (values[1] ?? values[0]).replace(unicodeWildcardPattern, "f"),
              16,
            );
          return code >= start && code <= end;
        });
      });
    })
    .join("\n");
}
