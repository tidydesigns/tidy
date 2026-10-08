import { writeFile } from "node:fs/promises";
const source = "https://fonts.google.com/metadata/fonts";
const response = await fetch(source);
if (!response.ok) throw new Error("Could not read the font catalog.");
const text = await response.text(),
  catalog = JSON.parse(text.slice(text.indexOf("{")));
const fonts = catalog.familyMetadataList
  .filter((font) => font.isOpenSource && font.family.length <= 100)
  .map((font) => {
    const weight = font.axes.find((axis) => axis.tag === "wght");
    return {
      family: font.family,
      category: font.category,
      styles: Object.keys(font.fonts)
        .map((value) => [Number(value.replace(/i$/, "")), Number(value.endsWith("i"))])
        .filter(([weight]) => weight >= 1 && weight <= 1000),
      ...(weight ? { weightRange: [weight.min, weight.max] } : {}),
      sample: font.subsets.includes("latin")
        ? "Aa"
        : ({ Arab: "أبجد", Deva: "नमस्ते", Hani: "你好", Hang: "안녕", Hebr: "שלום", Thai: "สวัสดี" }[
            font.primaryScript
          ] ?? "Aa"),
    };
  })
  .filter((font) => font.styles.length);
if (fonts.length < 1000) throw new Error("The font catalog is unexpectedly incomplete.");
await writeFile(
  new URL("../lib/design/fonts/catalog.json", import.meta.url),
  JSON.stringify({ source, updatedAt: new Date().toISOString().slice(0, 10), fonts }) + "\n",
);
console.log(`Updated ${fonts.length} font families.`);
