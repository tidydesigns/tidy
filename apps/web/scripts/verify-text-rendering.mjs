import assert from "node:assert/strict";
import { chromium } from "playwright";
const build = await Bun.build({
  entrypoints: [new URL("./fixtures/text-rendering.tsx", import.meta.url).pathname],
  target: "browser",
  format: "iife",
});
assert.equal(build.success, true, String(build.logs));
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setContent(
    '<style>body { margin:0 } svg { width:100%; height:100% }</style><div id="root"></div>',
  );
  await page.addScriptTag({ content: await build.outputs[0].text() });
  await page
    .locator('[data-case="6"] [data-surface="export"] [data-design-text]')
    .waitFor({ state: "attached" });
  const results = await page.locator("[data-case]").evaluateAll((cases) =>
    cases.map((item) =>
      [...item.querySelectorAll("[data-surface]")].map((surface) => {
        const text = surface.querySelector("[data-design-text]"),
          node = text.parentElement,
          style = getComputedStyle(node),
          inner = getComputedStyle(text);
        return {
          content: text.textContent,
          paragraphs: text.children.length,
          width: style.width,
          height: style.height,
          lineHeight: style.lineHeight,
          whiteSpace: style.whiteSpace,
          fontSize: style.fontSize,
          decoration: style.textDecorationLine,
          clamp: inner.webkitLineClamp,
          innerHeight: inner.height,
          spacing: [...text.children].map((child) => getComputedStyle(child).marginTop),
          ellipsis: getComputedStyle(text.firstChild).textOverflow,
        };
      }),
    ),
  );
  for (const [index, surfaces] of results.entries())
    for (const actual of surfaces.slice(1))
      assert.deepEqual(
        actual,
        surfaces[0],
        `text case ${index} matches canvas in thumbnail, review and portable export`,
      );
  assert.ok(parseFloat(results[2][0].height) > 90, "long text grows beyond stored height");
  assert.ok(parseFloat(results[1][0].height) > 0, "empty text retains its line box");
  assert.equal(results[5][0].ellipsis, "ellipsis");
  assert.equal(results[6][0].clamp, "2");
  const bounds = await page.locator("#root-text-preview").evaluate((root) => {
    const svg = root.querySelector("svg"),
      node = root.querySelector("[data-thumbnail-node]");
    return {
      cropHeight: svg.viewBox.baseVal.height,
      textHeight: parseFloat(getComputedStyle(node).height),
    };
  });
  assert.ok(
    bounds.cropHeight >= bounds.textHeight,
    `thumbnail includes auto-height text: ${JSON.stringify(bounds)}`,
  );
  assert.equal(
    await page.locator("#clipped-text-preview svg").evaluate((svg) => svg.viewBox.baseVal.height),
    148,
    "clipped text does not enlarge its fixed frame's thumbnail",
  );
  await page.locator("#root-text-preview [data-thumbnail-node]").evaluate((node) => {
    node.style.width = "120px";
  });
  await page.waitForFunction(() => {
    const root = document.getElementById("root-text-preview");
    return (
      root.querySelector("svg").viewBox.baseVal.height >=
      parseFloat(getComputedStyle(root.querySelector("[data-thumbnail-node]")).height)
    );
  });
  const raster = await page.locator("[data-case]").evaluateAll(async (cases) => {
    async function pixels(element) {
      const markup = new XMLSerializer().serializeToString(element.firstElementChild);
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="500" height="800"><foreignObject width="100%" height="100%"><div xmlns="http://www.w3.org/1999/xhtml" style="position:relative;width:500px;height:800px">${markup}</div></foreignObject></svg>`;
      const image = new Image();
      image.src = `data:image/svg+xml,${encodeURIComponent(svg)}`;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = 500;
      canvas.height = 800;
      const context = canvas.getContext("2d");
      context.drawImage(image, 0, 0);
      return context.getImageData(0, 0, 500, 800).data;
    }
    return Promise.all(
      cases.map(async (item) => {
        const canvas = await pixels(item.querySelector('[data-surface="canvas"]')),
          exported = await pixels(item.querySelector('[data-surface="export"]'));
        return canvas.every((value, index) => value === exported[index]);
      }),
    );
  });
  assert.ok(raster.every(Boolean), `canvas and exported SVG/raster pixels match: ${raster}`);
  assert.deepEqual(errors, []);
  console.log(
    "PASS: long/empty text sizing, paragraph/line-height/truncation parity across canvas, thumbnail, review and portable export; auto-sized thumbnail bounds.",
  );
} finally {
  await browser.close();
}
