/** Keep only styles and Unicode subsets needed by the exported text. */
export function fontCssForText(css: string, weight: number, italic: boolean, text: string) {
  return (css.match(/@font-face\s*\{[^}]*\}/g) ?? [])
    .filter((block) => {
      const style = /font-style:\s*([^;]+)/.exec(block)?.[1].trim() ?? "normal";
      if ((style === "italic") !== italic) return false;
      const bounds = /font-weight:\s*(\d+)(?:\s+(\d+))?/.exec(block);
      if (bounds && (weight < Number(bounds[1]) || weight > Number(bounds[2] ?? bounds[1])))
        return false;
      const ranges = /unicode-range:\s*([^;]+)/.exec(block)?.[1];
      if (!ranges) return true;
      return [...text].some((character) => {
        const code = character.codePointAt(0)!;
        return ranges.split(",").some((range) => {
          const values = range.trim().replace(/^U\+/i, "").split("-");
          const start = Number.parseInt(values[0].replace(/\?/g, "0"), 16),
            end = Number.parseInt((values[1] ?? values[0]).replace(/\?/g, "f"), 16);
          return code >= start && code <= end;
        });
      });
    })
    .join("\n");
}
