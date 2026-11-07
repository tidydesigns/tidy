/** Clip already escaped approval text without splitting an escape or a Unicode character. */
export function clipApprovalText(value: string, limit: number): string {
  if (value.length <= limit) return value;
  let end = 0;
  while (end < value.length) {
    const width =
      value[end] === "\\"
        ? value[end + 1] === "u"
          ? 6
          : 2
        : value.codePointAt(end)! > 0xffff
          ? 2
          : 1;
    if (end + width > limit) break;
    end += width;
  }
  return value.slice(0, end);
}

// Approval text describes the action itself. Preserve content and show controls literally.
export function approvalText(value: string, limit?: number): string {
  const escaped = value.replace(
    /[\\\u0000-\u0009\u000b-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g,
    (character) =>
      character === "\\" ? "\\\\" : `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
  return limit === undefined ? escaped : clipApprovalText(escaped, limit);
}
