import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import sharp from "sharp";
import { chooseSelectMenu, selectMenuText } from "../../scripts/select-menu-controls.mjs";
import { test, expect } from "./fixtures";
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
  await expect(second).toHaveCSS("border-top-left-radius", "0px");
  await editToken("body");
  await set(tokenPanel, "Font size", 22);
  await expect(text).toHaveCSS("font-size", "22px");
  await editToken("rounded");
  const rename = tokenPanel.getByRole("textbox", { name: "Name", exact: true });
  await rename.fill("pill");
  await rename.press("Enter");
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

test("design requests carry selection or page scope without creating tokens prematurely", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/dev/import-preview?edit=1&tokens=1");
  await page.getByRole("button", { name: "Select Card", exact: true }).first().click();
  await page.getByRole("tab", { name: "Tokens", exact: true }).click();
  const panel = page.getByRole("tabpanel", { name: "Tokens", exact: true });
  await panel.getByRole("button", { name: "Add token", exact: true }).click();
  await page.getByRole("menuitem", { name: "From design…", exact: true }).click();
  await expect(
    panel.getByRole("button", { name: "Color source: Selection and children", exact: true }),
  ).toBeVisible();
  await panel.getByRole("button", { name: "Copy agent request", exact: true }).click();
  await expect(panel.getByRole("button", { name: "Copied request", exact: true })).toBeVisible();
  const selected = await page.evaluate(() => navigator.clipboard.readText());
  expect(selected).toContain('"selected_node_ids":["token-card"]');
  await chooseSelectMenu(page, "Color source", "Current page");
  await panel.getByRole("button", { name: "Copy agent request", exact: true }).click();
  const wholePage = await page.evaluate(() => navigator.clipboard.readText());
  expect(wholePage).toContain('"page_id":"page-1","selected_node_ids":[]');
  expect(wholePage).toContain("Preserve all current colors and alpha values");
  await panel.getByText("View request", { exact: true }).click();
  await expect(panel.getByRole("textbox", { name: "Agent request", exact: true })).toHaveValue(
    wholePage,
  );
  await expect(panel.getByRole("button", { name: /^Edit token / })).toHaveCount(5);
  await page.evaluate(() =>
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async () => {
          throw new Error("Clipboard unavailable");
        },
      },
    }),
  );
  await panel.getByRole("button", { name: "Copied request", exact: true }).click();
  await expect(panel.getByRole("alert")).toContainText("copy it manually");
  await panel.getByRole("button", { name: "Close colors from design", exact: true }).click();
  await expect(panel.getByRole("region", { name: "Colors from design" })).toHaveCount(0);
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
  // The existing font picker must remain above, and inside, the floating editor.
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

test("from design opens a scoped agent draft and submits only on request", async ({ page }) => {
  let submission: unknown;
  await page.route("**/api/agents/threads**", async (route) => {
    if (route.request().method() === "POST") {
      submission = route.request().postDataJSON();
      await route.fulfill({ status: 503, json: { error: "Local transport fixture" } });
    } else await route.fulfill({ json: { threads: [], hasMore: false } });
  });
  await page.goto("/dev/import-preview?edit=1&tokens=1&agentTokens=1");
  await page.getByRole("button", { name: "Select Card", exact: true }).first().click();
  await page.getByRole("tab", { name: "Tokens", exact: true }).click();
  await page.getByRole("button", { name: "Add token", exact: true }).click();
  await page.getByRole("menuitem", { name: "From design…", exact: true }).click();
  await page.getByRole("button", { name: "Ask agent…", exact: true }).click();
  const composer = page.getByRole("textbox", { name: "Describe the design work", exact: true });
  await expect(composer).toHaveValue(/"selected_node_ids":\["token-card"\]/);
  expect(submission).toBeUndefined();
  await composer.fill("Create and link the palette from this selected card.");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect
    .poll(() => submission)
    .toMatchObject({
      prompt: "Create and link the palette from this selected card.",
      files: [{ id: "preview", selectedNodeIds: ["token-card"] }],
      agentLimit: 1,
    });
  await expect(composer).toHaveValue("Create and link the palette from this selected card.");
});
