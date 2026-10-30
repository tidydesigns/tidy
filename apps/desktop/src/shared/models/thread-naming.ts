/** Attachment tokens describe placement, not the intent of the request. */
export function threadPromptText(prompt: string) {
  return prompt
    .replace(/\[\[attachment:[0-9a-f-]{36}\]\]/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function promptThreadTitle(prompt: string) {
  return threadPromptText(prompt).slice(0, 80) || "New thread";
}
