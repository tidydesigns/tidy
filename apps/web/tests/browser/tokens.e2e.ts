import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import sharp from "sharp";
import { chooseSelectMenu, selectMenuText } from "../../scripts/select-menu-controls.mjs";
import { test, expect, required } from "./fixtures";
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
  const tokenPanel = page.getByRole("tabpanel", { name: "Tokens", exact: true });
  const editToken = (name: string) =>
    page.getByRole("button", { name: `Edit token ${name}`, exact: true }).click();
  await editToken("rounded");
  await set(tokenPanel, "Value", 24);
  await expect(card).toHaveCSS("border-top-left-radius", "24px");
  await expect(page.getByRole("button", { name: "Edit token rounded", exact: true })).toHaveText(
    "rounded24",
  );
  await expect(second).toHaveCSS("border-top-left-radius", "0px");
  await editToken("body");
  await set(tokenPanel, "Font size", 22);
  await expect(text).toHaveCSS("font-size", "22px");
  await editToken("rounded");
  const rename = tokenPanel.getByRole("textbox", { name: "Name", exact: true });
  await rename.fill("pill");
  await rename.press("Enter");
  const aliasRow = page.getByRole("button", { name: "Edit token corner", exact: true });
  await expect(aliasRow).toHaveAttribute("title", "corner → pill");
  await page.getByRole("button", { name: "Remove token pill", exact: true }).click();
  await expect(page.getByRole("button", { name: "Edit token pill", exact: true })).toHaveCount(0);
  await expect(aliasRow).toHaveText("corner24");
  await expect(page.getByRole("button", { name: "Search tokens", exact: true })).toBeFocused();
  assert.equal(
    await card.evaluate((element) => getComputedStyle(element).borderTopLeftRadius),
    "24px",
  );
  await page.getByRole("tab", { name: "Layers", exact: true }).click();
  await select("Card");
  const bindings = page
    .locator("details")
    .filter({ has: page.locator(":scope > summary").filter({ hasText: /^Token bindings$/ }) });
  const openBindings = async () => {
    const advanced = page
      .getByLabel("Inspector", { exact: true })
      .locator("details")
      .filter({ has: page.locator("summary").filter({ hasText: /^Advanced$/ }) });
    if (!(await advanced.evaluate((element: HTMLDetailsElement) => element.open)))
      await advanced.locator(":scope > summary").click();
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

test("read-only tokens remain browsable without exposing mutation actions", async ({ page }) => {
  await page.goto("/dev/import-preview?tokens=1&viewer=1");
  await page.getByRole("tab", { name: "Tokens", exact: true }).click();
  const panel = page.getByRole("tabpanel", { name: "Tokens", exact: true });
  await expect(panel.getByRole("button", { name: "Add token", exact: true })).toHaveCount(0);
  await panel.getByRole("button", { name: "Edit token rounded", exact: true }).click();
  await expect(panel.getByRole("spinbutton", { name: "Value", exact: true })).toBeDisabled();
  await expect(
    panel.getByRole("button", { name: "Remove token rounded", exact: true }),
  ).toHaveCount(0);
  await panel.getByRole("button", { name: "Search tokens", exact: true }).click();
  await panel.getByRole("searchbox", { name: "Find tokens", exact: true }).fill("body");
  await expect(panel.getByRole("button", { name: "Edit token body", exact: true })).toBeVisible();
  await expect(panel.getByRole("button", { name: /^Edit token / })).toHaveCount(1);
});

test("adding a token reveals a collapsed group and keeps rename validation local", async ({
  page,
}) => {
  await page.goto("/dev/import-preview?edit=1&tokens=1");
  await page.getByRole("tab", { name: "Tokens", exact: true }).click();
  const panel = page.getByRole("tabpanel", { name: "Tokens", exact: true });
  await panel
    .locator("summary")
    .filter({ hasText: /^Radius$/ })
    .click();
  await expect(panel.getByRole("button", { name: "Edit token rounded", exact: true })).toBeHidden();
  await panel.getByRole("button", { name: "Add token", exact: true }).click();
  await page.getByRole("menuitem", { name: "Radius", exact: true }).click();
  await expect(
    panel.getByRole("button", { name: "Edit token radius", exact: true }),
  ).toHaveAttribute("aria-expanded", "true");
  const name = panel.getByRole("textbox", { name: "Name", exact: true });
  await name.fill("rounded");
  await name.press("Enter");
  await expect(panel.getByRole("alert")).toHaveText("A token with that name already exists.");
  await name.fill("radius-card");
  await name.press("Enter");
  await expect(
    panel.getByRole("button", { name: "Edit token radius-card", exact: true }),
  ).toHaveAttribute("aria-expanded", "true");
  await expect(panel.getByRole("spinbutton", { name: "Value", exact: true })).toHaveValue("8");
});

test("token popovers keep rows stable, commit click-away edits, and fit small viewports", async ({
  page,
}) => {
  await page.goto("/dev/import-preview?edit=1&tokens=1");
  await page.getByRole("tab", { name: "Tokens", exact: true }).click();
  const rounded = page.getByRole("button", { name: "Edit token rounded", exact: true });
  const rowBefore = await rounded.boundingBox();
  await rounded.click();
  const popup = page.getByRole("dialog", { name: "Radius token", exact: true });
  await expect(popup).toBeVisible();
  expect(await rounded.boundingBox()).toEqual(rowBefore);
  const name = popup.getByRole("textbox", { name: "Name", exact: true });
  await name.fill("radius-card");
  await page.getByRole("button", { name: "Edit token body", exact: true }).click();
  const textPopup = page.getByRole("dialog", { name: "Text styles token", exact: true });
  await expect(textPopup).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(1);
  await expect(
    page.getByRole("button", { name: "Edit token radius-card", exact: true }),
  ).toBeVisible();
  await page.setViewportSize({ width: 768, height: 480 });
  const bounds = await textPopup.boundingBox();
  assert.ok(
    bounds &&
      bounds.x >= 0 &&
      bounds.y >= 0 &&
      bounds.x + bounds.width <= 768 &&
      bounds.y + bounds.height <= 480,
  );
  await textPopup.getByRole("combobox", { name: "Font family", exact: true }).click();
  await page.getByRole("textbox", { name: "Search fonts", exact: true }).fill("Arial");
  await page.getByRole("option", { name: "Arial", exact: true }).click();
  await expect(textPopup).toBeVisible();
  await expect(page.locator('[data-node-id="token-label"]')).toHaveCSS(
    "font-family",
    "Arial, system-ui",
  );
  await textPopup.getByRole("button", { name: "Close token editor", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("button", { name: "Edit token radius-card", exact: true }).click();
  await page.getByRole("dialog").getByRole("spinbutton", { name: "Value", exact: true }).fill("28");
  await page.getByRole("button", { name: "Search tokens", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.locator('[data-node-id="token-card"]')).toHaveCSS(
    "border-top-left-radius",
    "28px",
  );
  const trigger = page.getByRole("button", { name: "Edit token radius-card", exact: true });
  await trigger.click();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(trigger).toBeFocused();
});

test("detaching paint tokens keeps resolved colors and alpha for fills, strokes and gradient stops", async ({
  page,
}) => {
  await page.goto("/dev/import-preview?edit=1&tokens=1");
  await page.getByRole("tab", { name: "Tokens", exact: true }).click();
  await page.getByRole("button", { name: "Add token", exact: true }).click();
  await page.getByRole("menuitem", { name: "Color", exact: true }).click();
  const color = page.getByRole("textbox", { name: "Color", exact: true });
  await color.fill("#22735980");
  await color.press("Enter");
  await page.keyboard.press("Escape");
  await page.getByRole("tab", { name: "Layers", exact: true }).click();
  await page.getByRole("button", { name: "Select Card", exact: true }).first().click();
  const card = page.locator('[data-node-id="token-card"]');
  await page.getByRole("button", { name: "Edit fill 1", exact: true }).click();
  await chooseSelectMenu(page, "Fill token", "color");
  const boundFill = await card.evaluate((node) => getComputedStyle(node).backgroundColor);
  expect(boundFill).toMatch(/^rgba\(34, 115, 89, 0\.5/);
  await chooseSelectMenu(page, "Fill token", "No token");
  await expect(card).toHaveCSS("background-color", boundFill);
  await page.getByLabel("Design canvas", { exact: true }).focus();
  await page.keyboard.press("ControlOrMeta+z");
  expect(await selectMenuText(page, "Fill token")).toBe("color");
  await page.keyboard.press("ControlOrMeta+Shift+z");
  expect(await selectMenuText(page, "Fill token")).toBe("No token");

  await page
    .locator("summary")
    .filter({ hasText: /^Add appearance$/ })
    .click();
  await page.getByRole("button", { name: "Add stroke", exact: true }).click();
  await chooseSelectMenu(page, "Stroke token", "color");
  const boundStroke = await card.evaluate((node) => getComputedStyle(node).borderImageSource);
  expect(decodeURIComponent(boundStroke)).toContain("#22735980");
  await chooseSelectMenu(page, "Stroke token", "No token");
  await expect(card).toHaveCSS("border-image-source", boundStroke);

  await chooseSelectMenu(page, "Fill type", "Linear gradient");
  await chooseSelectMenu(page, "Stop 1 token", "color");
  const boundGradient = await card.evaluate((node) => getComputedStyle(node).backgroundImage);
  expect(boundGradient).toContain("rgba(34, 115, 89");
  await chooseSelectMenu(page, "Stop 1 token", "No token");
  await expect(card).toHaveCSS("background-image", boundGradient);
  await page.getByRole("tab", { name: "Tokens", exact: true }).click();
  await page.getByRole("button", { name: "Edit token color", exact: true }).click();
  await color.fill("#cc6699");
  await color.press("Enter");
  await expect(card).toHaveCSS("background-image", boundGradient);
  await expect(card).toHaveCSS("border-image-source", boundStroke);
});

test("picking an unselected layer copies alpha, blocks dragging and Delete, and preserves selection", async ({
  page,
}) => {
  await page.addInitScript(() => Reflect.deleteProperty(window, "EyeDropper"));
  await page.goto("/dev/import-preview?edit=1&tokens=1");
  await page.getByRole("button", { name: "Select Card", exact: true }).first().click();
  await page.getByRole("button", { name: "Edit fill 1", exact: true }).click();
  const fill = page.getByRole("textbox", { name: "Fill color", exact: true });
  await fill.fill("#22735980");
  await fill.press("Enter");
  const card = page.locator('[data-node-id="token-card"]');
  const before = required(await card.boundingBox());
  await page.getByRole("button", { name: "Select Second card", exact: true }).first().click();
  const selectedName = page.getByRole("textbox", { name: "Layer name", exact: true });
  await expect(selectedName).toHaveValue("Second card");
  const second = page.locator('[data-node-id="token-second"]');
  const selectedBefore = required(await second.boundingBox());
  await page.getByRole("tab", { name: "Tokens", exact: true }).click();
  await page.getByRole("button", { name: "Add token", exact: true }).click();
  await page.getByRole("menuitem", { name: "Color", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Color token", exact: true });
  const value = page.getByRole("textbox", { name: "Color", exact: true });
  await page.getByRole("button", { name: "Open color palette", exact: true }).click();
  await page.getByRole("button", { name: "Pick from canvas", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(card).toHaveCSS("cursor", "crosshair");
  await page.keyboard.press("Delete");
  await expect(card).toBeVisible();
  await page.mouse.move(before.x + 20, before.y + 20);
  await page.mouse.down();
  await page.mouse.move(before.x + 45, before.y + 35, { steps: 5 });
  await page.mouse.up();
  await expect(dialog).toBeVisible();
  await expect(value).toHaveValue("#22735980");
  await expect(selectedName).toHaveValue("Second card");
  expect(await card.boundingBox()).toEqual(before);
  expect(await second.boundingBox()).toEqual(selectedBefore);
  await page.getByLabel("Design canvas", { exact: true }).focus();
  await page.keyboard.press("ControlOrMeta+z");
  await expect(value).toHaveValue("#ff5d00");
  await page.keyboard.press("ControlOrMeta+Shift+z");
  await expect(value).toHaveValue("#22735980");
});

test("canvas color picking handles empty space, gradients and cancellation without editing", async ({
  page,
}) => {
  await page.goto("/dev/import-preview?edit=1&tokens=1");
  await page.getByRole("button", { name: "Select Card", exact: true }).first().click();
  await page.getByRole("button", { name: "Edit fill 1", exact: true }).click();
  await chooseSelectMenu(page, "Fill type", "Linear gradient");
  await page.getByRole("tab", { name: "Tokens", exact: true }).click();
  await page.getByRole("button", { name: "Add token", exact: true }).click();
  await page.getByRole("menuitem", { name: "Color", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Color token", exact: true });
  const start = async () => {
    await page.getByRole("button", { name: "Open color palette", exact: true }).click();
    await page.getByRole("button", { name: "Pick from canvas", exact: true }).click();
  };
  await start();
  await page.getByLabel("Design canvas", { exact: true }).click({ position: { x: 800, y: 700 } });
  await expect(page.getByRole("status").filter({ hasText: "No solid colour here" })).toBeVisible();
  await page.locator('[data-node-id="token-card"]').click();
  await expect(dialog).toBeHidden();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeVisible();
  await expect(page.getByRole("button", { name: "Open color palette", exact: true })).toBeFocused();
  await expect(page.getByRole("textbox", { name: "Color", exact: true })).toHaveValue("#ff5d00");
  await start();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Color", exact: true })).toHaveValue("#ff5d00");
  await start();
  await page.locator('[data-node-id="token-label"]').click();
  await expect(dialog).toBeVisible();
  const inheritedText = await page
    .locator('[data-node-id="token-label"]')
    .evaluate((node) => getComputedStyle(node).color);
  const pickedText = await page
    .getByRole("textbox", { name: "Color", exact: true })
    .evaluate((input) => {
      if (!(input instanceof HTMLInputElement)) throw new Error("Expected a colour input");
      const probe = document.createElement("span");
      probe.style.color = input.value;
      if (!probe.style.color) throw new Error("Picked token must contain a valid CSS colour");
      document.body.appendChild(probe);
      const color = getComputedStyle(probe).color;
      probe.remove();
      return color;
    });
  expect(pickedText).toBe(inheritedText);
});

test("filtering out the active token still allows click-away dismissal", async ({ page }) => {
  await page.goto("/dev/import-preview?edit=1&tokens=1");
  await page.getByRole("tab", { name: "Tokens", exact: true }).click();
  await page.getByRole("button", { name: "Search tokens", exact: true }).click();
  await page.getByRole("button", { name: "Edit token rounded", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Radius token", exact: true });
  await expect(dialog).toBeVisible();
  await page.getByRole("searchbox", { name: "Find tokens", exact: true }).fill("body");
  await expect(page.getByRole("button", { name: "Edit token rounded", exact: true })).toHaveCount(
    0,
  );
  await expect(dialog).toBeVisible();
  await page.getByLabel("Design canvas", { exact: true }).click({ position: { x: 800, y: 700 } });
  await expect(dialog).toHaveCount(0);
});

test("canvas picking skips an unpainted container and uses the filled parent", async ({ page }) => {
  await page.goto("/dev/import-preview?edit=1&tokens=1");
  await page.getByRole("button", { name: "Select Tokens frame", exact: true }).first().click();
  await page.getByRole("button", { name: "Edit fill 1", exact: true }).click();
  const fill = page.getByRole("textbox", { name: "Fill color", exact: true });
  await fill.fill("#227359");
  await fill.press("Enter");
  await page.getByRole("button", { name: "Select Card", exact: true }).first().click();
  const editFill = page.getByRole("button", { name: "Edit fill 1", exact: true });
  if ((await editFill.getAttribute("aria-expanded")) !== "true") await editFill.click();
  await page.getByRole("button", { name: "Remove fill", exact: true }).click();
  const card = page.locator('[data-node-id="token-card"]');
  await expect(card).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await page.getByRole("tab", { name: "Tokens", exact: true }).click();
  await page.getByRole("button", { name: "Add token", exact: true }).click();
  await page.getByRole("menuitem", { name: "Color", exact: true }).click();
  await page.getByRole("button", { name: "Open color palette", exact: true }).click();
  await page.getByRole("button", { name: "Pick from canvas", exact: true }).click();
  await card.click({ position: { x: 20, y: 20 } });
  await expect(page.getByRole("dialog", { name: "Color token", exact: true })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Color", exact: true })).toHaveValue("#227359");
});
