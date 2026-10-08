import assert from "node:assert/strict";
import { chromium } from "playwright";
import { chooseSelectMenu } from "./select-menu-controls.mjs";

const browser = await chromium.launch({ headless: true });
const base = process.env.EDITOR_TEST_URL || "http://localhost:3113";
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${base}/dev/import-preview?edit=1&components=1`);
  await page.waitForFunction(() =>
    [...document.querySelectorAll("button")].some(
      (button) =>
        button.getAttribute("aria-label") === "Select Card instance" &&
        Object.keys(button).some((key) => key.startsWith("__reactProps")),
    ),
  );
  const canvas = page.getByLabel("Design canvas", { exact: true });
  const source = page.locator('[data-node-id="master"]');
  const instance = page.locator('[data-node-id="instance-0"]');
  const select = async (name) =>
    page
      .getByRole("button", { name: `Select ${name}`, exact: true })
      .first()
      .click();
  const width = page.getByRole("spinbutton", { name: "Width", exact: true });
  const undo = async () => {
    await canvas.focus();
    await page.keyboard.press("ControlOrMeta+z");
  };
  const setWidth = async (value) => {
    await width.fill(String(value));
    await width.press("Enter");
  };
  await select("Card instance");
  await setWidth(260);
  await select("Card");
  await setWidth(240);
  assert.equal(await instance.evaluate((node) => node.style.width), "260px");
  await page.locator('[data-node-id="label"]').click({ button: "right" });
  await page.getByRole("menuitem", { name: /^Duplicate/ }).click();
  await page.waitForFunction(
    () =>
      document
        .querySelector('[data-node-id="instance-0"]')
        .querySelectorAll(":scope > [data-node-id]").length === 3,
  );
  const children = (node) => node.locator(":scope > [data-node-id]");
  assert.equal(await children(source).count(), 3);
  await page
    .getByRole("button", { name: "Select Label copy", exact: true })
    .first()
    .click({ button: "right" });
  await page.getByRole("menuitem", { name: "Send backward", exact: true }).click();
  assert.deepEqual(
    await children(source).allTextContents(),
    await children(instance).allTextContents(),
  );
  await undo();
  assert.deepEqual(
    await children(source).allTextContents(),
    await children(instance).allTextContents(),
  );
  await page.getByRole("button", { name: "Select Label copy", exact: true }).first().click();
  await canvas.focus();
  await page.keyboard.press("Delete");
  await page.waitForFunction(
    () =>
      document
        .querySelector('[data-node-id="instance-0"]')
        .querySelectorAll(":scope > [data-node-id]").length === 2,
  );
  await undo();
  await page.waitForFunction(
    () =>
      document
        .querySelector('[data-node-id="instance-0"]')
        .querySelectorAll(":scope > [data-node-id]").length === 3,
  );
  await select("Card instance");
  await page.getByRole("button", { name: "Reset overrides", exact: true }).click();
  assert.equal(await instance.evaluate((node) => node.style.width), "240px");
  await undo();
  assert.equal(await instance.evaluate((node) => node.style.width), "260px");
  await chooseSelectMenu(page, "Swap component", "Alternate card");
  assert.equal(await instance.evaluate((node) => node.style.width), "260px");
  assert.ok((await instance.textContent()).includes("Target"));
  const appearance = await instance.getAttribute("style");
  await page.getByRole("button", { name: "Detach instance", exact: true }).click();
  assert.equal(await instance.getAttribute("style"), appearance);
  assert.equal(await page.getByRole("button", { name: "Detach instance", exact: true }).count(), 0);
  await undo();
  await page.getByRole("button", { name: "Go to master", exact: true }).click();
  await page.locator('[data-node-id="target"][data-selected="true"]').waitFor();
  assert.equal(
    await page.getByRole("textbox", { name: "Layer name", exact: true }).inputValue(),
    "Alternate card",
  );
  assert.deepEqual(errors, []);
  console.log(
    "PASS: master add/reorder/delete, override preservation, reset/swap/detach, one-step undo, and cross-page go-to-master",
  );
  await page.goto(`${base}/dev/import-preview?edit=1&components=1&viewer=1`);
  await select("Card instance");
  assert.equal(
    await page.getByRole("button", { name: "Reset overrides", exact: true }).isDisabled(),
    true,
  );
  assert.equal(
    await page.getByRole("button", { name: "Detach instance", exact: true }).isDisabled(),
    true,
  );
  await page.getByRole("button", { name: "Go to master", exact: true }).click();
  await page.locator('[data-node-id="master"][data-selected="true"]').waitFor();
  console.log("PASS: viewer can navigate to master but cannot mutate instances");
} finally {
  await browser.close();
}
