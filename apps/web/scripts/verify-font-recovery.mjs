import assert from "node:assert/strict";
import { chromium } from "playwright";
const build = await Bun.build({
  entrypoints: [new URL("./fixtures/font-recovery.tsx", import.meta.url).pathname],
  target: "browser",
  format: "iife",
});
assert.equal(build.success, true, String(build.logs));
const script = await build.outputs[0].text();
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(request) {
    return new URL(request.url).pathname === "/fixture.js"
      ? new Response(script, { headers: { "Content-Type": "text/javascript; charset=utf-8" } })
      : new Response(
          '<meta charset="utf-8"><style>svg{width:100%;height:100%}</style><div id="root"></div><script src="/fixture.js"></script>',
          { headers: { "Content-Type": "text/html; charset=utf-8" } },
        );
  },
});
const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext();
  await context.addInitScript(() =>
    Object.defineProperty(window, "queryLocalFonts", { value: undefined, configurable: true }),
  );
  const page = await context.newPage(),
    errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url.href);
  await page.waitForFunction(() => window.fontTest);
  await page.getByText("Unavailable fonts · 1", { exact: true }).click();
  await page
    .getByText("2 layers across this file. Using a fallback on this device.", { exact: true })
    .waitFor();
  const before = await page.evaluate(() => JSON.stringify(window.fontTest.document));
  const families = () =>
    page
      .locator("[data-surface]")
      .evaluateAll((surfaces) =>
        surfaces.map(
          (surface) =>
            getComputedStyle(surface.querySelector("[data-design-text]").parentElement).fontFamily,
        ),
      );
  const missing = await families();
  assert.equal(new Set(missing).size, 1);
  assert.ok(missing[0].includes("system-ui"));
  await page
    .getByRole("combobox", { name: "Replace Tidy Absent Font 937 throughout file" })
    .click();
  await page
    .getByText(
      "This browser cannot list local fonts. Choose a web font, or open this file in a browser with local font access.",
      { exact: true },
    )
    .waitFor();
  assert.equal(await page.getByRole("button", { name: "Use local fonts", exact: true }).count(), 0);
  await page.getByRole("textbox", { name: "Search fonts" }).fill("monospace");
  await page.getByRole("option", { name: "monospace", exact: true }).click();
  await page.getByText("Unavailable fonts · 1", { exact: true }).waitFor({ state: "hidden" });
  const after = await page.evaluate(() => window.fontTest.document);
  for (const id of ["text", "hidden-text"]) {
    assert.equal(after.nodes.find((node) => node.id === id).style.fontFamily, "monospace");
    assert.equal(after.nodes.find((node) => node.id === id).style.fontFace, undefined);
  }
  assert.equal(after.nodes.find((node) => node.id === "hidden-text").locked, true);
  assert.deepEqual(await families(), ["monospace", "monospace", "monospace", "monospace"]);
  await page.getByRole("button", { name: "Undo replacement" }).click();
  assert.deepEqual(
    JSON.parse(await page.evaluate(() => JSON.stringify(window.fontTest.document))),
    JSON.parse(before),
  );
  const unavailable = await page.evaluate(async () => {
    try {
      await window.fontTest.registry.exportCss([
        {
          family: "Tidy Absent Font 937",
          source: "local",
          face: "Tidy Absent Font 937 Regular",
          weight: 400,
          italic: false,
          text: "Hello",
        },
      ]);
      return "";
    } catch (error) {
      return error.message;
    }
  });
  assert.ok(unavailable.includes("cannot access local font bytes for Tidy Absent Font 937"));
  assert.ok(unavailable.includes("Choose a web font"));
  const reopened = await browser.newContext();
  await reopened.addInitScript((document) => {
    window.initialFontDocument = document;
    Object.defineProperty(window, "queryLocalFonts", { value: undefined, configurable: true });
  }, after);
  const other = await reopened.newPage();
  await other.goto(server.url.href);
  await other.waitForFunction(
    () => window.fontTest?.registry.getStatus("monospace", 400, false, "system") === "loaded",
  );
  assert.equal(await other.getByText("Unavailable fonts · 1", { exact: true }).count(), 0);
  assert.equal(
    await other.evaluate(
      () => window.fontTest.document.nodes.find((node) => node.id === "text").style.fontFamily,
    ),
    "monospace",
  );
  assert.deepEqual(errors, []);
  await context.close();
  await reopened.close();
  const native = await browser.newContext();
  await native.grantPermissions(["local-fonts"]);
  const installed = await native.newPage();
  await installed.goto(server.url.href);
  await installed.waitForFunction(() => window.fontTest);
  const embedded = await installed.evaluate(async () => {
    const registry = window.fontTest.registry;
    await registry.connectLocal();
    const font = registry.localFonts().find((font) => font.family === "Arial");
    if (!font) throw new Error("The local-font fixture requires an installed Arial face.");
    const face = font.styles.find((style) => style.weight === 400 && !style.italic);
    if (!face) throw new Error("Arial has no regular face in the local fixture.");
    await registry.load("Arial", 400, false, "Font example", "local", face.face);
    const css = await registry.exportCss([
      {
        family: "Arial",
        source: "local",
        face: face.face,
        weight: 400,
        italic: false,
        text: "Font example",
      },
    ]);
    const data = css.match(/src:url\(([^)]+)\)/)?.[1];
    const exportedFace = new FontFace("Exported fixture font", `url(${data})`);
    await exportedFace.load();
    return {
      loaded: registry.getStatus("Arial", 400, false, "local", face.face),
      embedded: data?.startsWith("data:"),
      exportLoaded: exportedFace.status,
      bytes: css.length,
    };
  });
  assert.equal(embedded.loaded, "loaded");
  assert.equal(embedded.embedded, true);
  assert.equal(embedded.exportLoaded, "loaded");
  assert.ok(embedded.bytes > 1000);
  await native.close();
  console.log(
    "PASS: missing-font feedback, API-unavailable fallback, whole-file replacement, hidden/locked pages, undo, fresh-context reopen, renderer parity, installed-face loading and usable static local-font export bytes.",
  );
} finally {
  await browser.close();
  server.stop(true);
}
