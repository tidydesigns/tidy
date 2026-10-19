import { test, expect, required } from "./fixtures";

test("artboard titles share selection, names, undo, and zoom with the layer tree", async ({
  page,
}) => {
  await page.goto("/dev/import-preview?edit=1");
  const label = page.locator('[data-artboard-label="desktop-screen"]');
  const title = label.getByRole("button");
  await expect(title).toHaveText("Desktop 1440 · /login");
  await expect(page.locator("[data-artboard-label]")).toHaveCount(2);
  await expect(page.locator("[data-node-id] [data-artboard-label]")).toHaveCount(0);
  await title.click();
  await expect(page.locator('[data-layer-row="desktop-screen"]')).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(page.getByRole("textbox", { name: "Layer name", exact: true })).toHaveValue(
    "Desktop 1440 · /login",
  );
  await title.dblclick();
  const input = label.getByRole("textbox", { name: "Artboard name" });
  await input.fill("01 · Landing page");
  await input.press("Enter");
  await expect(title).toHaveText("01 · Landing page");
  await expect(
    page.getByRole("button", { name: "Select 01 · Landing page", exact: true }),
  ).toBeVisible();
  const inspector = page.getByRole("textbox", { name: "Layer name", exact: true });
  await expect(inspector).toHaveValue("01 · Landing page");
  await inspector.fill("02 · Updated in inspector");
  await inspector.press("Enter");
  await expect(title).toHaveText("02 · Updated in inspector");
  await page.getByRole("region", { name: "Design canvas" }).focus();
  await page.keyboard.press("ControlOrMeta+z");
  await expect(title).toHaveText("01 · Landing page");
  await title.dblclick();
  await input.fill("Cancelled rename");
  await input.press("Escape");
  await expect(title).toHaveText("01 · Landing page");
  await title.dblclick();
  await input.fill("   ");
  await input.press("Enter");
  await expect(title).toHaveText("01 · Landing page");
  const before = required(await title.boundingBox());
  await page
    .getByRole("button", { name: /^Zoom / })
    .first()
    .click();
  await page.getByRole("menuitem", { name: "Zoom to 100%" }).click();
  await expect
    .poll(async () => required(await title.boundingBox()).height)
    .toBeCloseTo(before.height, 0);
  const frame = required(await page.locator('[data-node-id="desktop-screen"]').boundingBox());
  const after = required(await title.boundingBox());
  expect(Math.abs(after.x - frame.x)).toBeLessThan(2);
  expect(after.y + after.height).toBeLessThan(frame.y);
});

test("artboard titles support additive and layer selection, visibility, and locked names", async ({
  page,
}) => {
  await page.goto("/dev/import-preview?edit=1");
  const desktop = page.locator('[data-artboard-label="desktop-screen"]');
  const mobile = page.locator('[data-artboard-label="mobile-screen"]');
  await desktop.getByRole("button").click();
  await mobile.getByRole("button").click({ modifiers: ["Shift"] });
  await expect(desktop.getByRole("button")).toHaveAttribute("aria-pressed", "true");
  await expect(mobile.getByRole("button")).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Select Desktop 1440 · /login", exact: true }).click();
  await expect(mobile.getByRole("button")).toHaveAttribute("aria-pressed", "false");
  await page.getByRole("button", { name: "Lock Desktop 1440 · /login", exact: true }).click();
  await desktop.getByRole("button").dblclick();
  await expect(desktop.getByRole("textbox")).toHaveCount(0);
  await page.getByRole("button", { name: "Unlock Desktop 1440 · /login", exact: true }).click();
  await page.getByRole("button", { name: "Hide Desktop 1440 · /login", exact: true }).click();
  await expect(desktop).toHaveCount(0);
  await page.getByRole("button", { name: "Show Desktop 1440 · /login", exact: true }).click();
  await expect(desktop.getByRole("button")).toBeVisible();
});

test("viewers can select artboard titles without renaming", async ({ page }) => {
  await page.goto("/dev/import-preview?edit=1&viewer=1");
  const label = page.locator('[data-artboard-label="desktop-screen"]');
  await label.getByRole("button").dblclick();
  await expect(label.getByRole("button")).toHaveAttribute("aria-pressed", "true");
  await expect(label.getByRole("textbox")).toHaveCount(0);
});

test("titles follow rotated artboards and blur preserves the next selection", async ({ page }) => {
  await page.goto("/dev/import-preview?edit=1");
  const desktop = page.locator('[data-artboard-label="desktop-screen"]');
  await desktop.getByRole("button").click();
  const rotation = page.getByRole("spinbutton", { name: "Rotation", exact: true });
  await rotation.fill("30");
  await rotation.press("Enter");
  const frame = required(await page.locator('[data-node-id="desktop-screen"]').boundingBox());
  const title = required(await desktop.getByRole("button").boundingBox());
  expect(Math.abs(title.x - frame.x)).toBeLessThan(2);
  expect(title.y + title.height).toBeLessThan(frame.y);
  await desktop.getByRole("button").dblclick();
  const input = desktop.getByRole("textbox");
  await expect(input).toHaveAttribute("maxlength", "120");
  await input.fill("Renamed on blur");
  const mobile = page.locator('[data-artboard-label="mobile-screen"]').getByRole("button");
  await mobile.click();
  await expect(desktop.getByRole("button")).toHaveText("Renamed on blur");
  await expect(mobile).toHaveAttribute("aria-pressed", "true");
  await expect(desktop.getByRole("button")).toHaveAttribute("aria-pressed", "false");
  await page.getByRole("region", { name: "Design canvas" }).focus();
  await page.keyboard.press("ControlOrMeta+z");
  await expect(desktop.getByRole("button")).toHaveText("Desktop 1440 · /login");
});

test("title selection preserves canvas shortcuts and keyboard activation", async ({ page }) => {
  await page.removeLocatorHandler(
    page
      .getByRole("spinbutton", { name: "Export scale", exact: true })
      .and(page.locator('[value="2"]')),
  );
  await page.goto("/dev/import-preview?edit=1");
  const canvas = page.getByRole("region", { name: "Design canvas" });
  const title = page.locator('[data-artboard-label="desktop-screen"]').getByRole("button");
  await title.click();
  await expect(canvas).toBeFocused();
  const x = page.getByRole("spinbutton", { name: "X", exact: true });
  const before = Number(await x.inputValue());
  await page.keyboard.press("ArrowRight");
  await expect(x).toHaveValue(String(before + 1));
  await page.keyboard.press("ControlOrMeta+d");
  await expect(page.locator("[data-artboard-label]")).toHaveCount(3);
  await page.keyboard.press("Delete");
  await expect(page.locator("[data-artboard-label]")).toHaveCount(2);
  await title.focus();
  await title.press("Enter");
  await expect(canvas).toBeFocused();
  await expect(page.locator('[data-layer-row="desktop-screen"]')).toHaveAttribute(
    "aria-selected",
    "true",
  );
  const mobile = page.locator('[data-artboard-label="mobile-screen"]').getByRole("button");
  await mobile.focus();
  await mobile.press("Space");
  await expect(canvas).toBeFocused();
  await expect(mobile).toHaveAttribute("aria-pressed", "true");
});

test("narrow artboard titles remain readable at low zoom", async ({ page }) => {
  await page.goto("/dev/import-preview?edit=1");
  const canvas = page.getByRole("region", { name: "Design canvas" });
  const title = page.locator('[data-artboard-label="mobile-screen"]').getByRole("button");
  await title.waitFor();
  await canvas.focus();
  await page.keyboard.press("Shift+0");
  for (let step = 0; step < 11; step++) await page.keyboard.press("-");
  await expect(page.getByRole("button", { name: /^Zoom / }).first()).toContainText("10%");
  const bounds = required(await title.boundingBox());
  expect(bounds.width).toBeGreaterThan(100);
  expect(bounds.height).toBeCloseTo(24, 0);
  expect(await title.evaluate((button) => button.scrollWidth <= button.clientWidth)).toBe(true);
  await expect(title).toHaveAttribute("title", "Mobile 390 · /login");
});
