// Isolated browser fixtures: no account, database or remote storage is contacted.
// Run from the repository root: bun apps/web/scripts/test-avatar-controls.mjs
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build, file, serve, write } from "bun";
import { chromium } from "playwright";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";

const root = fileURLToPath(new URL("../", import.meta.url));
const directory = mkdtempSync(join(root, ".avatar-test-"));
let browser, server;
try {
  const entry = join(directory, "entry.tsx");
  await write(
    entry,
    `
    import React from "react";
    import { createRoot } from "react-dom/client";
    import { AvatarControl } from "../app/settings/avatar-control";
    import { OrganizationNamesProvider, useOrganizationNames } from "../components/workspace/organization-names";
    import { SelectMenu } from "../components/ui/select-menu";
    function Fixture() {
      const { images } = useOrganizationNames();
      const [avatarKey, setAvatarKey] = React.useState(0);
      return <main className="mx-auto max-w-xl space-y-10 p-10">
        <AvatarControl key={avatarKey} kind="user" id="owner" name="Sean" />
        <AvatarControl kind="organization" id="org" name="Tidy" />
        <section aria-label="Read-only"><AvatarControl kind="organization" id="readonly" name="Read only" editable={false} /></section>
        <SelectMenu label="Existing select" value="one" options={[{value: "one", label: "One"}, {value: "two", label: "Two"}]} onChange={() => {}} />
        <input aria-label="Unrelated field" defaultValue="Unchanged" />
        <button type="button" onClick={() => setAvatarKey(key => key + 1)}>Remount avatars</button>
        <output hidden>{JSON.stringify(images)}</output>
      </main>;
    }
    createRoot(document.getElementById("root")!).render(<OrganizationNamesProvider><Fixture /></OrganizationNamesProvider>);
  `,
  );
  const bundle = await build({
    entrypoints: [entry],
    target: "browser",
    outdir: directory,
    define: { "process.env.NODE_ENV": '"production"' },
    tsconfig: join(root, "tsconfig.json"),
  });
  assert.equal(bundle.success, true, String(bundle.logs));
  const css = await postcss([tailwind({ base: root })]).process(
    await file(join(root, "app/globals.css")).text(),
    { from: join(root, "app/globals.css") },
  );
  server = serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/entry.js")
        return new Response(file(join(directory, "entry.js")), {
          headers: { "Content-Type": "text/javascript" },
        });
      if (path === "/style.css")
        return new Response(css.css, { headers: { "Content-Type": "text/css" } });
      return new Response(
        '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"></head><body><div id="root"></div><script type="module" src="/entry.js"></script></body></html>',
        { headers: { "Content-Type": "text/html" } },
      );
    },
  });
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aG1sAAAAASUVORK5CYII=",
    "base64",
  );
  let writes = 0,
    failNext = false,
    holdNext = false,
    releaseUpload;
  await page.route("**/api/avatars/**", async (route) => {
    if (route.request().method() === "GET")
      return route.fulfill({ status: 200, contentType: "image/png", body: png });
    writes++;
    if (holdNext) {
      holdNext = false;
      await new Promise((resolve) => {
        releaseUpload = resolve;
      });
    }
    if (failNext) {
      failNext = false;
      return route.fulfill({ status: 503, json: { error: "Upload unavailable. Try again." } });
    }
    const image =
      route.request().method() === "DELETE"
        ? null
        : new URL(route.request().url()).pathname + "?v=" + writes;
    return route.fulfill({ json: { image } });
  });
  await page.goto(String(server.url));
  await page.getByRole("textbox", { name: "Unrelated field" }).fill("Keep this draft");
  assert.equal(
    await page.getByRole("region", { name: "Read-only" }).getByRole("button").count(),
    0,
  );
  for (const label of ["Profile picture", "Organization icon"]) {
    const lower = label.toLowerCase();
    const empty = page.getByRole("button", { name: "Upload " + lower });
    const chooser = page.waitForEvent("filechooser");
    await empty.click();
    await (await chooser).setFiles({ name: "photo.png", mimeType: "image/png", buffer: png });
    const trigger = page.getByRole("button", { name: label, exact: true });
    await trigger.waitFor();
    const initial = await trigger.locator("img").getAttribute("src");
    await trigger.focus();
    await page.keyboard.press("ArrowDown");
    const change = page.getByRole("menuitem", { name: "Change", exact: true });
    await change.waitFor();
    assert.equal(await change.evaluate((node) => document.activeElement === node), true);
    await page.keyboard.press("ArrowDown");
    assert.equal(
      await page
        .getByRole("menuitem", { name: "Delete", exact: true })
        .evaluate((node) => document.activeElement === node),
      true,
    );
    await page.keyboard.press("Escape");
    assert.equal(await trigger.evaluate((node) => document.activeElement === node), true);
    await trigger.click();
    const replacement = page.waitForEvent("filechooser");
    await change.click();
    await (await replacement).setFiles({ name: "photo.png", mimeType: "image/png", buffer: png });
    await page.waitForFunction(
      ({ label, initial }) =>
        document.querySelector('button[aria-label="' + label + '"] img')?.getAttribute("src") !==
        initial,
      { label, initial },
    );
    const current = await trigger.locator("img").getAttribute("src");
    assert.ok((await page.locator("output").textContent()).includes(current));
    failNext = true;
    await trigger.click();
    await page.getByRole("menuitem", { name: "Delete", exact: true }).click();
    await page.getByRole("alert").waitFor();
    assert.equal(await trigger.locator("img").getAttribute("src"), current);
    await trigger.click();
    await page.getByRole("menuitem", { name: "Delete", exact: true }).click();
    await empty.waitFor();
    assert.equal(await page.getByRole("alert").count(), 0);
  }
  holdNext = true;
  await page
    .locator('input[type="file"]')
    .first()
    .setInputFiles({ name: "photo.png", mimeType: "image/png", buffer: png });
  await page.getByRole("status").waitFor();
  await page.getByRole("button", { name: "Remount avatars" }).click();
  assert.equal(
    await page.getByRole("button", { name: "Upload profile picture" }).isDisabled(),
    true,
  );
  assert.equal(typeof releaseUpload, "function");
  releaseUpload();
  await page.getByRole("button", { name: "Profile picture", exact: true }).waitFor();
  await page.getByRole("button", { name: "Profile picture", exact: true }).click();
  await page.getByRole("menuitem", { name: "Delete", exact: true }).click();
  await page.getByRole("button", { name: "Upload profile picture" }).waitFor();
  const beforeInvalid = writes;
  await page
    .locator('input[type="file"]')
    .first()
    .setInputFiles({ name: "icon.svg", mimeType: "image/svg+xml", buffer: Buffer.from("<svg/>") });
  await page.getByRole("alert").waitFor();
  assert.equal(writes, beforeInvalid);
  assert.equal(
    await page.getByRole("textbox", { name: "Unrelated field" }).inputValue(),
    "Keep this draft",
  );
  await page.getByRole("button", { name: "Existing select: One" }).click();
  assert.equal(
    await page.getByRole("menuitemradio", { name: "One" }).getAttribute("aria-checked"),
    "true",
  );
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 375, height: 650 });
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    true,
  );
  if (process.env.AVATAR_SCREENSHOT)
    await page.screenshot({ path: resolve(process.env.AVATAR_SCREENSHOT) });
  assert.deepEqual(errors, []);
  console.log(
    "PASS: profile and organization upload/change/delete, keyboard menu, errors, shared state, existing select and mobile layout",
  );
} finally {
  await browser?.close();
  server?.stop(true);
  rmSync(directory, { recursive: true, force: true });
}
