export function searchScore(title: string, keywords: string, query: string): number {
  const fold = (value: string) =>
    value.normalize("NFKD").replace(/\p{M}/gu, "").toLocaleLowerCase();
  const needle = fold(query.trim());
  if (!needle) return 0;
  const name = fold(title);
  if (name === needle) return 4;
  if (name.startsWith(needle)) return 3;
  if (name.includes(needle)) return 2;
  const words = fold(`${title} ${keywords}`);
  return needle.split(/\s+/).every((word) => words.includes(word)) ? 1 : -1;
}
