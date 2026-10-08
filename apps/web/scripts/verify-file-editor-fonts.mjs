import { artifactPath } from "./artifact-path.mjs";
import { chooseSelectMenu, selectMenuOptions } from "./select-menu-controls.mjs";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const baseUrl = process.env.EDITOR_TEST_URL || "http://127.0.0.1:3107";
const command = process.platform === "darwin" ? "Meta" : "Control";
const browser = await chromium.launch({ headless: true, args: ["--no-proxy-server"] });
try {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    ignoreHTTPSErrors: true,
  });
  let failOswald = true;
  await context.route("https://fonts.googleapis.com/**", (route) =>
    new URL(route.request().url()).searchParams.get("family")?.startsWith("Oswald:") && failOswald
      ? route.fulfill({ status: 503, body: "Unavailable" })
      : route.continue(),
  );
  const page = await context.newPage(),
    errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${baseUrl}/dev/import-preview?edit=1`);
  await page.getByRole("tree", { name: "Layers" }).waitFor();
  const canvas = page.getByLabel("Design canvas", { exact: true }),
    heading = page.locator('[data-node-id="desktop-heading"]');
  const choose = async (family) => {
    await page.getByRole("combobox", { name: "Font family", exact: true }).click();
    await page.getByRole("textbox", { name: "Search fonts", exact: true }).fill(family);
    await page.getByRole("textbox", { name: "Search fonts", exact: true }).press("Enter");
  };
  const loaded = async (family) =>
    page.waitForFunction(
      (family) =>
        [...document.fonts].some(
          (face) => face.family.replace(/['"]/g, "") === family && face.status === "loaded",
        ),
      family,
      { timeout: 30_000 },
    );
  await page.getByRole("button", { name: "Select Welcome heading", exact: true }).first().click();
  await page.getByRole("combobox", { name: "Font family", exact: true }).click();
  const search = page.getByRole("textbox", { name: "Search fonts", exact: true });
  for (let i = 0; i < 61; i++) await search.press("ArrowDown");
  assert.ok(
    (await page.getByRole("option").count()) > 60,
    "Keyboard navigation must reach beyond the first catalog page.",
  );
  assert.ok((await search.getAttribute("aria-activedescendant")).endsWith("-61"));
  await search.press("Escape");
  await choose("ABeeZee");
  await loaded("ABeeZee");
  assert.equal(await heading.evaluate((element) => element.style.fontWeight), "400");
  assert.deepEqual(await selectMenuOptions(page, "Font style"), ["Regular", "Regular Italic"]);
  await chooseSelectMenu(page, "Font style", "Regular Italic");
  assert.equal(await heading.evaluate((element) => element.style.fontStyle), "italic");
  await canvas.focus();
  await page.keyboard.press(`${command}+z`);
  assert.equal(await heading.evaluate((element) => element.style.fontStyle), "normal");
  await choose("Roboto Flex");
  await loaded("Roboto Flex");
  await page.getByRole("spinbutton", { name: "Font weight", exact: true }).fill("350");
  await page.getByRole("spinbutton", { name: "Font weight", exact: true }).press("Enter");
  assert.equal(await heading.evaluate((element) => element.style.fontWeight), "350");
  const weightField = page.getByRole("spinbutton", { name: "Font weight", exact: true });
  await weightField.fill("350.5");
  await weightField.press("Enter");
  assert.equal(await weightField.getAttribute("aria-invalid"), "true");
  assert.equal(await heading.evaluate((element) => element.style.fontWeight), "350");
  await weightField.press("Escape");
  assert.equal(
    await page.getByText("Choose an available style for this font.", { exact: true }).count(),
    0,
  );
  await choose("Oswald");
  await page.getByText("A selected font could not load.", { exact: true }).waitFor();
  failOswald = false;
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await loaded("Oswald");
  await page
    .getByText("A selected font could not load.", { exact: true })
    .waitFor({ state: "hidden" });
  assert.equal(await heading.evaluate((element) => element.style.fontWeight), "350");
  await choose("Roboto Flex");
  await loaded("Roboto Flex");
  // The exported SVG must carry real font bytes, including only used subsets.
  await page.getByRole("button", { name: "Select Desktop 1440 · /login", exact: true }).click();
  await page.getByText("Export", { exact: true }).click();
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "svg", exact: true }).click();
  const download = await downloadPromise,
    path = await download.path(),
    svg = await readFile(path, "utf8");
  assert.ok(svg.includes("@font-face"));
  assert.ok(svg.includes("data:font/") || svg.includes("data:application/"));
  assert.ok(!svg.includes("https://fonts.gstatic.com"));
  assert.equal(
    await page.evaluate(
      (svg) =>
        new DOMParser().parseFromString(svg, "image/svg+xml").querySelectorAll("parsererror")
          .length,
      svg,
    ),
    0,
  );
  await page.getByRole("button", { name: "Select Welcome heading", exact: true }).first().click();
  await page.getByRole("combobox", { name: "Font family", exact: true }).click();
  await page.getByRole("textbox", { name: "Search fonts", exact: true }).fill("Roboto Flex");
  await page.screenshot({ path: artifactPath("bella-editor-font-picker.png") });
  await page.getByRole("textbox", { name: "Search fonts", exact: true }).press("Escape");
  assert.equal(await page.getByRole("listbox", { name: "Fonts", exact: true }).count(), 0);
  await context.grantPermissions(["local-fonts"]);
  await page.getByRole("combobox", { name: "Font family", exact: true }).click();
  await page.getByRole("textbox", { name: "Search fonts", exact: true }).fill("Arial");
  await page.getByRole("button", { name: "Use local fonts", exact: true }).click();
  await page.getByRole("option", { name: "Arial Local", exact: true }).waitFor();
  await page.getByRole("option", { name: "Arial Local", exact: true }).click();
  await chooseSelectMenu(page, "Font style", "Bold");
  await page.waitForFunction(() =>
    [...document.fonts].some((face) => face.family.includes("Arial") && face.status === "loaded"),
  );
  assert.equal(await heading.evaluate((element) => element.style.fontWeight), "700");
  assert.ok(
    await heading.evaluate(
      (element) =>
        element.style.fontFamily.includes("Arial") && element.style.fontFamily.includes(","),
    ),
  );
  await page.getByRole("button", { name: "Select Desktop 1440 · /login", exact: true }).click();
  await page.getByText("Export", { exact: true }).click();
  const localDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "svg", exact: true }).click();
  const localSvg = await readFile(await (await localDownload).path(), "utf8");
  assert.ok(
    localSvg.includes("font-family:&quot;Arial") || localSvg.includes('font-family:"Arial'),
  );
  assert.ok(localSvg.includes("data:application/octet-stream"));
  const pngDownload = page.waitForEvent("download", { timeout: 10_000 });
  await page.getByRole("button", { name: "png", exact: true }).click();
  const pngResult = await pngDownload.catch(async (error) => {
    console.log("Export alerts", await page.getByRole("alert").allTextContents());
    throw error;
  });
  const png = await readFile(await pngResult.path());
  assert.equal(png.readUInt32BE(16), 1440);
  assert.equal(png.readUInt32BE(20), 900);
  const ink = await page.evaluate(
    async (data) => {
      const image = new Image();
      image.src = data;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = 1440;
      canvas.height = 900;
      const context = canvas.getContext("2d");
      context.drawImage(image, 0, 0);
      const pixels = context.getImageData(528, 294, 220, 42).data;
      let dark = 0;
      for (let i = 0; i < pixels.length; i += 4)
        if (pixels[i] < 100 && pixels[i + 1] < 100 && pixels[i + 2] < 100 && pixels[i + 3] > 0)
          dark++;
      return dark;
    },
    `data:image/png;base64,${png.toString("base64")}`,
  );
  assert.ok(ink > 50, "The exported PNG must render the heading text.");
  const webpDownload = page.waitForEvent("download", { timeout: 10_000 });
  await page.getByRole("button", { name: "webp", exact: true }).click();
  const webp = await readFile(await (await webpDownload).path());
  assert.equal(webp.toString("ascii", 0, 4), "RIFF");
  assert.equal(webp.toString("ascii", 8, 12), "WEBP");
  const webpSize = await page.evaluate(
    async (data) => {
      const image = new Image();
      image.src = data;
      await image.decode();
      return [image.naturalWidth, image.naturalHeight];
    },
    `data:image/webp;base64,${webp.toString("base64")}`,
  );
  assert.deepEqual(webpSize, [1440, 900]);
  assert.deepEqual(errors, []);
  console.log(
    "PASS: searchable font previews, web and installed-font discovery/loading, physical local face selection, valid styles, preserved variable weights, undo, load failure/retry, keyboard dismissal, SVG font embedding, PNG dimensions/rendered text, and WebP dimensions; no page errors",
  );
  await context.close();
  const missingContext = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    ignoreHTTPSErrors: true,
  });
  await missingContext.addInitScript(() => {
    let attempts = 0;
    Object.defineProperty(window, "queryLocalFonts", {
      configurable: true,
      value: async () => {
        if (++attempts === 1) throw new DOMException("Denied", "NotAllowedError");
        return [
          {
            family: "Bella Missing Font",
            fullName: "Bella Missing Font Regular",
            style: "Regular",
            blob: async () => new Blob([new ArrayBuffer(12)]),
          },
        ];
      },
    });
  });
  const missingPage = await missingContext.newPage();
  missingPage.on("pageerror", (error) => errors.push(error.message));
  await missingPage.goto(`${baseUrl}/dev/import-preview?edit=1`);
  await missingPage
    .getByRole("button", { name: "Select Welcome heading", exact: true })
    .first()
    .click();
  await missingPage.getByRole("combobox", { name: "Font family", exact: true }).click();
  await missingPage.getByRole("button", { name: "Use local fonts", exact: true }).click();
  await missingPage
    .getByText("Local fonts were not enabled. You can try again.", { exact: true })
    .waitFor();
  await missingPage.getByRole("button", { name: "Use local fonts", exact: true }).click();
  await missingPage
    .getByRole("textbox", { name: "Search fonts", exact: true })
    .fill("Bella Missing Font");
  await missingPage.getByRole("option", { name: "Bella Missing Font Local", exact: true }).click();
  await missingPage
    .getByText("Bella Missing Font is unavailable. Using a fallback.", { exact: true })
    .waitFor();
  assert.ok(
    await missingPage
      .locator('[data-node-id="desktop-heading"]')
      .evaluate((element) => element.style.fontFamily.endsWith("system-ui")),
  );
  assert.deepEqual(errors, []);
  await missingContext.close();
  console.log(
    "PASS: denied local-font access can be retried; a removed local font shows missing-font feedback and a system fallback; no page errors",
  );
} finally {
  await browser.close();
}
