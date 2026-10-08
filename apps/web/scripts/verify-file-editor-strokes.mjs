import assert from "node:assert/strict";
import { chromium } from "playwright";
import sharp from "sharp";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { buildDrawnNode } from "../lib/design/document";
import { nodeStyle } from "../lib/design/node-style";
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 650, height: 250 } });
  const base = buildDrawnNode("node", "container", null, { x: 50, y: 50, width: 100, height: 100 });
  const fixtures = ["inside", "center", "outside"].map((position, index) => ({
    ...base,
    id: position,
    box: { ...base.box, x: 50 + index * 180 },
    style: {
      borderWidth: 10,
      borderColor: "#ff0000",
      fill: "#0000ff",
      strokePosition: position,
      overflow: "hidden",
    },
  }));
  const html = fixtures
    .map((node) =>
      renderToStaticMarkup(
        createElement(
          "div",
          { id: node.id, style: nodeStyle(node, "absolute", {}) },
          createElement("div", {
            style: {
              position: "absolute",
              left: 0,
              top: 0,
              width: 200,
              height: 10,
              background: "#00ff00",
            },
          }),
        ),
      ),
    )
    .join("");
  await page.setContent(`<body style="margin:0;background:#ffffff">${html}</body>`);
  const { data, info } = await sharp(await page.screenshot())
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const pixel = (x, y) => [
    ...data.subarray((y * info.width + x) * 4, (y * info.width + x) * 4 + 4),
  ];
  for (const [index, position] of ["inside", "center", "outside"].entries()) {
    const x = 50 + index * 180,
      offset = index * 5;
    assert.deepEqual(pixel(x - offset + 2, 100), [255, 0, 0, 255], `${position} stroke`);
    assert.deepEqual(pixel(x - offset - 2, 100), [255, 255, 255, 255], `${position} exterior`);
    assert.deepEqual(pixel(x + 20, 100), [0, 0, 255, 255], `${position} fill`);
    assert.deepEqual(pixel(x + 20, 65), [0, 255, 0, 255], `${position} content position`);
    assert.deepEqual(pixel(x + 125, 65), [255, 255, 255, 255], `${position} clipped child`);
  }
  const exportedPixels = await page.evaluate(async (markup) => {
    const image = new Image();
    image.src = `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="650" height="250"><foreignObject width="100%" height="100%"><div xmlns="http://www.w3.org/1999/xhtml" style="position:relative;width:650px;height:250px;background:white">${markup}</div></foreignObject></svg>`)}`;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = 650;
    canvas.height = 250;
    const context = canvas.getContext("2d");
    context.drawImage(image, 0, 0);
    return [402, 430].map((x) => [...context.getImageData(x, 100, 1, 1).data]);
  }, html);
  assert.deepEqual(
    exportedPixels,
    [
      [255, 0, 0, 255],
      [0, 0, 255, 255],
    ],
    "self-contained foreignObject export",
  );
  assert.equal(await page.evaluate(() => CSS.supports("corner-shape", "superellipse(2)")), true);
  const corners = [0, 1].map((cornerSmoothing, index) => ({
    ...base,
    box: { ...base.box, x: 50 + index * 180 },
    style: { radius: 20, cornerSmoothing, fill: "#0000ff", overflow: "hidden" },
  }));
  await page.setContent(
    `<body style="margin:0;background:#ffffff">${corners.map((node) => renderToStaticMarkup(createElement("div", { style: nodeStyle(node, "absolute", {}) }))).join("")}</body>`,
  );
  const cornerImage = await sharp(await page.screenshot())
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const cornerPixel = (x, y) => [
    ...cornerImage.data.subarray(
      (y * cornerImage.info.width + x) * 4,
      (y * cornerImage.info.width + x) * 4 + 4,
    ),
  ];
  assert.deepEqual(cornerPixel(54, 54), [255, 255, 255, 255], "round corner");
  assert.deepEqual(cornerPixel(234, 54), [0, 0, 255, 255], "smoothed corner");
  const bundle = await Bun.build({
    entrypoints: [new URL("./fixtures/stroke-preview.tsx", import.meta.url).pathname],
    target: "browser",
    format: "iife",
  });
  assert.equal(bundle.success, true, String(bundle.logs));
  await page.setContent('<body style="margin:0;background:#ffffff"><div id="root"></div></body>');
  await page.addScriptTag({ content: await bundle.outputs[0].text() });
  await page.getByRole("button", { name: "Resize", exact: true }).click();
  await page.waitForFunction(() =>
    decodeURIComponent(
      getComputedStyle(document.getElementById("measured")).borderImageSource,
    ).includes('width="220"'),
  );
  const resized = await sharp(await page.screenshot())
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const resizedPixel = (x, y) => [
    ...resized.data.subarray(
      (y * resized.info.width + x) * 4,
      (y * resized.info.width + x) * 4 + 4,
    ),
  ];
  assert.deepEqual(resizedPixel(45, 100), [255, 0, 0, 255], "measured left stroke");
  assert.deepEqual(
    resizedPixel(55, 100),
    [0, 0, 255, 255],
    "resizing does not stretch stroke thickness",
  );
  assert.deepEqual(resizedPixel(255, 100), [255, 0, 0, 255], "measured right stroke");
  const importer = await Bun.build({
    entrypoints: [new URL("../lib/design/svg-path-import.ts", import.meta.url).pathname],
    target: "browser",
    format: "esm",
  });
  assert.equal(importer.success, true, String(importer.logs));
  const imported = await page.evaluate(
    async (source) => {
      const { importSvgPath } = await import(
        `data:application/javascript,${encodeURIComponent(source)}`
      );
      const svg =
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" fill="none" stroke="#f00" stroke-width="4"><path d="M20 50L80 50" stroke-linecap="round"/></svg>';
      return {
        good: importSvgPath(svg),
        complex: importSvgPath(
          svg.replace("<path", "<g><path").replace("/></svg>", "/></g></svg>"),
        ),
        styled: importSvgPath(svg.replace('stroke="#f00"', 'style="stroke:red"')),
        transformed: importSvgPath(svg.replace("<path", '<path transform="translate(10)"')),
        malformed: importSvgPath("<svg broken"),
        nonfinite: importSvgPath(svg.replace("M20", "M1e999")),
        mismatch: importSvgPath(svg.replace("viewBox=", 'width="100" height="50" viewBox=')),
      };
    },
    await importer.outputs[0].text(),
  );
  assert.equal(imported.good.vectorPath.d, "M20 50L80 50");
  assert.equal(imported.good.style.strokePaints[0].color, "#ff0000");
  assert.equal(imported.good.style.strokeCap, "round");
  for (const key of ["complex", "styled", "transformed", "malformed", "nonfinite", "mismatch"])
    assert.equal(imported[key], undefined, `${key} SVG retains its asset rendering`);
  console.log(
    "Stroke placement, clipped content, smoothing, measured resize, and SVG path import checks passed.",
  );
} finally {
  await browser.close();
}
