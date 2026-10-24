import { test, expect, required } from "./fixtures";

test.beforeEach(async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.removeLocatorHandler(
    page
      .getByRole("spinbutton", { name: "Export scale", exact: true })
      .and(page.locator('[value="2"]')),
  );
  await page.goto("/dev/import-preview?edit=1&file=clipboard-source");
  await page.getByRole("button", { name: "Select Email input", exact: true }).first().click();
  await page.keyboard.press("ControlOrMeta+c");
  await page.goto("/dev/import-preview?edit=1&file=clipboard-target");
  await expect(page.getByRole("button", { name: "Select tool", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
});

test("normal cross-file paste preserves destination-relative position regardless of the pointer", async ({
  page,
}) => {
  await page.getByRole("button", { name: "Select Desktop 1440 · /login", exact: true }).click();
  const canvas = page.getByRole("region", { name: "Design canvas", exact: true });
  const bounds = required(await canvas.boundingBox());
  await page.mouse.move(bounds.x + bounds.width - 40, bounds.y + bounds.height - 40);
  await canvas.focus();
  await page.keyboard.press("ControlOrMeta+v");
  const pasted = page.locator('[data-node-id][data-selected="true"]');
  await expect(pasted).toHaveCount(1);
  expect(
    await pasted.evaluate((element) => ({
      parent: element.parentElement?.closest<HTMLElement>("[data-node-id]")?.dataset.nodeId,
      x: element.style.left,
      y: element.style.top,
    })),
  ).toEqual({ parent: "desktop-screen", x: "0px", y: "222px" });
  await page.keyboard.press("ControlOrMeta+z");
  await expect(page.locator("[data-node-id]")).toHaveCount(30);
});

test("paste here uses the context-menu location and remains undoable", async ({ page }) => {
  await page.getByRole("button", { name: "Select Desktop 1440 · /login", exact: true }).click();
  const canvas = page.getByRole("region", { name: "Design canvas", exact: true });
  const bounds = required(await canvas.boundingBox());
  const point = { x: bounds.x + bounds.width - 50, y: bounds.y + bounds.height - 80 };
  await page.mouse.click(point.x, point.y, { button: "right" });
  const menu = page.getByRole("menu", { name: "Canvas actions", exact: true });
  await expect(menu).toBeVisible();
  await menu.getByRole("menuitem", { name: "Paste here", exact: true }).click();
  const pasted = page.locator('[data-node-id][data-selected="true"]');
  await expect(pasted).toHaveCount(1);
  const result = required(await pasted.boundingBox());
  expect(result.x).toBeCloseTo(point.x, 0);
  expect(result.y).toBeCloseTo(point.y, 0);
  expect(
    await pasted.evaluate((element) => element.parentElement?.closest("[data-node-id]") ?? null),
  ).toBeNull();
  await canvas.focus();
  await page.keyboard.press("ControlOrMeta+z");
  await expect(page.locator("[data-node-id]")).toHaveCount(30);
});

test("read-only canvas does not expose paste here or accept a layer paste", async ({ page }) => {
  await page.goto("/dev/import-preview?viewer=1&file=clipboard-readonly");
  const canvas = page.getByRole("region", { name: "Design canvas", exact: true });
  await canvas.focus();
  await page.keyboard.press("ControlOrMeta+v");
  const bounds = required(await canvas.boundingBox());
  await page.mouse.click(bounds.x + bounds.width - 50, bounds.y + bounds.height - 80, {
    button: "right",
  });
  await expect(page.getByRole("menuitem", { name: "Paste here", exact: true })).toHaveCount(0);
  await expect(page.locator("[data-node-id]")).toHaveCount(30);
});
