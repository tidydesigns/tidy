// Uses the real content script with a mocked extension transport. No server or account writes.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const repo = fileURLToPath(new URL("../../../", import.meta.url));
const output = await mkdtemp(path.join(tmpdir(), "tidy-picker-regression-"));
execFileSync(
  "bun",
  [
    "-e",
    `import path from 'node:path';
    const result = await Bun.build({
      entrypoints: ['apps/web/scripts/fixtures/extension-picker.mjs'],
      target: 'browser',
      external: ['wxt/browser', 'wxt/utils/define-content-script'],
      outdir: process.argv[1],
      naming: 'picker.js',
      plugins: [{name: 'inline-font', setup(build) {
        build.onResolve({filter: /\\.woff2\\?inline$/}, args => ({
          path: path.resolve(args.resolveDir, args.path.replace(/\\?inline$/, '')),
          namespace: 'inline-font',
        }));
        build.onLoad({filter: /.*/, namespace: 'inline-font'}, async args => ({
          contents: 'export default ' + JSON.stringify('data:font/woff2;base64,' + Buffer.from(await Bun.file(args.path).arrayBuffer()).toString('base64')),
          loader: 'js',
        }));
      }}],
    });
    if (!result.success) throw new AggregateError(result.logs, 'Picker build failed');`,
    output,
  ],
  { cwd: repo, stdio: "pipe" },
);
const js = await readFile(path.join(output, "picker.js"), "utf8");
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({
    viewport: { width: 1100, height: 800 },
    colorScheme: "light",
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    const listeners = new Set(),
      changes = new Set();
    const nativeAttach = Element.prototype.attachShadow;
    Element.prototype.attachShadow = function (options) {
      const shadow = nativeAttach.call(this, options);
      if (this.hasAttribute("data-bella-picker")) globalThis.__pickerShadow = shadow;
      return shadow;
    };
    globalThis.__sent = [];
    globalThis.__pickerBrowser = {
      runtime: {
        id: "fixture-extension",
        sendMessage: async (message) => globalThis.__sent.push(message),
        onMessage: {
          addListener: (listener) => listeners.add(listener),
          removeListener: (listener) => listeners.delete(listener),
        },
      },
      storage: {
        onChanged: {
          addListener: (listener) => changes.add(listener),
          removeListener: (listener) => changes.delete(listener),
        },
      },
    };
    globalThis.__pickerMessage = (message) =>
      new Promise((resolve) => {
        for (const listener of listeners) listener(message, { id: "fixture-extension" }, resolve);
      });
    globalThis.__pickerTheme = (theme) => {
      for (const listener of changes) listener({ theme: { newValue: theme } }, "local");
    };
    globalThis.__pickerListenerCount = () => listeners.size + changes.size;
  });
  await page.route("https://picker.test/**", (route) => {
    if (new URL(route.request().url()).pathname === "/picker.js")
      return route.fulfill({ contentType: "text/javascript", body: js });
    return route.fulfill({
      contentType: "text/html",
      body: `
      <title>Picker fixture</title><style>
      body{margin:0;background:#eee;color:#222;font:16px Arial;height:2200px}
      article{position:absolute;left:100px;width:280px;height:160px;padding:20px;box-sizing:border-box;background:white;border-radius:12px}
      #first{top:100px}#second{top:1100px}h2{font-size:24px;margin:0}p{margin:20px 0}a{color:blue}
      </style><article id="first"><h2 id="heading">First card</h2><p>Editable first description</p><a id="link" href="/navigate">Website link</a></article><article id="second"><h2>Second card</h2><p>Editable second description</p></article>
      <script type="importmap">{"imports":{"wxt/browser":"data:text/javascript,export const browser=globalThis.__pickerBrowser","wxt/utils/define-content-script":"data:text/javascript,export const defineContentScript=(value)=>value"}}</script><script type="module" src="/picker.js"></script>`,
    });
  });
  await page.goto("https://picker.test/");
  await page.waitForFunction(() => globalThis.__pickerListenerCount() === 2);
  const message = (value) => page.evaluate((value) => globalThis.__pickerMessage(value), value);
  const state = () =>
    page.evaluate(() => {
      const shadow = globalThis.__pickerShadow,
        button = shadow.querySelector("button"),
        toolbar = shadow.querySelector(".toolbar");
      return {
        label: button.textContent,
        disabled: button.disabled,
        count: shadow.querySelectorAll(".selected").length,
        color: getComputedStyle(toolbar).backgroundColor,
        hint: shadow.querySelector(".hint").textContent,
      };
    });
  const clickPicker = async (selector) => {
    const box = await page.evaluate(
      (selector) =>
        globalThis.__pickerShadow.querySelector(selector).getBoundingClientRect().toJSON(),
      selector,
    );
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  };
  const confirm = () => clickPicker("button");
  await message({ type: "bella:pick", theme: "dark" });
  assert.equal(
    (await state()).color,
    "rgb(32, 32, 32)",
    "App dark theme overrides a light source page and system",
  );
  assert.equal((await state()).disabled, true);
  assert.equal((await state()).hint, "Click elements to select them");
  assert.equal(
    await page.evaluate(() => globalThis.__pickerShadow.querySelector("details").open),
    false,
  );
  await clickPicker("summary");
  assert.equal(
    await page.evaluate(() => globalThis.__pickerShadow.querySelector("details").open),
    true,
  );
  await page.screenshot({ path: path.join(output, "shortcuts.png") });
  await clickPicker("summary");
  await page.evaluate(() => globalThis.__pickerTheme("light"));
  assert.equal((await state()).color, "rgb(250, 250, 250)");
  await page.evaluate(() => globalThis.__pickerTheme("system"));
  await page.emulateMedia({ colorScheme: "dark" });
  assert.equal((await state()).color, "rgb(32, 32, 32)");
  await page.emulateMedia({ colorScheme: "light" });
  assert.equal((await state()).color, "rgb(250, 250, 250)");
  await page.locator("#link").click();
  assert.equal(
    page.url(),
    "https://picker.test/",
    "Selection does not navigate the source website",
  );
  assert.equal((await state()).count, 1);
  await page.locator("#link").click();
  assert.equal((await state()).count, 0, "Click again deselects");
  await page.locator("#heading").click();
  await page.keyboard.press("ArrowUp");
  await page.mouse.down();
  await page.mouse.up();
  assert.equal((await state()).count, 1, "Selecting a parent replaces the selected descendant");
  await page.locator("#second").click({ position: { x: 8, y: 8 } });
  assert.equal((await state()).label, "Copy 2 elements");
  const selected = await page.evaluate(() =>
    [...globalThis.__pickerShadow.querySelectorAll(".selected")].map((element) =>
      parseFloat(element.style.top),
    ),
  );
  assert.ok(
    selected.some((top) => top < 0),
    "Selections remain marked after scrolling offscreen",
  );
  await page.screenshot({ path: path.join(output, "light.png") });
  await page.evaluate(() => globalThis.__pickerTheme("dark"));
  await page.screenshot({ path: path.join(output, "dark.png") });
  await confirm();
  assert.equal(
    await page.locator("[data-bella-picker]").count(),
    0,
    "Picker is removed before capture",
  );
  assert.deepEqual(await page.evaluate(() => globalThis.__sent), [{ type: "bella:picked" }]);
  const prepared = await message({ type: "bella:prepare-capture" });
  const reply = await message({
    type: "bella:capture",
    mode: "element",
    screenshotViewport: prepared.data,
  });
  assert.ok(reply.data, reply.error);
  const frames = reply.data.document.nodes.filter((node) => node.type === "artboard");
  assert.equal(frames.length, 2, "Both elements are captured together");
  assert.equal(frames[1].box.x, frames[0].box.width + 120);
  assert.equal(reply.data.document.nodes.filter((node) => node.text === "First card").length, 1);
  assert.ok(reply.data.document.nodes.some((node) => node.text === "Editable second description"));
  assert.ok(reply.data.document.nodes.some((node) => node.text === "Second card"));
  assert.ok(
    !reply.data.document.nodes.some((node) => node.text?.includes("Click elements to select")),
    "Picker UI is excluded",
  );
  const capturePath = path.join(output, "capture.json");
  await writeFile(capturePath, JSON.stringify(reply.data));
  execFileSync(
    "bun",
    [
      "-e",
      'import {webCaptureSchema} from "./packages/design/web-capture.ts"; webCaptureSchema.parse(await Bun.file(process.argv[1]).json());',
      capturePath,
    ],
    { cwd: repo, stdio: "pipe" },
  );
  await message({ type: "bella:pick", theme: "dark" });
  await page.locator("#second").click();
  await page.evaluate(() => document.querySelector("#second").remove());
  await confirm();
  assert.match((await state()).hint, /disappeared/);
  assert.equal(
    (await state()).disabled,
    true,
    "Detached selections cannot silently produce a partial import",
  );
  await page.keyboard.press("Escape");
  assert.equal(await page.locator("[data-bella-picker]").count(), 0);
  assert.deepEqual(await page.evaluate(() => globalThis.__sent.at(-1)), {
    type: "bella:cancelled",
  });
  await message({ type: "bella:pick", theme: "light" });
  await page.evaluate(() => globalThis.invalidatePicker());
  assert.equal(await page.locator("[data-bella-picker]").count(), 0);
  assert.equal(await page.evaluate(() => globalThis.__pickerListenerCount()), 0);
  assert.deepEqual(errors, [], "Picker runs without browser errors");
  console.log(
    `Multi-selection, scrolling, capture, theme sync, cancellation and cleanup passed. Screenshots: ${output}`,
  );
} finally {
  await browser.close();
}
