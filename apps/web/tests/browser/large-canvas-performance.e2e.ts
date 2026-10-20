import { test, expect } from "./fixtures";

test("retained artboards restore their existing DOM and selected child geometry", async ({
  page,
}) => {
  await page.goto("/dev/performance-preview?large=1&nodes=5000");
  const search = page.getByRole("textbox", { name: "Search layers", exact: true });
  await search.fill("Large frame 1");
  await page.getByRole("button", { name: "Select Large frame 1", exact: true }).click();
  const canvas = page.getByRole("region", { name: "Design canvas", exact: true });
  await canvas.focus();
  await page.keyboard.press("Shift+2");
  await page.keyboard.press("Shift+0");
  await canvas.hover();
  await page.mouse.wheel(5400, 0);
  const second = page.locator('[data-node-id="large-frame-1"]');
  await expect(second).toBeAttached();
  await expect(second).not.toHaveCSS("content-visibility", "hidden");
  const element = await second.elementHandle();
  if (!element) throw new Error("Missing visited artboard");
  await page.mouse.wheel(-5400, 0);
  await expect(second).toHaveCSS("content-visibility", "hidden");
  expect(await element.evaluate((node) => node.isConnected)).toBe(true);
  await expect(page.locator('[data-node-id="large-frame-0"]')).toHaveAttribute(
    "data-selected",
    "true",
  );
  await search.fill("Stress layer 1001");
  await page.getByRole("button", { name: "Select Stress layer 1001", exact: true }).click();
  await expect(second).not.toHaveCSS("content-visibility", "hidden");
  expect(await element.evaluate((node) => node.isConnected)).toBe(true);
  const width = page.getByRole("spinbutton", { name: "Width", exact: true });
  await expect(width).toHaveValue("44");
  await expect(page.getByLabel("Selection size", { exact: true })).toHaveText("44 × 40");
  await width.fill("80");
  await width.press("Enter");
  await expect(page.locator('[data-node-id="large-layer-1001"]')).toHaveCSS("width", "80px");
  await canvas.focus();
  await page.keyboard.press("Control+z");
  await expect(width).toHaveValue("44");
});

test("paint containment follows the frame's clipping setting", async ({ page }) => {
  await page.goto("/dev/performance-preview?nodes=100");
  await page.getByRole("button", { name: "Select Frame", exact: true }).click();
  const frame = page.locator('[data-node-id="frame-0"]');
  await expect(frame).toHaveCSS("contain", "content");
  await page.getByRole("button", { name: "Overflow Clip", exact: true }).click();
  await page.getByRole("menuitemradio", { name: "Visible", exact: true }).click();
  await expect(frame).toHaveCSS("contain", "none");
  await expect(frame).toHaveCSS("overflow", "visible");
  await page.getByRole("region", { name: "Design canvas", exact: true }).focus();
  await page.keyboard.press("Control+z");
  await expect(frame).toHaveCSS("contain", "content");
});
