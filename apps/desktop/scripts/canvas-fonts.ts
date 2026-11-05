import { readFile } from "node:fs/promises";

export async function bundledCanvasFontCss() {
  const fonts = [
    { family: "Instrument Sans", file: "instrument-sans-latin.woff2", weight: "400 700" },
    { family: "Instrument Serif", file: "InstrumentSerif-Regular.woff2", weight: "400" },
  ];
  return Object.fromEntries(
    await Promise.all(
      fonts.map(async (font) => [
        font.family,
        `@font-face{font-family:${JSON.stringify(font.family)};font-style:normal;font-weight:${font.weight};src:url(data:font/woff2;base64,${(await readFile(new URL(`../../../packages/ui/fonts/${font.file}`, import.meta.url))).toString("base64")}) format("woff2");}`,
      ]),
    ),
  );
}
