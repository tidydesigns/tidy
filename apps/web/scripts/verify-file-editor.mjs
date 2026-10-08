import { artifactPath } from "./artifact-path.mjs";
import { chooseSelectMenu, selectMenuText } from "./select-menu-controls.mjs";
// Local development fixture only: no authentication or production writes.
// PLAYWRIGHT_MODULE can point to an isolated Playwright installation.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const snapBypass = process.platform === "darwin" ? "Meta" : "Control";
const baseUrl = process.env.EDITOR_TEST_URL || "http://127.0.0.1:3107";
const browser = await chromium.launch({ headless: true, args: ["--no-proxy-server"] });
async function appearanceAndWorkflow(browser) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    permissions: ["clipboard-read", "clipboard-write"],
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${baseUrl}/dev/import-preview?edit=1`, { waitUntil: "load" });
  await page.getByRole("tree", { name: "Layers" }).waitFor();
  const canvas = page.getByLabel("Design canvas", { exact: true });
  const email = page.locator('[data-node-id="desktop-email-input"]');
  const password = page.locator('[data-node-id="desktop-password-input"]');
  await page.locator('[data-node-id="desktop-email-placeholder"]').click({ button: "right" });
  await page.getByRole("menuitem", { name: /Select behind \d+: Email input/ }).click();
  assert.equal(await email.getAttribute("data-selected"), "true");
  await page.getByRole("button", { name: "Select Email input", exact: true }).first().click();
  await page.getByRole("spinbutton", { name: "Radius", exact: true }).fill("16");
  await page.getByRole("spinbutton", { name: "Radius", exact: true }).press("Enter");
  assert.equal(await email.evaluate((el) => el.style.borderTopLeftRadius), "16px");
  await page.getByRole("button", { name: "Independent corner radii", exact: true }).click();
  await page.getByRole("spinbutton", { name: "Top left radius", exact: true }).fill("24");
  await page.getByRole("spinbutton", { name: "Top left radius", exact: true }).press("Enter");
  assert.equal(await email.evaluate((el) => el.style.borderTopLeftRadius), "24px");
  await page.getByRole("spinbutton", { name: "Bottom left radius", exact: true }).fill("0");
  await page.getByRole("spinbutton", { name: "Bottom left radius", exact: true }).press("Enter");
  assert.equal(await email.evaluate((el) => el.style.borderBottomLeftRadius), "0px");
  await page.getByRole("button", { name: "Independent border widths", exact: true }).click();
  await page.getByRole("spinbutton", { name: "Border bottom", exact: true }).fill("3");
  await page.getByRole("spinbutton", { name: "Border bottom", exact: true }).press("Enter");
  assert.equal(await email.evaluate((el) => el.style.borderBottomWidth), "3px");
  await page.screenshot({ path: artifactPath("bella-editor-inspector.png") });
  await page
    .getByRole("button", { name: "Select Password input", exact: true })
    .first()
    .click({ modifiers: ["Shift"] });
  await page.getByRole("textbox", { name: "Fill color", exact: true }).fill("#233445");
  await page.getByRole("textbox", { name: "Fill color", exact: true }).press("Enter");
  assert.equal(await email.evaluate((el) => el.style.background), "rgb(35, 52, 69)");
  assert.equal(await password.evaluate((el) => el.style.background), "rgb(35, 52, 69)");
  const beforeX = await email.evaluate((el) => parseFloat(el.style.left));
  await canvas.focus();
  await page.keyboard.press("ArrowRight");
  assert.equal(await email.evaluate((el) => parseFloat(el.style.left)), beforeX + 1);
  const count = await page.locator("[data-node-id]").count();
  await page.keyboard.press("Meta+d");
  await page.waitForFunction(
    (count) => document.querySelectorAll("[data-node-id]").length === count + 2,
    count,
  );
  await page.keyboard.press("Meta+z");
  await page.waitForFunction(
    (count) => document.querySelectorAll("[data-node-id]").length === count,
    count,
  );
  await page.keyboard.press("Meta+Shift+z");
  await page.waitForFunction(
    (count) => document.querySelectorAll("[data-node-id]").length === count + 2,
    count,
  );
  await page.keyboard.press("Meta+c");
  await page.keyboard.press("Meta+v");
  await page.waitForFunction(
    (count) => document.querySelectorAll("[data-node-id]").length === count + 4,
    count,
  );
  await page.getByRole("button", { name: "Select Email input", exact: true }).first().click();
  const originalBounds = await email.boundingBox();
  await canvas.focus();
  await page.keyboard.press("Meta+c");
  await page.keyboard.press("Meta+Shift+v");
  await page.waitForFunction(
    (count) => document.querySelectorAll("[data-node-id]").length === count + 5,
    count,
  );
  const inPlaceBounds = await page
    .locator('[data-node-id][data-selected="true"]')
    .first()
    .boundingBox();
  for (const edge of ["x", "y", "width", "height"])
    assert.ok(Math.abs(inPlaceBounds[edge] - originalBounds[edge]) < 1, `paste in place ${edge}`);
  await page.keyboard.press("Meta+x");
  await page.waitForFunction(
    (count) => document.querySelectorAll("[data-node-id]").length === count + 4,
    count,
  );
  await page.keyboard.press("Meta+z");
  await page.waitForFunction(
    (count) => document.querySelectorAll("[data-node-id]").length === count + 5,
    count,
  );
  await page.getByRole("tab", { name: "Tokens", exact: true }).click();
  await page.getByRole("button", { name: "+ Color token", exact: true }).click();
  await page.getByRole("textbox", { name: "Token name", exact: true }).fill("accent");
  await page.getByRole("textbox", { name: "Token name", exact: true }).press("Enter");
  await page.getByRole("textbox", { name: "Color", exact: true }).fill("#ff0000");
  await page.getByRole("textbox", { name: "Color", exact: true }).press("Enter");
  await page.getByRole("tab", { name: "Layers", exact: true }).click();
  await page.getByRole("button", { name: "Select Email input", exact: true }).first().click();
  await chooseSelectMenu(page, "Fill token", "accent");
  assert.equal(await email.evaluate((el) => el.style.background), "rgb(255, 0, 0)");
  await page.getByRole("tab", { name: "Tokens", exact: true }).click();
  await page.getByRole("button", { name: "Remove token accent", exact: true }).click();
  assert.equal(await email.evaluate((el) => el.style.background), "rgb(255, 0, 0)");
  await page.getByRole("tab", { name: "Layers", exact: true }).click();
  await page.getByRole("button", { name: "Lock Email input", exact: true }).first().click();
  assert.equal(await page.getByLabel("Inspector", { exact: true }).count(), 0);
  await page.getByRole("button", { name: "Unlock Email input", exact: true }).first().click();
  await page.getByRole("button", { name: "Collapse Desktop 1440 · /login", exact: true }).click();
  assert.equal(
    await page.getByRole("button", { name: "Select Email input", exact: true }).count(),
    1,
  );
  await page.getByRole("button", { name: "Expand Desktop 1440 · /login", exact: true }).click();
  await page.screenshot({ path: artifactPath("bella-editor-verified.png") });
  assert.deepEqual(errors, []);
  console.log(
    "PASS: overlap chooser, corners, borders, selection fill/nudge/duplicate, undo/redo, nested paste in place, cut, token lifecycle, locks, instant tree disclosure; no page errors",
  );

  await page.close();
}

async function clipboardAcrossPages(browser) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    permissions: ["clipboard-read", "clipboard-write"],
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${baseUrl}/dev/import-preview?edit=1`, { waitUntil: "load" });
  const source = page.locator('[data-node-id="desktop-email-input"]');
  await page.getByRole("button", { name: "Select Email input", exact: true }).first().click();
  const position = await source.evaluate((element) => {
    let x = 0,
      y = 0;
    for (
      let current = element;
      current?.hasAttribute("data-node-id");
      current = current.parentElement?.closest("[data-node-id]")
    ) {
      x += parseFloat(current.style.left) || 0;
      y += parseFloat(current.style.top) || 0;
    }
    return { x, y };
  });
  await page.getByLabel("Design canvas", { exact: true }).focus();
  await page.keyboard.press("Meta+c");
  await page.getByRole("button", { name: "Add page", exact: true }).click();
  await page.getByRole("textbox", { name: "Page name", exact: true }).fill("Clipboard destination");
  await page.getByRole("textbox", { name: "Page name", exact: true }).press("Enter");
  assert.equal(await page.locator("[data-node-id]").count(), 0);
  await page.getByLabel("Design canvas", { exact: true }).focus();
  await page.keyboard.press("Meta+Shift+v");
  const pasted = page.locator('[data-node-id][data-selected="true"]');
  await pasted.waitFor();
  assert.equal(await pasted.count(), 1);
  const pastedPosition = await pasted.evaluate((element) => ({
    x: parseFloat(element.style.left),
    y: parseFloat(element.style.top),
  }));
  assert.deepEqual(pastedPosition, position);
  await page.keyboard.press("Meta+z");
  await page.waitForFunction(() => document.querySelectorAll("[data-node-id]").length === 0);
  await page.keyboard.press("Meta+Shift+z");
  await pasted.waitFor();
  assert.deepEqual(
    await pasted.evaluate((element) => ({
      x: parseFloat(element.style.left),
      y: parseFloat(element.style.top),
    })),
    position,
  );
  assert.deepEqual(errors, []);
  console.log(
    "PASS: nested cross-page paste in place preserves canvas position and undoes/redoes in one step; no page errors",
  );
  await context.close();
}

async function treeAndLocks(browser) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    permissions: ["clipboard-read", "clipboard-write"],
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${baseUrl}/dev/import-preview?edit=1`, { waitUntil: "load" });
  const email = page.locator('[data-node-id="desktop-email-input"]');
  const emailButton = page.getByRole("button", { name: "Select Email input", exact: true }).first();
  const passwordButton = page
    .getByRole("button", { name: "Select Password input", exact: true })
    .first();
  const before = await page.locator("[data-node-id]").count();
  await page
    .getByRole("button", { name: "Lock Authentication panel", exact: true })
    .first()
    .click();
  await emailButton.click();
  await emailButton.click({ button: "right" });
  assert.equal(
    await page.getByRole("menuitem", { name: "Delete", exact: true }).isDisabled(),
    true,
  );
  await page.keyboard.press("Escape");
  await page.getByLabel("Design canvas", { exact: true }).focus();
  await page.keyboard.press("Meta+x");
  assert.equal(await page.locator("[data-node-id]").count(), before);
  assert.match(
    await page.getByRole("alert").filter({ hasText: "Unlock selected layers" }).textContent(),
    /Unlock selected layers/,
  );
  await page
    .getByRole("button", { name: "Unlock Authentication panel", exact: true })
    .first()
    .click();
  await page
    .getByRole("button", { name: "Hide Authentication panel", exact: true })
    .first()
    .click();
  assert.equal(await email.count(), 0);
  assert.match(await emailButton.locator("..").getAttribute("class"), /text-secondary-ink/);
  await page
    .getByRole("button", { name: "Show Authentication panel", exact: true })
    .first()
    .click();
  await email.waitFor();
  const emailRow = emailButton.locator("..");
  const passwordRow = passwordButton.locator("..");
  const target = await passwordRow.boundingBox();
  assert.ok(target);
  await emailRow.dragTo(passwordRow, { targetPosition: { x: 20, y: target.height - 2 } });
  const passwordBeforeEmail = () =>
    page.evaluate(() => {
      const buttons = [...document.querySelectorAll("button[aria-label]")];
      const a = buttons.find(
        (button) => button.getAttribute("aria-label") === "Select Email input",
      );
      const b = buttons.find(
        (button) => button.getAttribute("aria-label") === "Select Password input",
      );
      return Boolean(b.compareDocumentPosition(a) & Node.DOCUMENT_POSITION_FOLLOWING);
    });
  assert.equal(await passwordBeforeEmail(), true);
  await page.getByLabel("Design canvas", { exact: true }).focus();
  await page.keyboard.press("Meta+z");
  assert.equal(await passwordBeforeEmail(), false);
  const beforeParent = await email.evaluate((element) =>
    element.parentElement?.closest("[data-node-id]")?.getAttribute("data-node-id"),
  );
  const beforeBounds = await email.boundingBox();
  await emailRow.dragTo(passwordRow, { targetPosition: { x: 20, y: target.height / 2 } });
  assert.equal(
    await email.evaluate((element) =>
      element.parentElement?.closest("[data-node-id]")?.getAttribute("data-node-id"),
    ),
    "desktop-password-input",
  );
  const afterBounds = await email.boundingBox();
  for (const edge of ["x", "y"])
    assert.ok(Math.abs(afterBounds[edge] - beforeBounds[edge]) < 1, `reparent ${edge}`);
  await page.getByLabel("Design canvas", { exact: true }).focus();
  await page.keyboard.press("Meta+z");
  assert.equal(
    await email.evaluate((element) =>
      element.parentElement?.closest("[data-node-id]")?.getAttribute("data-node-id"),
    ),
    beforeParent,
  );
  await emailButton.click();
  await page.getByLabel("Design canvas", { exact: true }).focus();
  await page.keyboard.press("Tab");
  assert.notEqual(await email.getAttribute("data-selected"), "true");
  await page.keyboard.press("Shift+Tab");
  assert.equal(await email.getAttribute("data-selected"), "true");
  await page.keyboard.press("Escape");
  assert.equal(
    await page.locator('[data-node-id="desktop-panel"]').getAttribute("data-selected"),
    "true",
  );
  assert.deepEqual(errors, []);
  console.log(
    "PASS: inherited lock and visibility, guarded cut/menu, tree drag reorder/reparent, hierarchy keys, and one-step undo; no page errors",
  );
  await context.close();
}

async function clipboardAcrossFiles(browser) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    permissions: ["clipboard-read", "clipboard-write"],
  });
  const source = await context.newPage();
  const target = await context.newPage();
  const errors = [];
  source.on("pageerror", (error) => errors.push(error.message));
  target.on("pageerror", (error) => errors.push(error.message));
  await source.goto(`${baseUrl}/dev/import-preview?edit=1&file=clipboard-source`, {
    waitUntil: "load",
  });
  await target.goto(`${baseUrl}/dev/import-preview?edit=1&file=clipboard-target`, {
    waitUntil: "load",
  });
  await source.getByRole("button", { name: "Select Email input", exact: true }).first().click();
  await source.getByRole("spinbutton", { name: "Radius", exact: true }).fill("27");
  await source.getByRole("spinbutton", { name: "Radius", exact: true }).press("Enter");
  await source.getByLabel("Design canvas", { exact: true }).focus();
  await source.keyboard.press("Alt+Meta+c");
  await target.getByRole("button", { name: "Select Password input", exact: true }).first().click();
  const password = target.locator('[data-node-id="desktop-password-input"]');
  const originalRadius = await password.evaluate((element) => element.style.borderTopLeftRadius);
  await target.getByLabel("Design canvas", { exact: true }).focus();
  await target.keyboard.press("Alt+Meta+v");
  await target.waitForFunction(
    () =>
      document.querySelector('[data-node-id="desktop-password-input"]')?.style
        .borderTopLeftRadius === "27px",
  );
  await target.keyboard.press("Meta+z");
  await target.waitForFunction(
    (radius) =>
      document.querySelector('[data-node-id="desktop-password-input"]')?.style
        .borderTopLeftRadius === radius,
    originalRadius,
  );
  await source.getByLabel("Design canvas", { exact: true }).focus();
  await source.keyboard.press("Meta+c");
  const count = await target.locator("[data-node-id]").count();
  await target
    .getByRole("button", { name: "Select Desktop 1440 · /login", exact: true })
    .first()
    .click();
  await target.getByLabel("Design canvas", { exact: true }).focus();
  await target.keyboard.press("Meta+Shift+v");
  await target.waitForFunction(
    (before) => document.querySelectorAll("[data-node-id]").length === before + 1,
    count,
  );
  assert.equal(await target.locator('[data-node-id][data-selected="true"]').count(), 1);
  await target.keyboard.press("Meta+z");
  await target.waitForFunction(
    (before) => document.querySelectorAll("[data-node-id]").length === before,
    count,
  );
  const sourceCount = await source.locator("[data-node-id]").count();
  await source.getByLabel("Design canvas", { exact: true }).focus();
  await source.keyboard.press("Meta+x");
  await source.waitForFunction(
    (before) => document.querySelectorAll("[data-node-id]").length < before,
    sourceCount,
  );
  await target.getByLabel("Design canvas", { exact: true }).focus();
  await target.keyboard.press("Meta+Shift+v");
  await target.waitForFunction(
    (before) => document.querySelectorAll("[data-node-id]").length > before,
    count,
  );
  await target.keyboard.press("Meta+z");
  await target.waitForFunction(
    (before) => document.querySelectorAll("[data-node-id]").length === before,
    count,
  );
  await source.keyboard.press("Meta+z");
  await source.waitForFunction(
    (before) => document.querySelectorAll("[data-node-id]").length === before,
    sourceCount,
  );
  assert.deepEqual(errors, []);
  console.log(
    "PASS: cross-file appearance, copy and cut/paste, selection, and one-step undo; no page errors",
  );
  await context.close();
}

async function nestedMixedSelection(browser) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${baseUrl}/dev/import-preview?edit=1`, { waitUntil: "load" });
  await page
    .getByRole("button", { name: "Select Authentication panel", exact: true })
    .first()
    .click();
  await page.getByRole("spinbutton", { name: "Rotation", exact: true }).fill("30");
  await page.getByRole("spinbutton", { name: "Rotation", exact: true }).press("Enter");
  const email = page.locator('[data-node-id="desktop-email-input"]');
  const password = page.locator('[data-node-id="desktop-password-input"]');
  await page.getByRole("button", { name: "Select Email input", exact: true }).first().click();
  await page
    .getByRole("button", { name: "Select Password input", exact: true })
    .first()
    .click({ modifiers: ["Shift"] });
  const before = [await email.boundingBox(), await password.boundingBox()];
  await page.getByLabel("Design canvas", { exact: true }).focus();
  await page.keyboard.press("ArrowRight");
  const moved = [await email.boundingBox(), await password.boundingBox()];
  for (let index = 0; index < 2; index++) {
    assert.ok(moved[index].x > before[index].x, `rotated child ${index} moved right`);
    assert.ok(
      Math.abs(moved[index].y - before[index].y) < 0.1,
      `rotated child ${index} kept its screen Y`,
    );
  }
  await page.keyboard.press("Meta+z");
  const restored = [await email.boundingBox(), await password.boundingBox()];
  for (let index = 0; index < 2; index++) {
    assert.ok(Math.abs(restored[index].x - before[index].x) < 0.1);
    assert.ok(Math.abs(restored[index].y - before[index].y) < 0.1);
  }
  await page
    .getByRole("button", { name: "Select Welcome heading", exact: true })
    .first()
    .click({ modifiers: ["Shift"] });
  await page
    .getByRole("button", { name: "Select Password input", exact: true })
    .first()
    .click({ modifiers: ["Shift"] });
  const heading = page.locator('[data-node-id="desktop-heading"]');
  await page.getByRole("spinbutton", { name: "Opacity %", exact: true }).fill("55");
  await page.getByRole("spinbutton", { name: "Opacity %", exact: true }).press("Enter");
  assert.equal(await email.evaluate((element) => element.style.opacity), "0.55");
  assert.equal(await heading.evaluate((element) => element.style.opacity), "0.55");
  await page.getByLabel("Design canvas", { exact: true }).focus();
  await page.keyboard.press("Meta+z");
  assert.notEqual(await email.evaluate((element) => element.style.opacity), "0.55");
  assert.notEqual(await heading.evaluate((element) => element.style.opacity), "0.55");
  assert.deepEqual(errors, []);
  console.log(
    "PASS: rotated nested multi-nudge and mixed-type property edit preserve one-step undo; no page errors",
  );
  await page.close();
}

async function componentSelection(browser) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${baseUrl}/dev/import-preview?edit=1`, { waitUntil: "load" });
  await page
    .getByRole("button", { name: "Select Authentication panel", exact: true })
    .first()
    .click({ button: "right" });
  await page.getByRole("menuitem", { name: "Make component", exact: true }).click();
  await page.getByRole("button", { name: "+ Instance", exact: true }).click();
  const instanceButton = page
    .getByRole("button", { name: "Select Email input", exact: true })
    .last();
  await instanceButton.click();
  const instanceId = await page
    .locator('[data-node-id][data-selected="true"]')
    .first()
    .getAttribute("data-node-id");
  assert.ok(instanceId && instanceId !== "desktop-email-input");
  await page.getByRole("spinbutton", { name: "Radius", exact: true }).fill("31");
  await page.getByRole("spinbutton", { name: "Radius", exact: true }).press("Enter");
  await page.getByRole("button", { name: "Select Email input", exact: true }).first().click();
  await page.getByRole("spinbutton", { name: "Radius", exact: true }).fill("18");
  await page.getByRole("spinbutton", { name: "Radius", exact: true }).press("Enter");
  assert.equal(
    await page
      .locator(`[data-node-id="${instanceId}"]`)
      .evaluate((element) => element.style.borderTopLeftRadius),
    "31px",
  );
  assert.equal(
    await page
      .locator('[data-node-id="desktop-email-input"]')
      .evaluate((element) => element.style.borderTopLeftRadius),
    "18px",
  );
  await page.getByLabel("Design canvas", { exact: true }).focus();
  await page.keyboard.press("Meta+z");
  assert.equal(
    await page
      .locator(`[data-node-id="${instanceId}"]`)
      .evaluate((element) => element.style.borderTopLeftRadius),
    "31px",
  );
  assert.deepEqual(errors, []);
  console.log(
    "PASS: instance property override survives later master edit and undo; no page errors",
  );
  await page.close();
}

async function multiSelectionScale(browser) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  for (const mode of ["free", "rotated", "flow"]) {
    await page.goto(`${baseUrl}/dev/import-preview?edit=1`, { waitUntil: "load" });
    if (mode !== "free") {
      await page
        .getByRole("button", { name: "Select Authentication panel", exact: true })
        .first()
        .click();
      if (mode === "rotated") {
        await page.getByRole("spinbutton", { name: "Rotation", exact: true }).fill("30");
        await page.getByRole("spinbutton", { name: "Rotation", exact: true }).press("Enter");
      } else await chooseSelectMenu(page, "Flow", "Vertical");
    }
    await page.getByRole("button", { name: "Select Email input", exact: true }).first().click();
    await page
      .getByRole("button", { name: "Select Password input", exact: true })
      .first()
      .click({ modifiers: ["Shift"] });
    const email = page.locator('[data-node-id="desktop-email-input"]');
    const password = page.locator('[data-node-id="desktop-password-input"]');
    const before = [await email.boundingBox(), await password.boundingBox()];
    const handle = page.getByRole("button", { name: "Scale 2 layers", exact: true });
    const bounds = await handle.boundingBox();
    assert.ok(bounds);
    const x = bounds.x + bounds.width / 2,
      y = bounds.y + bounds.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + 40, y + 30, { steps: 5 });
    const preview = [await email.boundingBox(), await password.boundingBox()];
    assert.ok(
      preview[0].width > before[0].width && preview[1].width > before[1].width,
      `${mode} multi-scale previews before release`,
    );
    await page.mouse.up();
    const committed = [await email.boundingBox(), await password.boundingBox()];
    assert.ok(committed[0].width > before[0].width && committed[1].width > before[1].width);
    await page.getByLabel("Design canvas", { exact: true }).focus();
    await page.keyboard.press("Meta+z");
    const restored = [await email.boundingBox(), await password.boundingBox()];
    for (let index = 0; index < 2; index++)
      for (const edge of ["x", "y", "width", "height"])
        assert.ok(
          Math.abs(restored[index][edge] - before[index][edge]) < 1,
          `${mode} multi-scale undo ${index} ${edge}`,
        );
  }
  assert.deepEqual(errors, []);
  console.log(
    "PASS: free, rotated, and flow multi-selection scale preview immediately and undo in one step; no page errors",
  );
  await page.close();
}

async function multiSelectionResize(browser) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  for (const mode of ["free", "rotated", "flow"]) {
    await page.goto(`${baseUrl}/dev/import-preview?edit=1`, { waitUntil: "load" });
    if (mode !== "free") {
      await page
        .getByRole("button", { name: "Select Authentication panel", exact: true })
        .first()
        .click();
      if (mode === "rotated") {
        await page.getByRole("spinbutton", { name: "Rotation", exact: true }).fill("30");
        await page.getByRole("spinbutton", { name: "Rotation", exact: true }).press("Enter");
      } else await chooseSelectMenu(page, "Flow", "Vertical");
    }
    await page.getByRole("button", { name: "Select Email input", exact: true }).first().click();
    await page
      .getByRole("button", { name: "Select Password input", exact: true })
      .first()
      .click({ modifiers: ["Shift"] });
    const nodes = [
      page.locator('[data-node-id="desktop-email-input"]'),
      page.locator('[data-node-id="desktop-password-input"]'),
    ];
    const before = await Promise.all(nodes.map((node) => node.boundingBox()));
    const handle = page.getByRole("button", { name: "Resize 2 layers right", exact: true });
    const bounds = await handle.boundingBox();
    assert.ok(bounds);
    const x = bounds.x + bounds.width / 2,
      y = bounds.y + bounds.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + 50, y, { steps: 5 });
    const preview = await Promise.all(nodes.map((node) => node.boundingBox()));
    assert.ok(
      preview.every((box, index) => box.width > before[index].width),
      `${mode} multi-resize previews before release`,
    );
    await page.mouse.up();
    const committed = await Promise.all(nodes.map((node) => node.boundingBox()));
    assert.ok(
      committed.every((box, index) => box.width > before[index].width),
      `${mode} multi-resize commits`,
    );
    await page.getByLabel("Design canvas", { exact: true }).focus();
    await page.keyboard.press("Meta+z");
    const restored = await Promise.all(nodes.map((node) => node.boundingBox()));
    for (let index = 0; index < 2; index++)
      for (const edge of ["x", "y", "width", "height"])
        assert.ok(
          Math.abs(restored[index][edge] - before[index][edge]) < 1,
          `${mode} multi-resize undo ${index} ${edge}`,
        );
  }
  assert.deepEqual(errors, []);
  console.log(
    "PASS: free, rotated, and flow multi-selection resize previews immediately and undoes in one step; no page errors",
  );
  await page.close();
}

async function configurableNudge(browser) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${baseUrl}/dev/import-preview?edit=1`, { waitUntil: "load" });
  await page.getByRole("button", { name: "Select Email input", exact: true }).first().click();
  const node = page.locator('[data-node-id="desktop-email-input"]');
  const original = await node.evaluate((element) => Number.parseFloat(element.style.left));
  await page.getByRole("button", { name: /^Zoom \d+%$/ }).click();
  await page.getByRole("spinbutton", { name: "Nudge step", exact: true }).fill("7");
  await page.getByLabel("Design canvas", { exact: true }).focus();
  await page.keyboard.press("ArrowRight");
  const moved = await node.evaluate((element) => Number.parseFloat(element.style.left));
  assert.equal(moved - original, 7, "configured nudge moves seven canvas pixels");
  await page.keyboard.press("Meta+z");
  const restored = await node.evaluate((element) => Number.parseFloat(element.style.left));
  assert.equal(restored, original, "configured nudge undoes in one step");
  await page.reload({ waitUntil: "load" });
  assert.equal(
    await page.evaluate(() => window.localStorage.getItem("bella-canvas-nudge-step")),
    "7",
  );
  assert.deepEqual(errors, []);
  console.log(
    "PASS: configurable nudge applies immediately, undoes in one step, and persists after reload; no page errors",
  );
  await page.close();
}

async function keyObjectAlignment(browser) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${baseUrl}/dev/import-preview?edit=1`, { waitUntil: "load" });
  await page.getByRole("button", { name: "Select Email input", exact: true }).first().click();
  await page
    .getByRole("button", { name: "Select Create account link", exact: true })
    .first()
    .click({ modifiers: ["Shift"] });
  const email = page.locator('[data-node-id="desktop-email-input"]');
  const link = page.locator('[data-node-id="desktop-footer-link"]');
  const original = await link.evaluate((element) => Number.parseFloat(element.style.left));
  const keyPosition = await email.evaluate((element) => Number.parseFloat(element.style.left));
  assert.notEqual(original, keyPosition);
  await chooseSelectMenu(page, "Align to", "Email input");
  await page.getByRole("button", { name: "Align left", exact: true }).click();
  assert.equal(
    await link.evaluate((element) => Number.parseFloat(element.style.left)),
    keyPosition,
  );
  assert.equal(
    await email.evaluate((element) => Number.parseFloat(element.style.left)),
    keyPosition,
  );
  await page.getByLabel("Design canvas", { exact: true }).focus();
  await page.keyboard.press("Meta+z");
  assert.equal(await link.evaluate((element) => Number.parseFloat(element.style.left)), original);
  assert.deepEqual(errors, []);
  console.log(
    "PASS: key-object alignment holds the chosen layer fixed and undoes in one step; no page errors",
  );
  await page.close();
}

async function multiResizeSnapping(browser) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${baseUrl}/dev/import-preview?edit=1`, { waitUntil: "load" });
  await page.getByRole("button", { name: "Select Email input", exact: true }).first().click();
  await page
    .getByRole("button", { name: "Select Password input", exact: true })
    .first()
    .click({ modifiers: ["Shift"] });
  const email = page.locator('[data-node-id="desktop-email-input"]');
  const width = () => email.evaluate((element) => Number.parseFloat(element.style.width));
  const original = await width();
  async function dragEdge() {
    const bounds = await page
      .getByRole("button", { name: "Resize 2 layers right", exact: true })
      .boundingBox();
    assert.ok(bounds);
    const x = bounds.x + bounds.width / 2,
      y = bounds.y + bounds.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + 3, y, { steps: 3 });
    await page.mouse.up();
  }
  await dragEdge();
  assert.equal(await width(), original, "nearby sibling edge snaps the group width");
  await page.getByRole("button", { name: /^Zoom \d+%$/ }).click();
  await page.getByRole("menuitemcheckbox", { name: "Snap to objects", exact: true }).click();
  await dragEdge();
  assert.ok((await width()) > original, "disabling object snapping allows the same resize");
  assert.deepEqual(errors, []);
  console.log(
    "PASS: multi-selection resize snaps to sibling edges with object snapping enabled; no page errors",
  );
  await page.close();
}

async function editableGuides(browser) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${baseUrl}/dev/import-preview?edit=1`, { waitUntil: "load" });
  await page.getByRole("button", { name: /^Zoom \d+%$/ }).click();
  await page.getByRole("menuitemcheckbox", { name: /^Rulers and guides/ }).click();
  assert.equal(
    await page.locator("[data-guide-overlay]").count(),
    0,
    "fixed guide grid is removed",
  );
  await page
    .getByRole("button", { name: "Add vertical guide", exact: true })
    .click({ position: { x: 100, y: 10 } });
  const vertical = page.locator('[data-page-guide="x"]');
  assert.equal(await vertical.count(), 1);
  const initial = Number(await vertical.getAttribute("data-guide-position"));
  const bounds = await vertical.boundingBox();
  assert.ok(bounds);
  const x = bounds.x + bounds.width / 2,
    y = bounds.y + 50;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 30, y, { steps: 4 });
  await page.mouse.up();
  const dragged = Number(await vertical.getAttribute("data-guide-position"));
  assert.ok(dragged > initial, "guide drag updates its document position");
  await vertical.focus();
  await page.keyboard.press("ArrowRight");
  assert.equal(
    Number(await vertical.getAttribute("data-guide-position")),
    dragged + 1,
    "keyboard nudges a guide",
  );
  await page.getByRole("button", { name: "Select Email input", exact: true }).first().click();
  await vertical.focus();
  await page.keyboard.press("Delete");
  assert.equal(await vertical.count(), 0);
  assert.equal(
    await page.locator('[data-node-id="desktop-email-input"]').count(),
    1,
    "deleting a focused guide preserves the layer selection",
  );
  await page.getByLabel("Design canvas", { exact: true }).focus();
  await page.keyboard.press("Meta+z");
  assert.equal(await vertical.count(), 1, "guide deletion undoes in one step");
  const horizontalRuler = page.getByRole("button", { name: "Add horizontal guide", exact: true });
  await horizontalRuler.focus();
  await page.keyboard.press("Enter");
  assert.equal(
    await page.locator('[data-page-guide="y"]').count(),
    1,
    "ruler creates a guide by keyboard",
  );
  assert.deepEqual(errors, []);
  console.log(
    "PASS: editable page guides use rulers, drag, keyboard nudge/delete, and one-step undo; no page errors",
  );
  await page.close();
}

async function selectionMeasurementsAndSpacing(browser) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${baseUrl}/dev/import-preview?edit=1`, { waitUntil: "load" });
  await page.getByRole("button", { name: /^Zoom \d+%$/ }).click();
  await page.getByRole("menuitemcheckbox", { name: "Snap to objects", exact: true }).click();
  await page.getByRole("button", { name: "Select Email input", exact: true }).first().click();
  assert.match(await page.locator("[data-selection-measurement]").innerText(), /\d+ × 48/);
  const email = page.locator('[data-node-id="desktop-email-input"]');
  const box = await email.boundingBox();
  assert.ok(box);
  const x = box.x + 12,
    y = box.y + 5;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y + 3, { steps: 3 });
  await page.locator('[data-spacing-cue="y"]').first().waitFor();
  assert.equal(
    await page.locator('[data-spacing-cue="y"]').count(),
    2,
    "equal vertical gaps show paired cues during drag",
  );
  await page.mouse.up();
  assert.equal(
    await page.locator("[data-spacing-cue]").count(),
    0,
    "spacing cues clear after drag",
  );
  await page
    .getByRole("button", { name: "Select Password input", exact: true })
    .first()
    .click({ modifiers: ["Shift"] });
  assert.match(
    await page.locator("[data-multi-selection] [data-selection-measurement]").innerText(),
    /\d+ × \d+/,
  );
  assert.deepEqual(errors, []);
  console.log(
    "PASS: selection sizes and paired equal-spacing cues update contextually and clean up after drag; no page errors",
  );
  await page.close();
}

async function gridTracksAndSpans(browser) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${baseUrl}/dev/import-preview?edit=1`, { waitUntil: "load" });
  await page
    .getByRole("button", { name: "Select Authentication panel", exact: true })
    .first()
    .click();
  await chooseSelectMenu(page, "Flow", "Grid");
  const grid = page.locator('[data-node-id="desktop-panel"]');
  await page.getByRole("spinbutton", { name: "Column gap", exact: true }).fill("12");
  await page.getByRole("spinbutton", { name: "Column gap", exact: true }).press("Enter");
  await page.getByRole("spinbutton", { name: "Row gap", exact: true }).fill("8");
  await page.getByRole("spinbutton", { name: "Row gap", exact: true }).press("Enter");
  await page.locator("summary").filter({ hasText: "Grid tracks" }).click();
  await chooseSelectMenu(page, "Column 1 unit", "Pixels");
  await page.getByRole("spinbutton", { name: "Column 1 size", exact: true }).fill("120");
  await page.getByRole("spinbutton", { name: "Column 1 size", exact: true }).press("Enter");
  await page.getByRole("spinbutton", { name: "Column 2 size", exact: true }).fill("2");
  await page.getByRole("spinbutton", { name: "Column 2 size", exact: true }).press("Enter");
  await page.getByRole("button", { name: "Add row track", exact: true }).click();
  await chooseSelectMenu(page, "Row 1 unit", "Pixels");
  await page.getByRole("spinbutton", { name: "Row 1 size", exact: true }).fill("80");
  await page.getByRole("spinbutton", { name: "Row 1 size", exact: true }).press("Enter");
  assert.equal(
    await grid.evaluate((element) => element.style.gridTemplateColumns),
    "120px minmax(0px, 2fr)",
  );
  assert.equal(await grid.evaluate((element) => element.style.gridTemplateRows), "80px");
  assert.equal(await grid.evaluate((element) => element.style.columnGap), "12px");
  assert.equal(await grid.evaluate((element) => element.style.rowGap), "8px");
  await page.getByRole("button", { name: "Select Email input", exact: true }).first().click();
  await page.getByRole("spinbutton", { name: "Column span", exact: true }).fill("2");
  await page.getByRole("spinbutton", { name: "Column span", exact: true }).press("Enter");
  const child = page.locator('[data-node-id="desktop-email-input"]');
  assert.equal(await child.evaluate((element) => element.style.gridColumn), "span 2");
  await page.getByLabel("Design canvas", { exact: true }).focus();
  await page.keyboard.press("Meta+z");
  assert.equal(
    await child.evaluate((element) => element.style.gridColumn),
    "",
    "grid span undoes in one step",
  );
  assert.deepEqual(errors, []);
  console.log(
    "PASS: editable grid tracks, axis gaps, child spans, and one-step undo render on the canvas; no page errors",
  );
  await page.close();
}

async function responsiveBreakpoints(browser) {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
    acceptDownloads: true,
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${baseUrl}/dev/import-preview?edit=1`, { waitUntil: "load" });
  await page
    .getByRole("button", { name: "Select Authentication panel", exact: true })
    .first()
    .click();
  await chooseSelectMenu(page, "Flow", "Grid");
  const grid = page.locator('[data-node-id="desktop-panel"]');
  await page.locator("summary").filter({ hasText: "Responsive breakpoints" }).click();
  await page.getByRole("button", { name: "Add breakpoint", exact: true }).click();
  await page.getByRole("spinbutton", { name: "Frame width up to", exact: true }).fill("600");
  await page.getByRole("spinbutton", { name: "Frame width up to", exact: true }).press("Enter");
  await page.getByRole("spinbutton", { name: "Breakpoint columns", exact: true }).fill("1");
  await page.getByRole("spinbutton", { name: "Breakpoint columns", exact: true }).press("Enter");
  await page.locator("summary").filter({ hasText: "Breakpoint grid tracks" }).click();
  await chooseSelectMenu(page, "Breakpoint column 1 unit", "Pixels");
  await page.getByRole("spinbutton", { name: "Breakpoint column 1 size", exact: true }).fill("120");
  await page
    .getByRole("spinbutton", { name: "Breakpoint column 1 size", exact: true })
    .press("Enter");
  await page.getByRole("button", { name: "Add breakpoint row track", exact: true }).click();
  await chooseSelectMenu(page, "Breakpoint row 1 unit", "Pixels");
  await page.getByRole("spinbutton", { name: "Breakpoint row 1 size", exact: true }).fill("80");
  await page.getByRole("spinbutton", { name: "Breakpoint row 1 size", exact: true }).press("Enter");
  await page.getByRole("spinbutton", { name: "Breakpoint gap", exact: true }).fill("7");
  await page.getByRole("spinbutton", { name: "Breakpoint gap", exact: true }).press("Enter");
  assert.equal(
    await grid.evaluate((element) => element.style.gridTemplateColumns),
    "repeat(2, minmax(0px, 1fr))",
  );
  await page
    .getByRole("button", { name: "Select Desktop 1440 · /login", exact: true })
    .first()
    .click();
  const width = page.getByRole("spinbutton", { name: "Width", exact: true });
  await width.fill("500");
  await width.press("Enter");
  assert.equal(await grid.evaluate((element) => element.style.gridTemplateColumns), "120px");
  assert.equal(await grid.evaluate((element) => element.style.gridTemplateRows), "80px");
  assert.equal(await grid.evaluate((element) => element.style.gap), "7px");
  await page.getByText("Export", { exact: true }).click();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "svg", exact: true }).click();
  const svg = await readFile(await (await download).path(), "utf8");
  assert.match(svg, /grid-template-columns:\s*120px/, "SVG exports the active breakpoint column");
  assert.match(svg, /grid-template-rows:\s*80px/, "SVG exports the active breakpoint row");
  assert.equal(
    await page.evaluate(
      (source) =>
        new DOMParser().parseFromString(source, "image/svg+xml").querySelectorAll("parsererror")
          .length,
      svg,
    ),
    0,
  );
  await page.getByLabel("Design canvas", { exact: true }).focus();
  await page.keyboard.press("Meta+z");
  assert.equal(await width.inputValue(), "1440");
  assert.equal(
    await grid.evaluate((element) => element.style.gridTemplateColumns),
    "repeat(2, minmax(0px, 1fr))",
  );
  assert.deepEqual(errors, []);
  console.log(
    "PASS: breakpoint grid tracks switch on frame resize, export in SVG, and restore with one-step undo; no page errors",
  );
  await page.close();
}

async function colorPaletteAndSampling(browser) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    window.EyeDropper = class {
      async open() {
        return { sRGBHex: "#abcdef" };
      }
    };
  });
  await page.goto(`${baseUrl}/dev/import-preview?edit=1`, { waitUntil: "load" });
  await page.getByRole("button", { name: "Select Email input", exact: true }).first().click();
  const fill = page.getByRole("textbox", { name: "Fill color", exact: true });
  const email = page.locator('[data-node-id="desktop-email-input"]');
  const originalFill = await email.evaluate((element) => element.style.background);
  await fill.fill("bad");
  await fill.press("Enter");
  assert.equal(await fill.getAttribute("aria-invalid"), "true");
  assert.equal(await email.evaluate((element) => element.style.background), originalFill);
  await fill.fill("#314159");
  await fill.press("Enter");
  assert.equal(await fill.getAttribute("aria-invalid"), null);
  await page.getByRole("button", { name: "Open fill color palette", exact: true }).click();
  assert.equal(
    await page.getByRole("button", { name: "Use selection color #314159", exact: true }).count(),
    1,
  );
  assert.equal(
    await page.getByRole("button", { name: "Use recent color #314159", exact: true }).count(),
    1,
  );
  await page.getByRole("button", { name: "Sample canvas", exact: true }).click();
  assert.equal(await fill.inputValue(), "#abcdef");
  await page.getByRole("button", { name: "Select Welcome heading", exact: true }).first().click();
  const heading = page.locator('[data-node-id="desktop-heading"]');
  const previous = await heading.evaluate((element) => element.style.color);
  await page.getByRole("button", { name: "Open text color palette", exact: true }).click();
  await page.getByRole("button", { name: "Use recent color #314159", exact: true }).click();
  assert.equal(await heading.evaluate((element) => element.style.color), "rgb(49, 65, 89)");
  await page.getByLabel("Design canvas", { exact: true }).focus();
  await page.keyboard.press("Meta+z");
  assert.equal(await heading.evaluate((element) => element.style.color), previous);
  await page.getByRole("tab", { name: "Tokens", exact: true }).click();
  await page.getByRole("button", { name: "+ Color token", exact: true }).click();
  await page.getByRole("textbox", { name: "Token name", exact: true }).fill("accent");
  await page.getByRole("textbox", { name: "Token name", exact: true }).press("Enter");
  await page.getByRole("textbox", { name: "Color", exact: true }).fill("#ff00aa");
  await page.getByRole("textbox", { name: "Color", exact: true }).press("Enter");
  await page.getByRole("tab", { name: "Layers", exact: true }).click();
  await page.getByRole("button", { name: "Select Email input", exact: true }).first().click();
  const border = page.getByRole("textbox", { name: "Border color", exact: true });
  await chooseSelectMenu(page, "Border token", "accent");
  assert.equal(await email.evaluate((element) => element.style.borderColor), "rgb(255, 0, 170)");
  await border.fill("invalid");
  await border.press("Enter");
  assert.equal(await border.getAttribute("aria-invalid"), "true");
  assert.equal(await email.evaluate((element) => element.style.borderColor), "rgb(255, 0, 170)");
  await border.fill("#112233");
  await border.press("Enter");
  assert.equal(await selectMenuText(page, "Border token"), "Custom");
  await page.getByLabel("Design canvas", { exact: true }).focus();
  await page.keyboard.press("Meta+z");
  assert.equal(await selectMenuText(page, "Border token"), "accent");
  await page.getByRole("button", { name: "Select Welcome heading", exact: true }).first().click();
  await chooseSelectMenu(page, "Text token", "accent");
  const textColor = page.getByRole("textbox", { name: "Text color", exact: true });
  await textColor.fill("invalid");
  await textColor.press("Enter");
  assert.equal(await textColor.getAttribute("aria-invalid"), "true");
  assert.equal(await selectMenuText(page, "Text token"), "accent");
  await textColor.fill("#445566");
  await textColor.press("Enter");
  assert.equal(await selectMenuText(page, "Text token"), "Custom");
  await page.getByLabel("Design canvas", { exact: true }).focus();
  await page.keyboard.press("Meta+z");
  assert.equal(await selectMenuText(page, "Text token"), "accent");
  await page.reload();
  await page.getByRole("button", { name: "Select Welcome heading", exact: true }).first().click();
  await page.getByRole("button", { name: "Open text color palette", exact: true }).click();
  assert.equal(
    await page.getByRole("button", { name: "Use recent color #abcdef", exact: true }).count(),
    1,
  );
  assert.deepEqual(errors, []);
  console.log(
    "PASS: selection/recent colors, sampling, invalid fill/text/border input, token binding, undo, and local recent-color persistence; no page errors",
  );
  await page.close();
}

async function irregularAutoLayout(browser) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${baseUrl}/dev/import-preview?edit=1`, { waitUntil: "load" });
  await page.getByRole("tree", { name: "Layers" }).waitFor();
  const children = () =>
    page.locator("[data-node-id]").evaluateAll((elements) =>
      elements
        .filter(
          (element) =>
            element.parentElement?.closest("[data-node-id]")?.getAttribute("data-node-id") ===
            "desktop-panel",
        )
        .map((element) => ({
          id: element.getAttribute("data-node-id"),
          box: element.getBoundingClientRect().toJSON(),
        })),
    );
  const before = await children();
  await page
    .getByRole("button", { name: "Select Authentication panel", exact: true })
    .first()
    .click();
  await page.getByLabel("Design canvas", { exact: true }).focus();
  await page.keyboard.press("Shift+a");
  assert.equal(await selectMenuText(page, "Flow"), "Vertical");
  const after = new Map((await children()).map(({ id, box }) => [id, box]));
  for (const { id, box } of before)
    for (const axis of ["x", "y", "width", "height"])
      assert.ok(
        Math.abs(after.get(id)[axis] - box[axis]) < 0.1,
        `${id} ${axis} changed during conversion`,
      );
  const link = page.locator('[data-node-id="desktop-footer-link"]');
  await link.click();
  const cross = page.getByRole("spinbutton", { name: "Cross offset", exact: true });
  const original = Number(await cross.inputValue());
  await cross.fill(String(original + 10));
  await cross.press("Enter");
  assert.equal(
    await link.evaluate((element) => Number.parseFloat(element.style.left)),
    original + 10,
  );
  await page.getByLabel("Design canvas", { exact: true }).focus();
  await page.keyboard.press("Meta+z");
  assert.equal(await cross.inputValue(), String(original));
  assert.deepEqual(errors, []);
  console.log(
    "PASS: irregular auto-layout conversion preserves all panel child geometry and contextual offsets edit and undo immediately; no page errors",
  );
  await page.close();
}

async function geometryAndPreview(browser) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${baseUrl}/dev/import-preview?edit=1`, { waitUntil: "load" });
  await page.getByRole("button", { name: "Select Email input", exact: true }).first().click();
  const node = page.locator('[data-node-id="desktop-email-input"]');
  const box = () =>
    node.evaluate((el) => ({
      x: parseFloat(el.style.left),
      y: parseFloat(el.style.top),
      width: parseFloat(el.style.width),
      height: parseFloat(el.style.height),
    }));
  const original = await box();
  const resize = async (name, dx, dy, mods = []) => {
    const handle = page.getByRole("button", { name: `Resize Email input ${name}`, exact: true });
    const r = await handle.boundingBox();
    assert.ok(r);
    for (const key of mods) await page.keyboard.down(key);
    await page.mouse.move(r.x + r.width / 2, r.y + r.height / 2);
    await page.mouse.down();
    await page.mouse.move(r.x + r.width / 2 + dx, r.y + r.height / 2 + dy, { steps: 4 });
    await page.mouse.up();
    for (const key of mods.reverse()) await page.keyboard.up(key);
  };
  for (const [name, dx, dy] of [
    ["top left", -12, -12],
    ["top", 0, -12],
    ["top right", 12, -12],
    ["right", 12, 0],
    ["bottom right", 12, 12],
    ["bottom", 0, 12],
    ["bottom left", -12, 12],
    ["left", -12, 0],
  ]) {
    await page.getByRole("button", { name: `Resize Email input ${name}`, exact: true }).waitFor();
    await resize(name, dx, dy);
    const changed = await box();
    assert.notDeepEqual(changed, original, name);
    if (name === "top" || name === "bottom") assert.equal(changed.width, original.width);
    if (name === "left" || name === "right") assert.equal(changed.height, original.height);
    await page.getByLabel("Design canvas", { exact: true }).focus();
    await page.keyboard.press("Meta+z");
    assert.deepEqual(await box(), original);
  }
  await page.getByRole("button", { name: "Lock aspect ratio", exact: true }).click();
  await resize("right", 15, 0, ["Alt"]);
  const locked = await box();
  assert.ok(Math.abs(locked.width / locked.height - original.width / original.height) < 0.00001);
  assert.ok(Math.abs(locked.x + locked.width / 2 - original.x - original.width / 2) < 0.00001);
  assert.ok(Math.abs(locked.y + locked.height / 2 - original.y - original.height / 2) < 0.00001);
  await page.getByLabel("Design canvas", { exact: true }).focus();
  await page.keyboard.press("Meta+z");
  const rotate = page.getByRole("button", { name: "Rotate Email input", exact: true });
  await rotate.focus();
  await page.keyboard.press("Shift+ArrowRight");
  assert.equal(
    await page.getByRole("spinbutton", { name: "Rotation", exact: true }).inputValue(),
    "15",
  );
  await page.getByLabel("Design canvas", { exact: true }).focus();
  await page.keyboard.press("Meta+z");
  const b = await rotate.boundingBox();
  const n = await node.boundingBox();
  const cx = n.x + n.width / 2,
    cy = n.y + n.height / 2;
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.down();
  await page.keyboard.down("Shift");
  await page.mouse.move(cx + 80, cy, { steps: 6 });
  await page.mouse.up();
  await page.keyboard.up("Shift");
  assert.equal(
    await page.getByRole("spinbutton", { name: "Rotation", exact: true }).inputValue(),
    "90",
  );
  await page.screenshot({ path: artifactPath("bella-editor-geometry.png") });
  assert.deepEqual(errors, []);
  console.log(
    "PASS: all eight resize handles, one-step undo, aspect lock, centered resize, keyboard rotation, pointer rotation with 15-degree snapping; no page errors",
  );
  await page.goto(`${baseUrl}/dev/import-preview`, { waitUntil: "load" });
  await page.getByRole("button", { name: "Select Email input", exact: true }).first().click();
  assert.equal(
    await page.getByRole("spinbutton", { name: "Radius", exact: true }).isDisabled(),
    true,
  );
  assert.equal(
    await page
      .getByRole("button", { name: "Resize Email input bottom right", exact: true })
      .count(),
    0,
  );
  console.log("PASS: preview property controls are read-only");

  await page.close();
}

async function snapping(browser) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${baseUrl}/dev/import-preview?edit=1`, { waitUntil: "load" });
  await page.getByRole("button", { name: "Select Email input", exact: true }).first().click();
  const email = page.locator('[data-node-id="desktop-email-input"]');
  await page
    .getByRole("button", { name: "Resize Email input bottom right", exact: true })
    .waitFor();
  const box = await email.boundingBox();
  const candidates = await page.locator("[data-node-id]").evaluateAll((es) =>
    es
      .filter(
        (e) =>
          e.dataset.nodeId !== "desktop-email-input" &&
          !e.closest('[data-node-id="desktop-email-input"]'),
      )
      .map((e) => {
        const r = e.getBoundingClientRect();
        return [r.left, r.left + r.width / 2, r.right];
      })
      .flat(),
  );
  await page.mouse.move(box.x + box.width * 0.25, box.y + box.height - 3);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.25 + 4, box.y + box.height + 13, { steps: 4 });
  const snapped = await email.boundingBox();
  assert.ok(
    [snapped.x, snapped.x + snapped.width / 2, snapped.x + snapped.width].some((x) =>
      candidates.some((target) => Math.abs(x - target) < 0.01),
    ),
  );
  assert.ok((await page.locator("[data-snap-guide]").count()) > 0);
  await page.screenshot({ path: artifactPath("bella-editor-snapping.png") });
  await page.mouse.up();
  assert.equal(await page.locator("[data-snap-guide]").count(), 0);
  await page.getByLabel("Design canvas", { exact: true }).focus();
  await page.keyboard.press("Meta+z");
  const b = await email.boundingBox();
  await page.keyboard.down(snapBypass);
  await page.mouse.move(b.x + b.width * 0.25, b.y + b.height - 3);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width * 0.25 + 4, b.y + b.height + 13, { steps: 4 });
  await page.mouse.up();
  await page.keyboard.up(snapBypass);
  assert.ok((await email.evaluate((el) => parseFloat(el.style.left))) > 0);
  assert.deepEqual(errors, []);
  console.log(
    "PASS: object snapping, visible alignment guides, guide cleanup, undo, and modifier bypass",
  );

  await page.close();
}

async function responsiveConstraints(browser) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const select = async (name) => {
    await page
      .getByRole("button", { name: `Select ${name}`, exact: true })
      .first()
      .click();
    await page.getByRole("textbox", { name: "Layer name", exact: true }).waitFor();
  };
  const read = () =>
    page.locator('[data-node-id="desktop-email-input"]').evaluate((el) => {
      const s = getComputedStyle(el);
      return {
        x: parseFloat(s.left),
        y: parseFloat(s.top),
        width: parseFloat(s.width),
        height: parseFloat(s.height),
      };
    });
  const set = async (name, value) => {
    const field = page.getByRole("spinbutton", { name, exact: true });
    await field.fill(String(value));
    await field.press("Enter");
  };
  for (const mode of ["start", "end", "center", "stretch", "scale"]) {
    await page.goto(`${baseUrl}/dev/import-preview?edit=1`, { waitUntil: "load" });
    await select("Email input");
    await chooseSelectMenu(
      page,
      "Horizontal constraint",
      { start: "Left", end: "Right", center: "Center", stretch: "Left & right", scale: "Scale" }[
        mode
      ],
    );
    await chooseSelectMenu(
      page,
      "Vertical constraint",
      { start: "Top", end: "Bottom", center: "Center", stretch: "Top & bottom", scale: "Scale" }[
        mode
      ],
    );
    const before = await read();
    await select("Authentication panel");
    const pw = Number(
        await page.getByRole("spinbutton", { name: "Width", exact: true }).inputValue(),
      ),
      ph = Number(await page.getByRole("spinbutton", { name: "Height", exact: true }).inputValue());
    await set("Width", pw + 100);
    await set("Height", ph + 100);
    const after = await read();
    const close = (a, b) => assert.ok(Math.abs(a - b) < 0.05, `${mode}: ${a} != ${b}`);
    if (mode === "start") assert.deepEqual(after, before);
    if (mode === "end") {
      close(after.x, before.x + 100);
      close(after.y, before.y + 100);
    }
    if (mode === "center") {
      close(after.x, before.x + 50);
      close(after.y, before.y + 50);
    }
    if (mode === "stretch") {
      close(after.width, before.width + 100);
      close(after.height, before.height + 100);
    }
    if (mode === "scale") {
      close(after.width, (before.width * (pw + 100)) / pw);
      close(after.x, (before.x * (pw + 100)) / pw);
      close(after.height, (before.height * (ph + 100)) / ph);
      close(after.y, (before.y * (ph + 100)) / ph);
    }
    await page.getByLabel("Design canvas", { exact: true }).focus();
    await page.keyboard.press("Meta+z");
    await page.keyboard.press("Meta+z");
    const undone = await read();
    for (const key of Object.keys(before)) close(undone[key], before[key]);
  }
  await page.goto(`${baseUrl}/dev/import-preview?edit=1`, { waitUntil: "load" });
  await select("Email input");
  await chooseSelectMenu(page, "Horizontal constraint", "Scale");
  await select("Authentication panel");
  await chooseSelectMenu(page, "Width sizing", "Fill");
  await select("Email input");
  const email = page.locator('[data-node-id="desktop-email-input"]');
  await page.waitForFunction(() => {
    const e = document.querySelector('[data-node-id="desktop-email-input"]');
    const field = document.querySelector('input[aria-label="Width"]');
    return Math.abs(Number(field?.value) - parseFloat(getComputedStyle(e).width)) < 0.05;
  });
  const handle = page.getByRole("button", { name: "Resize Email input right", exact: true });
  await handle.waitFor();
  const h = await handle.boundingBox();
  const before = await email.boundingBox();
  await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
  await page.mouse.down();
  await page.mouse.move(h.x + h.width / 2 + 20, h.y + h.height / 2, { steps: 4 });
  await page.mouse.up();
  const after = await email.boundingBox();
  assert.ok(Math.abs(after.width - before.width - 20) < 1);
  await page.getByLabel("Design canvas", { exact: true }).focus();
  const x = after.x;
  await page.keyboard.press("ArrowRight");
  const nudged = await email.boundingBox();
  assert.ok(nudged.x - x > 0 && nudged.x - x < 1);
  const e = await email.boundingBox();
  await page.keyboard.down(snapBypass);
  await page.mouse.move(e.x + e.width * 0.7, e.y + e.height - 3);
  await page.mouse.down();
  await page.mouse.move(e.x + e.width * 0.7 + 10, e.y + e.height - 3, { steps: 4 });
  await page.mouse.up();
  await page.keyboard.up(snapBypass);
  const dragged = await email.boundingBox();
  assert.ok(Math.abs(dragged.x - e.x - 10) < 1);
  await page.screenshot({ path: artifactPath("bella-editor-constraints.png") });
  assert.deepEqual(errors, []);
  console.log(
    "PASS: five constraint modes, nested parent resize, undo, runtime fill sizing, actual inspector geometry, proportional canvas resize/nudge/drag",
  );

  await select("Desktop 1440 · /login");
  await chooseSelectMenu(page, "Frame preset", "Tablet · 768 × 1024");
  assert.equal(
    await page.getByRole("spinbutton", { name: "Width", exact: true }).inputValue(),
    "768",
  );
  assert.equal(
    await page.getByRole("spinbutton", { name: "Height", exact: true }).inputValue(),
    "1024",
  );
  await page.getByLabel("Design canvas", { exact: true }).focus();
  await page.keyboard.press("Meta+z");
  assert.equal(
    await page.getByRole("spinbutton", { name: "Width", exact: true }).inputValue(),
    "1440",
  );
  assert.deepEqual(errors, []);
  console.log("PASS: frame presets apply immediately and undo in one step");
  await page.close();
}

async function layoutWorkflows(browser) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${baseUrl}/dev/import-preview?edit=1`, { waitUntil: "load" });
  const canvas = page.getByLabel("Design canvas", { exact: true });
  const email = page.locator('[data-node-id="desktop-email-input"]'),
    password = page.locator('[data-node-id="desktop-password-input"]');
  const select = async (name, modifiers = []) => {
    await page
      .getByRole("button", { name: `Select ${name}`, exact: true })
      .first()
      .click({ modifiers });
  };
  const geometry = async () => [await email.boundingBox(), await password.boundingBox()];
  const close = (a, b, tolerance = 0.1) => assert.ok(Math.abs(a - b) < tolerance, `${a} != ${b}`);
  await select("Email input");
  await select("Password input", ["Shift"]);
  const before = await geometry();
  await canvas.focus();
  await page.keyboard.press("Meta+Alt+g");
  await page.getByRole("button", { name: "Select Frame", exact: true }).waitFor();
  const wrapped = await geometry();
  for (let i = 0; i < 2; i++)
    for (const key of ["x", "y", "width", "height"]) close(wrapped[i][key], before[i][key]);
  await canvas.focus();
  await page.keyboard.press("Shift+a");
  assert.equal(await selectMenuText(page, "Flow"), "Vertical");
  const flow = await geometry();
  for (let i = 0; i < 2; i++)
    for (const key of ["x", "y", "width", "height"]) close(flow[i][key], before[i][key]);
  const gap = page.getByRole("spinbutton", { name: "Gap", exact: true });
  await gap.fill("-8");
  await gap.press("Enter");
  assert.equal(await password.evaluate((e) => e.style.marginTop), "-8px");
  await chooseSelectMenu(page, "Align", "Baseline");
  assert.equal(await email.evaluate((e) => e.parentElement.style.alignItems), "baseline");
  const overlap = await geometry();
  assert.ok(overlap[1].y < overlap[0].y + overlap[0].height);
  await page.getByRole("button", { name: "Select Frame", exact: true }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Fit to content", exact: true }).click();
  await page.waitForFunction(
    () => Math.abs(Number(document.querySelector('input[aria-label="Height"]')?.value) - 88) < 0.1,
  );
  const fitted = await geometry();
  for (let i = 0; i < 2; i++)
    for (const key of ["x", "y", "width", "height"]) close(fitted[i][key], overlap[i][key]);
  await canvas.focus();
  await page.keyboard.press("Meta+Shift+g");
  assert.equal(await page.getByRole("button", { name: "Select Frame", exact: true }).count(), 0);
  const ungrouped = await geometry();
  for (let i = 0; i < 2; i++)
    for (const key of ["x", "y", "width", "height"]) close(ungrouped[i][key], fitted[i][key]);
  await canvas.focus();
  await page.keyboard.press("Meta+z");
  assert.equal(await page.getByRole("button", { name: "Select Frame", exact: true }).count(), 1);
  await page.screenshot({ path: artifactPath("bella-editor-auto-layout.png") });
  await select("Authentication panel");
  const originalWidth = Number(
    await page.getByRole("spinbutton", { name: "Width", exact: true }).inputValue(),
  );
  const heading = page.locator('[data-node-id="desktop-heading"]');
  const fontBefore = await heading.evaluate((el) => parseFloat(el.style.fontSize));
  const scale = page.getByRole("spinbutton", { name: "Scale by %", exact: true });
  await scale.fill("150");
  await scale.press("Enter");
  close(
    Number(await page.getByRole("spinbutton", { name: "Width", exact: true }).inputValue()),
    originalWidth * 1.5,
  );
  close(await heading.evaluate((el) => parseFloat(el.style.fontSize)), fontBefore * 1.5);
  await canvas.focus();
  await page.keyboard.press("Meta+z");
  close(
    Number(await page.getByRole("spinbutton", { name: "Width", exact: true }).inputValue()),
    originalWidth,
  );
  assert.equal(
    (await page.getByRole("alert").allTextContents()).filter((text) => text.trim()).length,
    0,
  );
  assert.deepEqual(errors, []);
  console.log(
    "PASS: frame wrapping preserves geometry; auto layout infers flow/gap; negative overlap/baseline; fit to content; measured ungroup; proportional scale includes typography; one-step undo; no page errors",
  );

  await page.close();
}

try {
  await appearanceAndWorkflow(browser);
  await clipboardAcrossPages(browser);
  await treeAndLocks(browser);
  await clipboardAcrossFiles(browser);
  await nestedMixedSelection(browser);
  await componentSelection(browser);
  await multiSelectionScale(browser);
  await multiSelectionResize(browser);
  await configurableNudge(browser);
  await keyObjectAlignment(browser);
  await multiResizeSnapping(browser);
  await editableGuides(browser);
  await selectionMeasurementsAndSpacing(browser);
  await gridTracksAndSpans(browser);
  await responsiveBreakpoints(browser);
  await colorPaletteAndSampling(browser);
  await irregularAutoLayout(browser);
  await geometryAndPreview(browser);
  await snapping(browser);
  await responsiveConstraints(browser);
  await layoutWorkflows(browser);
} finally {
  await browser.close();
}
