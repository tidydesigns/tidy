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
    "--external=/fonts/*",
    '--define=import.meta.env.WXT_BELLA_URL="http://localhost:3000"',
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
        user: {
          id: "fixture-user",
          name: "Alex Designer",
          image: "/api/avatars/user/fixture-user?v=fixture",
        },
        organizations: [
          {
            id: "fixture-org",
            name: "Design team",
            files: [{ id: "fixture-file", name: "Profile exploration" }],
          },
        ],
      };
      globalThis.__popupBrowser = {
        runtime: { sendMessage: async () => ({ data: structuredClone(account) }) },
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
      globalThis.__changePopupAvatar = (image) => {
        account.user.image = image;
        window.dispatchEvent(new Event("focus"));
      };
    }, response.headers()["x-tidy-theme"]);
    await popup.route("http://localhost:3000/api/avatars/**", (route) =>
      route.fulfill({
        contentType: "image/svg+xml",
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#809b8a"/><circle cx="32" cy="24" r="12" fill="#f1d6bd"/><path d="M9 64a23 23 0 0 1 46 0" fill="#35495a"/></svg>',
      }),
    );
    await popup.route("https://popup.test/**", async (route) => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname.startsWith("/fonts/")) {
        return route.fulfill({
          contentType: pathname.endsWith(".woff2") ? "font/woff2" : "font/ttf",
          body: await readFile(path.join(repo, "apps/extension/public", pathname)),
        });
      }
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
    await popup.evaluate(() => document.fonts.ready);
    assert.equal(
      await popup.locator("header img").count(),
      1,
      "Header only contains the user avatar",
    );
    assert.equal(await popup.locator("header").innerText(), "Tidy");
    const avatar = popup.getByRole("img", { name: "Alex Designer" });
    assert.equal(
      await avatar.locator("img").getAttribute("src"),
      "http://localhost:3000/api/avatars/user/fixture-user?v=fixture",
      "Private avatars resolve against the app origin",
    );
    assert.equal(await avatar.locator("img").evaluate((img) => img.naturalWidth), 64);
    assert.equal(await avatar.evaluate((el) => el.getBoundingClientRect().width), 32);
    assert.equal(
      await popup.locator(".brand-name").evaluate((el) => getComputedStyle(el).fontFamily),
      '"Instrument Serif", Georgia, serif',
    );
    assert.equal(
      await popup.getByRole("button", { name: "Copy page", exact: true }).evaluate((el) => {
        const style = getComputedStyle(el);
        return `${style.fontFamily}|${style.fontSize}`;
      }),
      '"Instrument Sans", sans-serif|15px',
    );
    assert.equal(
      await popup.evaluate(() => document.fonts.check('15px "Instrument Sans"')),
      true,
      "Bundled Instrument Sans loads",
    );
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
    await popup.evaluate(() => globalThis.__changePopupAvatar(null));
    await avatar.getByText("A", { exact: true }).waitFor();
    await popup.route("http://localhost:3000/broken-avatar", (route) => route.abort());
    await popup.evaluate(() => globalThis.__changePopupAvatar("/broken-avatar"));
    await avatar.getByText("A", { exact: true }).waitFor();
    assert.equal(
      await avatar.locator("img").count(),
      0,
      "Failed images fall back to the user's initial",
    );
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
    `App theme, popup themes, wordmark, avatars, fonts, dropdown and bounded notes passed. Screenshots: ${output}`,
  );
} finally {
  await browser.close();
}
