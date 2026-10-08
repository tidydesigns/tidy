import catalog from "./catalog.json";
import { fontStyleLabel, type FontFamily } from "./font-utils";
export * from "./font-utils";
export const webFonts: FontFamily[] = catalog.fonts.map((font) => ({
  ...font,
  source: "web",
  styles: font.styles.map(([weight, italic]) => ({
    weight,
    italic: Boolean(italic),
    label: fontStyleLabel(weight, Boolean(italic)),
  })),
}));
export const webFontByName = new Map(webFonts.map((font) => [font.family.toLowerCase(), font]));
