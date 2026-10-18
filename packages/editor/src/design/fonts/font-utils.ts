export type FontStyle = { weight: number; italic: boolean; label: string; face?: string };
export type FontFamily = {
  family: string;
  category: string;
  styles: FontStyle[];
  weightRange?: number[];
  metadataReady?: boolean;
  sample?: string;
  source: "web" | "system" | "local";
};
const weights: Record<number, string> = {
  100: "Thin",
  200: "Extra light",
  300: "Light",
  400: "Regular",
  500: "Medium",
  600: "Semibold",
  700: "Bold",
  800: "Extra bold",
  900: "Black",
  1000: "Extra black",
};
export const fontStyleLabel = (weight: number, italic: boolean) =>
  `${weights[weight] ?? weight}${italic ? " Italic" : ""}`;
export const systemFonts: FontFamily[] = [
  "system-ui",
  "Arial",
  "Helvetica",
  "Verdana",
  "Georgia",
  "Times New Roman",
  "Courier New",
  "monospace",
  "serif",
  "sans-serif",
].map((family) => ({
  family,
  category: "System",
  source: "system",
  styles: [400, 700].flatMap((weight) =>
    [false, true].map((italic) => ({ weight, italic, label: fontStyleLabel(weight, italic) })),
  ),
}));
export { genericFonts, fontFamilies, renderFontFamily } from "./family";
export function closestFontStyle(font: FontFamily, weight: number, italic: boolean) {
  const closest = [...font.styles].sort(
    (a, b) =>
      (a.italic === italic ? 0 : 2000) +
      Math.abs(a.weight - weight) -
      ((b.italic === italic ? 0 : 2000) + Math.abs(b.weight - weight)),
  )[0];
  if (!font.weightRange) return closest;
  const actual = Math.max(font.weightRange[0], Math.min(font.weightRange[1], weight));
  return { ...closest, weight: actual, label: fontStyleLabel(actual, closest.italic) };
}
export function googleFontUrl(font: FontFamily) {
  if (font.source !== "web") throw new Error("Choose a web font to load.");
  const styles = [...new Set(font.styles.map((style) => (style.italic ? 1 : 0)))].sort();
  const variants = font.weightRange
    ? styles.map((italic) => `${italic},${font.weightRange![0]}..${font.weightRange![1]}`)
    : font.styles
        .map((style) => `${style.italic ? 1 : 0},${style.weight}`)
        .sort(
          (a, b) =>
            Number(a.split(",")[0]) - Number(b.split(",")[0]) ||
            Number(a.split(",")[1]) - Number(b.split(",")[1]),
        );
  const params = new URLSearchParams({
    family: `${font.family}:ital,wght@${variants.join(";")}`,
    display: "swap",
  });
  return `https://fonts.googleapis.com/css2?${params}`;
}
