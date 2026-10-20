import { test, expect, required } from "./fixtures";

for (const colorScheme of ["light", "dark"] as const) {
  test(`selection colour picker edits continuously beside the row in ${colorScheme} mode`, async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme });
    await page.goto("/dev/import-preview?edit=1");
    await page
      .getByRole("button", { name: "Select Authentication panel", exact: true })
      .first()
      .click();
    const swatch = page.getByRole("button", {
      name: "Open selection colour #1e1e1e palette",
      exact: true,
    });
    await swatch.click();
    const picker = page.getByRole("dialog", { name: "Colour picker", exact: true });
    await expect(picker.getByRole("textbox", { name: "Hex colour", exact: true })).toHaveValue(
      "#1E1E1E",
    );
    const bounds = required(await picker.boundingBox());
    const row = required(await swatch.boundingBox());
    expect(bounds.x + bounds.width).toBeLessThan(row.x);
    const hex = picker.getByRole("textbox", { name: "Hex colour", exact: true });
    await hex.fill("#224466");
    await hex.press("Enter");
    await expect(picker).toBeVisible();
    await expect(page.locator('[data-node-id="desktop-heading"]')).toHaveCSS(
      "color",
      "rgb(34, 68, 102)",
    );
    const hue = picker.getByRole("slider", { name: "Hue", exact: true });
    await hue.focus();
    await hue.press("ArrowRight");
    await hue.press("ArrowRight");
    await expect(picker).toBeVisible();
    const square = required(
      await picker.getByRole("group", { name: "Saturation and brightness" }).boundingBox(),
    );
    await page.mouse.move(square.x + 50, square.y + 50);
    await page.mouse.down();
    await page.mouse.move(square.x + 150, square.y + 90, { steps: 8 });
    await page.mouse.up();
    await expect(picker).toBeVisible();
    const opacity = picker.getByRole("slider", { name: "Opacity", exact: true });
    await opacity.focus();
    await opacity.press("Home");
    await expect(picker.getByRole("spinbutton", { name: "Opacity %", exact: true })).toHaveValue(
      "0",
    );
    await picker.getByRole("button", { name: "Restore previous colour" }).click();
    await expect(hex).toHaveValue("#1E1E1E");
    await expect(page.locator('[data-node-id="desktop-heading"]')).toHaveCSS(
      "color",
      "rgb(30, 30, 30)",
    );
    const eyedropper = picker.getByRole("button", { name: "Pick from canvas", exact: true });
    await expect(eyedropper).toHaveText("");
    await expect(eyedropper.locator("span")).not.toHaveCSS("mask-image", /undefined/);
    await hue.focus();
    await hue.press("Escape");
    await expect(picker).toHaveCount(0);
    await expect(swatch).toBeFocused();
    await swatch.click();
    await page.getByRole("heading", { name: "Selection colours", exact: true }).click();
    await expect(picker).toHaveCount(0);
  });
}

test("eyedropper samples the canvas from a selection colour picker", async ({ page }) => {
  await page.goto("/dev/import-preview?edit=1");
  await page
    .getByRole("button", { name: "Select Authentication panel", exact: true })
    .first()
    .click();
  await page
    .getByRole("button", { name: "Open selection colour #1e1e1e palette", exact: true })
    .click();
  await page.getByRole("button", { name: "Pick from canvas", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Colour picker", exact: true })).toHaveCount(0);
  const canvas = page.getByLabel("Design canvas", { exact: true });
  const heading = page.locator('[data-node-id="desktop-heading"]');
  await expect(canvas).toHaveCSS("cursor", "none");
  await expect(heading).toHaveCSS("cursor", "none");
  const marker = page.locator("[data-canvas-color-picker-cursor]");
  const headingBox = required(await heading.boundingBox());
  const pointer = { x: headingBox.x + 10, y: headingBox.y + 5 };
  await page.mouse.move(pointer.x, pointer.y);
  await expect(marker).toBeVisible();
  await expect(marker).toHaveCSS("background-image", /eyedropper-cursor/);
  const markerBox = required(await marker.boundingBox());
  expect(markerBox.x).toBeCloseTo(pointer.x - 3, 0);
  expect(markerBox.y).toBeCloseTo(pointer.y - 21, 0);
  await canvas.click({ position: { x: 5, y: 150 } });
  await expect(canvas).toHaveCSS("cursor", "none");
  const source = required(await page.locator('[data-node-id="desktop-screen"]').boundingBox());
  await page.mouse.click(source.x + 10, source.y + 10);
  await expect(heading).toHaveCSS("color", "rgb(242, 242, 240)");
  await expect(canvas).not.toHaveCSS("cursor", "none");
  await expect(marker).toHaveCount(0);
  await page
    .getByRole("button", { name: "Open selection colour #f2f2f0 palette", exact: true })
    .click();
  await page.getByRole("button", { name: "Pick from canvas", exact: true }).click();
  await expect(canvas).toHaveCSS("cursor", "none");
  await page.keyboard.press("Escape");
  await expect(canvas).not.toHaveCSS("cursor", "none");
  await expect(marker).toHaveCount(0);
});
