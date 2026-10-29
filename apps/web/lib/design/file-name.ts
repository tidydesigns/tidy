const adjectives = ["Bright", "Quiet", "Fresh", "Golden", "Little", "Open", "Soft", "Sunny"];
const nouns = ["canvas", "dolphin", "garden", "horizon", "studio", "sparrow", "meadow", "orbit"];

/** A UUID supplies the same random name to the prefetched draft and its insert. */
export function designFileName(id: string) {
  return `${adjectives[parseInt(id.slice(0, 2), 16) % adjectives.length]} ${nouns[parseInt(id.slice(2, 4), 16) % nouns.length]}`;
}
