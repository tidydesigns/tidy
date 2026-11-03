const ampersandPattern = /&/g;
const lessThanPattern = /</g;
const greaterThanPattern = />/g;
const doubleQuotePattern = /"/g;
/** Escape one XML text or double-quoted attribute value, never a markup fragment. */
export function xml(value: string | number) {
  return String(value)
    .replace(ampersandPattern, "&amp;")
    .replace(lessThanPattern, "&lt;")
    .replace(greaterThanPattern, "&gt;")
    .replace(doubleQuotePattern, "&quot;");
}
