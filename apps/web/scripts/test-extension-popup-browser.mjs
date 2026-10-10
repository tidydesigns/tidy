// Start bun dev first, then run: node apps/web/scripts/test-extension-popup-browser.mjs
// Disposable browser contexts; no account, database or import writes.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const repo = fileURLToPath(new URL("../../../", import.meta.url));
const output = await mkdtemp(path.join(tmpdir(), "tidy-popup-regression-"));
execFileSync(
  "bun",
  [
    "build",
    "apps/extension/entrypoints/popup/main.tsx",
    "--target=browser",
    "--external=wxt/browser",
    `--outdir=${output}`,
  ],
  { cwd: repo, stdio: "pipe" },
);
const [js, css] = await Promise.all(
  ["main.js", "main.css"].map((name) => readFile(path.join(output, name), "utf8")),
);
const browser = await chromium.launch({ headless: true });
try {
  for (const preference of ["dark", "light", "system"]) {
    const context = await browser.newContext({
      viewport: { width: 320, height: 520 },
      colorScheme: preference === "light" ? "dark" : "light",
    });
    const app = await context.newPage();
    await app.addInitScript((preference) => {
      if (preference === "system") localStorage.removeItem("tidy-theme");
      else localStorage.setItem("tidy-theme", preference);
    }, preference);
    await app.goto("http://localhost:3000/login");
    const response = await context.request.get("http://localhost:3000/api/extension/account", {
      headers: { "X-Tidy-Extension": "1" },
    });
    assert.equal(
      response.headers()["x-tidy-theme"],
      preference,
      "Existing app preferences migrate into extension requests",
    );
    const popup = await context.newPage();
    const errors = [];
    popup.on("pageerror", (error) => errors.push(error.message));
    await popup.addInitScript((theme) => {
      const listeners = new Set();
      const stored = { theme };
      const account = {
        user: { id: "fixture-user", name: "Alex Designer" },
        organizations: [
          {
            id: "fixture-org",
            name: "Design team",
            files: [{ id: "fixture-file", name: "Profile exploration" }],
          },
        ],
      };
      globalThis.__popupBrowser = {
        runtime: { sendMessage: async () => ({ data: account }) },
        storage: {
          local: { get: async () => stored, set: async (value) => Object.assign(stored, value) },
          session: {
            get: async () => ({
              job: {
                state: "done",
                userId: "fixture-user",
                url: "http://localhost:3000/files/fixture",
                warnings: Array.from({ length: 10 }, () => ({
                  message: "An effect was preserved as an image with transparent edges.",
                })),
              },
            }),
          },
          onChanged: {
            addListener: (listener) => listeners.add(listener),
            removeListener: (listener) => listeners.delete(listener),
          },
        },
      };
      globalThis.__changePopupTheme = (theme) => {
        stored.theme = theme;
        for (const listener of listeners) listener({ theme: { newValue: theme } }, "local");
      };
    }, response.headers()["x-tidy-theme"]);
    await popup.route("https://popup.test/**", (route) => {
      const pathname = new URL(route.request().url()).pathname;
      return route.fulfill(
        pathname === "/popup.js"
          ? { contentType: "text/javascript", body: js }
          : pathname === "/popup.css"
            ? { contentType: "text/css", body: css }
            : {
                contentType: "text/html",
                body: '<link rel="stylesheet" href="/popup.css"><script type="importmap">{"imports":{"wxt/browser":"data:text/javascript,export const browser=globalThis.__popupBrowser"}}</script><div id="root"></div><script type="module" src="/popup.js"></script>',
              },
      );
    });
    await popup.goto("https://popup.test/");
    await popup.getByRole("button", { name: "Copy page", exact: true }).waitFor();
    assert.equal(await popup.locator("header img").count(), 0, "Popup has no logo tile");
    const expectedBackground = preference === "dark" ? "rgb(32, 32, 32)" : "rgb(250, 250, 250)";
    assert.equal(
      await popup.evaluate(() => getComputedStyle(document.documentElement).backgroundColor),
      expectedBackground,
    );
    await popup.getByRole("button", { name: "Design file" }).click();
    await popup.getByRole("menuitemradio", { name: "Profile exploration" }).click();
    assert.equal(
      await popup.getByRole("button", { name: "Design file" }).innerText(),
      "Profile exploration",
    );
    await popup.locator("summary").click();
    assert.equal(
      await popup.locator("details ul").evaluate((list) => list.clientHeight),
      140,
      "Expanded notes stay bounded",
    );
    await popup.locator("summary").click();
    await popup.screenshot({ path: path.join(output, `${preference}.png`), fullPage: true });
    await popup.evaluate(() => globalThis.__changePopupTheme("dark"));
    assert.equal(await popup.evaluate(() => document.documentElement.dataset.theme), "dark");
    await popup.evaluate(() => globalThis.__changePopupTheme("system"));
    await popup.emulateMedia({ colorScheme: "dark" });
    assert.equal(
      await popup.evaluate(() => getComputedStyle(document.documentElement).backgroundColor),
      "rgb(32, 32, 32)",
    );
    assert.deepEqual(errors, [], "Popup renders without browser errors");
    await context.close();
  }
  console.log(
    `App theme, popup themes, shared dropdown and bounded notes passed. Screenshots: ${output}`,
  );
} finally {
  await browser.close();
}
