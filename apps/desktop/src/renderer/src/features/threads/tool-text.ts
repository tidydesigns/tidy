export function toolTextPreview(text: string): string {
  return text.slice(0, 480).split("\n", 4).join("\n");
}
