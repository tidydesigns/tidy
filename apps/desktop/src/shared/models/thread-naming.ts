/** Attachment tokens describe placement, not the intent of the request. */
export function threadPromptText(prompt: string) {
  return prompt
    .replace(/\[\[attachment:[0-9a-f-]{36}\]\]/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const titleSegments = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export function promptThreadTitle(prompt: string) {
  const text = threadPromptText(prompt);
  if (text.length <= 80) return text || "New thread";
  let end = 0;
  for (const { index, segment } of titleSegments.segment(text)) {
    const next = index + segment.length;
    if (next > 80) break;
    end = next;
  }
  return text.slice(0, end).trimEnd() || "New thread";
}
