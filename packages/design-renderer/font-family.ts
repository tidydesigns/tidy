export const genericFonts = new Set([
  "system-ui",
  "sans-serif",
  "serif",
  "monospace",
  "cursive",
  "fantasy",
  "ui-serif",
  "ui-sans-serif",
  "ui-monospace",
  "ui-rounded",
  "emoji",
  "math",
  "fangsong",
]);
export function fontFamilies(value: string): string[] {
  if (value === "var(--font-instrument-sans)") return ["Instrument Sans"];
  if (value === "var(--font-instrument-serif)") return ["Instrument Serif"];
  return (value.match(/(?:"[^"]*"|'[^']*'|[^,])+/g) ?? [])
    .map((family) => family.trim().replace(/^(['"])(.*)\1$/, "$2"))
    .filter(Boolean);
}

export function renderFontFamily(value?: string, face?: string) {
  if (!value) return face ? JSON.stringify(face) : undefined;
  const family =
    value === "var(--font-instrument-sans)"
      ? '"Instrument Sans", var(--font-instrument-sans)'
      : value === "var(--font-instrument-serif)"
        ? '"Instrument Serif", var(--font-instrument-serif)'
        : fontFamilies(value)
            .map((name) =>
              /^[a-zA-Z_-][a-zA-Z0-9_-]*(?:\s+[a-zA-Z_-][a-zA-Z0-9_-]*)*$/.test(name)
                ? name
                : JSON.stringify(name),
            )
            .join(", ");
  const fallback = fontFamilies(family).some((family) => genericFonts.has(family.toLowerCase()))
    ? family
    : `${family}, system-ui`;
  return face ? `${JSON.stringify(face)}, ${fallback}` : fallback;
}
