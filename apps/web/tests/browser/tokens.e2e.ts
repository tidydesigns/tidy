import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import sharp from "sharp";
import { chooseSelectMenu, selectMenuText } from "../../scripts/select-menu-controls.mjs";
import { test } from "./fixtures";
import type { Locator, Page } from "playwright";

test("token edits, bindings, history and exported pixels", async ({ page, baseURL }) => {
  const base = baseURL!;

  await page.goto(`${base}/dev/import-preview?edit=1&tokens=1`);
  const card = page.locator('[data-node-id="token-card"]'),
    second = page.locator('[data-node-id="token-second"]'),
    text = page.locator('[data-node-id="token-label"]');
  await card.waitFor();
  assert.equal(await card.evaluate((element) => getComputedStyle(element).width), "280px");
  assert.equal(await text.evaluate((element) => getComputedStyle(element).fontSize), "18px");
  const select = (name: string, modifiers: ("Shift" | "Control" | "Meta" | "Alt")[] = []) =>
    page
      .getByRole("button", { name: `Select ${name}`, exact: true })
      .first()
      .click({ modifiers });
  const canvas = page.getByLabel("Design canvas", { exact: true });
  const set = async (scope: Page | Locator, label: string, value: number) => {
    const field = scope.getByRole("spinbutton", { name: label, exact: true });
    await field.fill(String(value));
    await field.press("Enter");
  };
  const tokenTab = page.getByRole("tab", { name: "Tokens", exact: true });
  await tokenTab.click();
  const token = (name: string) =>
    page
      .locator("details")
      .filter({ has: page.locator("summary").filter({ hasText: new RegExp(`^${name} ·`) }) });
  await token("rounded").locator("summary").click();
  await set(token("rounded"), "Value", 24);
  await page.waitForFunction(
    () =>
      getComputedStyle(document.querySelector('[data-node-id="token-card"]')!)
        .borderTopLeftRadius === "24px",
  );
  assert.equal(
    await second.evaluate((element) => getComputedStyle(element).borderTopLeftRadius),
    "0px",
  );
  await token("body").locator("summary").click();
  await set(token("body"), "Font size", 22);
  await page.waitForFunction(
    () =>
      getComputedStyle(document.querySelector('[data-node-id="token-label"]')!).fontSize === "22px",
  );
  const rename = token("rounded").getByRole("textbox", { name: "Token name", exact: true });
  await rename.fill("pill");
  await rename.press("Enter");
  await token("pill").locator("summary").click();
  await page.getByRole("button", { name: "Remove token pill", exact: true }).click();
  assert.equal(
    await card.evaluate((element) => getComputedStyle(element).borderTopLeftRadius),
    "24px",
  );
  await page.getByRole("tab", { name: "Layers", exact: true }).click();
  await select("Card");
  const bindings = page
    .locator("details")
    .filter({ has: page.locator("summary").filter({ hasText: /^Token bindings$/ }) });
  const openBindings = async () => {
    if (!(await bindings.evaluate((element: HTMLDetailsElement) => element.open)))
      await bindings.locator("summary").click();
  };
  await openBindings();
  assert.equal(await selectMenuText(page, "Radius token"), "corner");
  await select("Second card", ["Shift"]);
  await openBindings();
  assert.equal(await selectMenuText(page, "Radius token"), "Mixed");
  await chooseSelectMenu(page, "Radius token", "corner");
  assert.equal(
    await second.evaluate((element) => getComputedStyle(element).borderTopLeftRadius),
    "24px",
  );
  await select("Card");
  await openBindings();
  await set(page, "Width", 320);
  assert.equal(await selectMenuText(page, "Width token"), "Custom");
  await canvas.focus();
  await page.keyboard.press("ControlOrMeta+z");
  await page.waitForFunction(
    () =>
      getComputedStyle(document.querySelector('[data-node-id="token-card"]')!).width === "280px",
  );
  assert.equal(await selectMenuText(page, "Width token"), "card");
  await chooseSelectMenu(page, "Radius token", "Custom");
  assert.equal(
    await card.evaluate((element) => getComputedStyle(element).borderTopLeftRadius),
    "24px",
  );
  await select("Tokens frame");
  await page.getByText("Export", { exact: true }).click();
  const downloads: Record<string, Buffer> = {};
  for (const format of ["svg", "png", "webp"]) {
    const pending = page.waitForEvent("download");
    await page.getByRole("button", { name: format, exact: true }).click();
    downloads[format] = await readFile(await (await pending).path());
  }
  const exported = await sharp(downloads.svg).ensureAlpha().raw().toBuffer();
  const inside = (45 * 500 + 290) * 4;
  const outside = (45 * 500 + 300) * 4;
  assert.ok(Math.abs(exported[inside] - 18) < 8, "SVG retains the resolved 280px card width");
  assert.ok(exported[outside] > 240, "SVG stops the card at its resolved token boundary");
  for (const format of ["png", "webp"]) {
    const metadata = await sharp(downloads[format]).metadata();
    assert.equal(metadata.width, 500);
    assert.equal(metadata.height, 400);
    const pixels = await sharp(downloads[format]).ensureAlpha().raw().toBuffer(),
      offset = (35 * 500 + 35) * 4;
    assert.ok(Math.abs(pixels[offset] - 18) < 8);
    assert.ok(Math.abs(pixels[offset + 2] - 86) < 8);
  }

  console.log(
    "PASS: live token and text-style edits, alias rename/delete, mixed bindings, literal detach, undo, and SVG/PNG/WebP exports.",
  );
});
