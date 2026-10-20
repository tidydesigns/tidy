import { test, expect, required } from "./fixtures";
import type { Page } from "playwright/test";

async function openEditor(page: Page, compact = false) {
  await page.removeLocatorHandler(
    page
      .getByRole("spinbutton", { name: "Export scale", exact: true })
      .and(page.locator('[value="2"]')),
  );
  await page.goto(`/dev/import-preview?edit=1${compact ? "&compact=1" : ""}`);
  const canvas = page.getByLabel("Design canvas", { exact: true });
  await expect(canvas).toBeVisible();
  return canvas;
}

test("desktop inspector stays stable across tools, selections, and deselection", async ({
  page,
}) => {
  const canvas = await openEditor(page);
  const inspector = page.getByLabel("Inspector", { exact: true });
  await expect(inspector.getByRole("heading", { name: "Page", exact: true })).toBeVisible();
  const before = await canvas.boundingBox();
  await page.getByRole("button", { name: "Select Welcome heading", exact: true }).first().click();
  await expect(inspector.getByRole("textbox", { name: "Layer name", exact: true })).toHaveValue(
    "Welcome heading",
  );
  await expect(inspector.getByRole("heading", { name: "Typography", exact: true })).toBeVisible();
  await canvas.focus();
  await canvas.press("Escape");
  await canvas.press("Escape");
  await canvas.press("Escape");
  await expect(inspector.getByRole("heading", { name: "Page", exact: true })).toBeVisible();
  expect(await canvas.boundingBox()).toEqual(before);
  await page.getByRole("button", { name: "Hand tool", exact: true }).click();
  await expect(
    inspector.getByRole("button", { name: "Connect your agent", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Frame tool", exact: true }).click();
  await expect(inspector.getByRole("heading", { name: "Frame", exact: true })).toBeVisible();
  await expect(inspector.getByRole("button", { name: "Mobile" })).toBeHidden();
  await inspector.locator("summary").filter({ hasText: "Phone" }).click();
  const count = await page.locator("[data-node-id]").count();
  await inspector.getByRole("button", { name: "Mobile" }).click();
  await expect(page.locator("[data-node-id]")).toHaveCount(count + 1);
  await expect(inspector.getByRole("spinbutton", { name: "Width", exact: true })).toHaveValue(
    "390",
  );
  await expect(inspector.getByRole("spinbutton", { name: "Height", exact: true })).toHaveValue(
    "844",
  );
  await expect(canvas).toBeFocused();
  await canvas.press("ControlOrMeta+z");
  await expect(page.locator("[data-node-id]")).toHaveCount(count);
});

test("page color applies immediately, follows its page, and supports undo", async ({ page }) => {
  const canvas = await openEditor(page);
  const color = page.getByRole("textbox", { name: "Canvas color", exact: true });
  await color.fill("#e8edf4");
  await color.press("Enter");
  await expect(canvas).toHaveCSS("background-color", "rgb(232, 237, 244)");
  await page.getByRole("button", { name: "Add page", exact: true }).click();
  await expect(canvas).not.toHaveCSS("background-color", "rgb(232, 237, 244)");
  await page.getByRole("button", { name: "Page 1", exact: true }).click();
  await expect(canvas).toHaveCSS("background-color", "rgb(232, 237, 244)");
  await canvas.focus();
  await canvas.press("ControlOrMeta+z");
  await canvas.press("ControlOrMeta+z");
  await expect(canvas).not.toHaveCSS("background-color", "rgb(232, 237, 244)");
});

test("text defaults inherit the last text style and remain available during typing", async ({
  page,
}) => {
  const canvas = await openEditor(page);
  await page.getByRole("button", { name: "Text tool", exact: true }).click();
  const size = page.getByRole("spinbutton", { name: "Font size", exact: true });
  await size.fill("48");
  await size.press("Enter");
  await canvas.focus();
  await canvas.press("Enter");
  const editor = page.getByRole("textbox", { name: "Edit Text", exact: true });
  await expect(editor).toBeFocused();
  await page.keyboard.type("First heading");
  await expect(size).toHaveValue("48");
  const first = page.locator('[data-node-id][data-selected="true"]');
  await expect(first).toHaveCSS("font-size", "48px");
  await size.fill("56");
  await size.press("Enter");
  await expect(first.locator("[data-design-text]")).toHaveText("First heading");
  await canvas.focus();
  await canvas.press("Escape");
  await canvas.press("t");
  await expect(size).toHaveValue("56");
  await canvas.press("Enter");
  await expect(editor).toBeFocused();
  await page.keyboard.type("Second heading");
  await expect(page.locator('[data-node-id][data-selected="true"]')).toHaveCSS("font-size", "56px");
  await expect(size).toHaveValue("56");
  await editor.press("Escape");
  await expect(canvas).toBeFocused();
});

test("invalid font-size defaults preserve valid text insertion", async ({ page }) => {
  const canvas = await openEditor(page);
  await page.getByRole("button", { name: "Text tool", exact: true }).click();
  const size = page.getByRole("spinbutton", { name: "Font size", exact: true });
  await size.fill("48");
  await size.press("Enter");
  for (const value of ["", "5", "301"]) {
    await size.fill(value);
    await size.press("Enter");
    await expect(size).toHaveAttribute("aria-invalid", "true");
  }
  await canvas.focus();
  await canvas.press("Enter");
  const editor = page.getByRole("textbox", { name: "Edit Text", exact: true });
  await expect(editor).toBeFocused();
  await page.keyboard.type("Valid text");
  await editor.press("Escape");
  const layer = page.locator('[data-node-id][data-selected="true"]');
  await expect(layer).toHaveCSS("font-size", "48px");
  await expect(layer.locator("[data-design-text]")).toHaveText("Valid text");
});

test("one Escape finishes text with the same selection and sidebar layout", async ({ page }) => {
  const canvas = await openEditor(page);
  await canvas.focus();
  await canvas.press("t");
  await canvas.press("Enter");
  const editor = page.getByRole("textbox", { name: "Edit Text", exact: true });
  await page.keyboard.type("A consistent inspector");
  const inspector = page.getByLabel("Inspector", { exact: true });
  const layer = page.locator('[data-node-id][data-selected="true"]');
  const id = required(await layer.getAttribute("data-node-id"));
  const layout = () =>
    inspector.locator("h3,label,summary").evaluateAll((elements) =>
      elements
        .filter((element) => element.checkVisibility())
        .map((element) => ({
          label: element.textContent,
          y: Math.round(element.getBoundingClientRect().y),
        })),
    );
  const before = await layout();
  await editor.press("Escape");
  await expect(editor).toHaveCount(0);
  await expect(canvas).toBeFocused();
  await expect(layer).toHaveAttribute("data-node-id", id);
  await expect(layer.locator("[data-design-text]")).toHaveText("A consistent inspector");
  expect(await layout()).toEqual(before);
  const x = page.getByRole("spinbutton", { name: "X", exact: true });
  const previousX = Number(await x.inputValue());
  await canvas.press("ArrowRight");
  await expect(x).toHaveValue(String(previousX + 1));
  await canvas.press("Enter");
  await expect(editor).toBeFocused();
  expect(await layout()).toEqual(before);
  await inspector
    .locator("summary")
    .filter({ hasText: /^Formatting$/ })
    .click();
  await editor.press("ControlOrMeta+a");
  await editor.press("ControlOrMeta+b");
  const expanded = await layout();
  await editor.press("Escape");
  await expect(canvas).toBeFocused();
  expect(await layout()).toEqual(expanded);
  const bold = inspector.getByRole("button", { name: "Bold", exact: true });
  await expect(bold).toHaveAttribute("aria-pressed", "true");
  await bold.click();
  await expect(bold).toHaveAttribute("aria-pressed", "false");
  await expect(layer.locator("[data-design-text] span").first()).toHaveCSS("font-weight", "400");
  await inspector.getByRole("button", { name: "Bulleted list", exact: true }).click();
  await expect(layer.locator("ul li")).toHaveText("A consistent inspector");
  await canvas.focus();
  await canvas.press("Enter");
  await editor.press("ControlOrMeta+a");
  const link = inspector.getByRole("textbox", { name: "Text selection link", exact: true });
  await link.fill("https://example.com");
  await link.press("Escape");
  await expect(editor).toHaveCount(0);
  await expect(canvas).toBeFocused();
  await expect(layer).toHaveAttribute("data-node-id", id);
  await expect(layer.locator('a[href="https://example.com"]')).toHaveText("A consistent inspector");
});

test("one Escape on a narrow canvas preserves selection without opening a panel", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const canvas = await openEditor(page, true);
  await page.getByRole("button", { name: /^Zoom \d+%$/ }).click();
  await page.getByRole("menuitem", { name: /^Zoom to 100%/ }).click();
  await page.getByRole("button", { name: "Text tool", exact: true }).click();
  const bounds = required(await canvas.boundingBox());
  await page.mouse.click(bounds.x + 120, bounds.y + 220);
  const editor = page.getByRole("textbox", { name: "Edit Text", exact: true });
  await page.keyboard.type("Mobile text");
  await editor.press("Escape");
  await expect(editor).toHaveCount(0);
  await expect(canvas).toBeFocused();
  await expect(page.getByLabel("Inspector", { exact: true })).toBeHidden();
  const layer = page.locator('[data-node-id][data-selected="true"]');
  await expect(layer.locator("[data-design-text]")).toHaveText("Mobile text");
  await canvas.press("Enter");
  await expect(editor).toBeFocused();
  await editor.press("Escape");
  await expect(editor).toHaveCount(0);
  await expect(page.getByLabel("Inspector", { exact: true })).toBeHidden();
  await layer.click();
  await expect(page.getByLabel("Inspector", { exact: true })).toBeVisible();
});

test("inherited percentage line height displays correctly and converts between modes", async ({
  page,
}) => {
  const canvas = await openEditor(page);
  await page.getByRole("button", { name: "Select Welcome heading", exact: true }).first().click();
  const source = page.locator('[data-node-id="desktop-heading"]');
  const sourceLineHeight = await source.evaluate((element) => getComputedStyle(element).lineHeight);
  await page.getByRole("button", { name: "Text tool", exact: true }).click();
  const mode = page
    .getByText("Line height mode", { exact: true })
    .locator("..")
    .getByRole("button");
  const percent = page.getByRole("spinbutton", { name: "Line height %", exact: true });
  await expect(mode).toContainText("%");
  await expect(percent).toHaveValue("135");
  await mode.click();
  await page.getByRole("menuitemradio", { name: "px", exact: true }).click();
  const pixels = page.getByRole("spinbutton", { name: "Line height px", exact: true });
  expect(Number(await pixels.inputValue())).toBeCloseTo(parseFloat(sourceLineHeight), 2);
  await mode.click();
  await page.getByRole("menuitemradio", { name: "%", exact: true }).click();
  await expect(percent).toHaveValue("135");
  await percent.fill("150");
  await percent.press("Enter");
  await canvas.focus();
  await canvas.press("Enter");
  const editor = page.getByRole("textbox", { name: "Edit Text", exact: true });
  await expect(editor).toBeFocused();
  await page.keyboard.type("Inherited spacing");
  await editor.press("Escape");
  const layer = page.locator('[data-node-id][data-selected="true"]');
  expect(
    await layer.evaluate((element) => {
      const style = getComputedStyle(element);
      return parseFloat(style.lineHeight) / parseFloat(style.fontSize);
    }),
  ).toBeCloseTo(1.5);
  await canvas.press("t");
  await expect(percent).toHaveValue("150");
  await percent.fill("");
  await percent.press("Enter");
  await expect(mode).toContainText("Auto");
  await expect(percent).toBeHidden();
});

test("agent setup has functional client tabs, copying, dismissal, and focus return", async ({
  page,
  context,
}) => {
  await openEditor(page);
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const trigger = page.getByRole("button", { name: "Connect your agent", exact: true });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "Connect your agent", exact: true });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Copy setup prompt", exact: true }).click();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toContain("organization_id");
  expect(copied).toContain("/api/mcp");
  await dialog.getByRole("tab", { name: "Claude Code", exact: true }).click();
  await dialog
    .locator("summary")
    .filter({ hasText: /^Manual setup$/ })
    .click();
  await expect(
    dialog.getByRole("heading", { name: "Add Tidy to Claude Code", exact: true }),
  ).toBeVisible();
  await expect(dialog.locator("code").first()).toContainText("claude mcp add");
  await dialog.getByRole("button", { name: "Copy command", exact: true }).first().click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain("claude mcp add");
  await dialog.getByRole("tab", { name: "Claude Code", exact: true }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(dialog.getByRole("tab", { name: "OpenCode", exact: true })).toBeFocused();
  await expect(dialog.locator("code").first()).toContainText("opencode mcp add");
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await expect(trigger).toBeFocused();
  await trigger.click();
  await dialog.getByRole("button", { name: "Done", exact: true }).click();
  await expect(trigger).toBeFocused();
});

test("narrow editor leaves the canvas usable while placing and editing text", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const canvas = await openEditor(page, true);
  await expect(page.getByRole("button", { name: "Page settings", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Text tool", exact: true }).click();
  await expect(page.getByLabel("Inspector", { exact: true })).toBeHidden();
  await page.getByRole("button", { name: "Tool settings", exact: true }).click();
  await expect(page.getByRole("spinbutton", { name: "Font size", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Close inspector", exact: true }).click();
  const bounds = required(await canvas.boundingBox());
  await page.mouse.click(bounds.x + 160, bounds.y + 180);
  const editor = page.getByRole("textbox", { name: "Edit Text", exact: true });
  await expect(editor).toBeFocused();
  await expect(page.getByLabel("Inspector", { exact: true })).toBeHidden();
  await page.keyboard.type("Visible on the canvas");
  await expect(editor).toHaveText("Visible on the canvas");
  const after = required(await canvas.boundingBox());
  expect(after.width).toBe(bounds.width);
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(editor).toBeFocused();
  await expect(page.getByLabel("Inspector", { exact: true })).toBeVisible();
  await expect(page.getByRole("spinbutton", { name: "Font size", exact: true })).toBeVisible();
});

test("switching to a narrow canvas dismisses agent setup with its sidebar", async ({ page }) => {
  const canvas = await openEditor(page);
  await page.getByRole("button", { name: "Connect your agent", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Connect your agent", exact: true });
  await expect(dialog).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(dialog).toBeHidden();
  await expect(page.locator("dialog").filter({ hasText: "Connect your agent" })).toHaveJSProperty(
    "open",
    false,
  );
  await expect(canvas).toBeVisible();
  await page.getByRole("button", { name: "Text tool", exact: true }).click();
  await canvas.focus();
  await canvas.press("Enter");
  await expect(page.getByRole("textbox", { name: "Edit Text", exact: true })).toBeFocused();
  await expect(page.getByRole("button", { name: "Page settings", exact: true })).toHaveCount(0);
});
