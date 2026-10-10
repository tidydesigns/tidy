import { test, expect } from "bun:test";
import {
  fontFamilies,
  closestFontStyle,
  webFonts,
  webFontByName,
  googleFontUrl,
  renderFontFamily,
} from "./catalog";
import { fontCssForText } from "./export-css";
import { buildDrawnNode, parseDesignDocument, blankDesignDocument } from "../document";
test("the bundled catalog includes the complete web library and valid variable/static styles", () => {
  expect(webFonts.length).toBeGreaterThan(1900);
  for (const font of webFonts) {
    expect(font.styles.length).toBeGreaterThan(0);
    expect(font.styles.every((style) => style.weight >= 1 && style.weight <= 1000)).toBe(true);
  }
  expect(webFontByName.get("instrument sans")!.weightRange).toEqual([400, 700]);
  expect(googleFontUrl(webFontByName.get("instrument sans")!)).toContain(
    "0%2C400..700%3B1%2C400..700",
  );
  expect(googleFontUrl(webFontByName.get("alatsi")!)).toContain("0%2C400");
});
test("font family lists preserve quoted commas and resolve the existing Instrument Sans alias", () => {
  expect(fontFamilies('"Family, With Comma", Arial, sans-serif')).toEqual([
    "Family, With Comma",
    "Arial",
    "sans-serif",
  ]);
  expect(fontFamilies("var(--font-instrument-sans)")).toEqual(["Instrument Sans"]);
  expect(renderFontFamily("var(--font-instrument-sans)")).toBe(
    '"Instrument Sans", var(--font-instrument-sans), system-ui',
  );
  expect(renderFontFamily("Missing Family", "Missing Face")).toBe(
    '"Missing Face", Missing Family, system-ui',
  );
  expect(renderFontFamily("Arial, serif")).toBe("Arial, serif");
  expect(renderFontFamily("Font 123")).toBe('"Font 123", system-ui');
  expect(renderFontFamily('"Family, With Comma", serif')).toBe('"Family, With Comma", serif');
});
test("changing families preserves italic when available and chooses the closest actual weight", () => {
  expect(closestFontStyle(webFontByName.get("abeezee")!, 700, true)).toMatchObject({
    weight: 400,
    italic: true,
  });
  expect(closestFontStyle(webFontByName.get("alatsi")!, 600, true)).toMatchObject({
    weight: 400,
    italic: false,
  });
  expect(closestFontStyle(webFontByName.get("instrument sans")!, 550, false)).toMatchObject({
    weight: 550,
    italic: false,
  });
});
test("export embeds only the used weight/style and script subset", () => {
  const face = (weight: string, style: string, range: string, url: string) =>
    `@font-face {font-family:'Example';font-weight:${weight};font-style:${style};unicode-range:${range};src:url(${url});}`;
  const latin = face("100 900", "normal", "U+0000-00FF", "latin.woff2"),
    cyrillic = face("100 900", "normal", "U+0400-04FF", "cyrillic.woff2"),
    italic = face("100 900", "italic", "U+0000-00FF", "italic.woff2");
  expect(fontCssForText(latin + cyrillic + italic, 550, false, "Hello")).toBe(latin);
  expect(fontCssForText(latin + cyrillic + italic, 550, false, "Hello Привет")).toBe(
    latin + "\n" + cyrillic,
  );
  expect(fontCssForText(face("400", "normal", "U+4??", "wildcard"), 400, false, "Я")).toContain(
    "wildcard",
  );
});
test("document weights support the full variable font range without changing older documents", () => {
  const node = buildDrawnNode("text", "text", null, { x: 0, y: 0, width: 100, height: 50 });
  for (const weight of [1, 350, 1000])
    expect(
      parseDesignDocument({
        ...blankDesignDocument(),
        nodes: [{ ...node, style: { fontWeight: weight } }],
      }).nodes[0].style.fontWeight,
    ).toBe(weight);
});
