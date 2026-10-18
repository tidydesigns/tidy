import type { Locator } from "playwright/test";
import { test, expect } from "./fixtures";

async function canvasView(scene: Locator) {
  return scene.evaluate((element) => {
    const transform = new DOMMatrixReadOnly(getComputedStyle(element).transform);
    return { x: transform.m41, y: transform.m42, zoom: transform.a };
  });
}

test("document horizontal overscroll policy covers routes and excluded canvas controls", async ({
  page,
}) => {
  // Chromium wheel input on Linux cannot reproduce macOS's native history swipe.
  // Check the browser's computed prevention policy and ordinary input separately.
  async function expectPolicy() {
    for (const root of [page.locator("html"), page.locator("body")]) {
      await expect(root).toHaveCSS("overscroll-behavior-x", "none");
      await expect(root).toHaveCSS("overscroll-behavior-y", "auto");
    }
  }

  await page.goto("/forgot-password");
  await expectPolicy();
  await page.goto("/dev/import-preview?edit=1&compact=1");
  const canvas = page.getByLabel("Design canvas", { exact: true });
  const scene = canvas.locator('div[style*="transform: translate("]').first();
  const select = page
    .getByRole("toolbar", { name: "Canvas tools", exact: true })
    .getByRole("button", { name: "Select tool", exact: true });
  await select.click();
  await expect(page.locator('[data-node-id="desktop-screen"]')).toBeVisible();
  const before = await canvasView(scene);
  const url = page.url();

  // The compact toolbar sits inside data-canvas-control, which the canvas wheel
  // handler deliberately leaves to native browser behavior.
  for (const deltaX of [240, -240]) {
    await select.hover();
    await select.evaluate((element) => {
      element.setAttribute("data-wheel-settled", "false");
      element.addEventListener(
        "wheel",
        () =>
          requestAnimationFrame(() =>
            requestAnimationFrame(() => element.setAttribute("data-wheel-settled", "true")),
          ),
        { once: true },
      );
    });
    await page.mouse.wheel(deltaX, 0);
    await expect(select).toHaveAttribute("data-wheel-settled", "true");
    await expectPolicy();
    expect(await canvasView(scene)).toEqual(before);
    await expect(page).toHaveURL(url);
  }
});

test("horizontal protection preserves canvas panning, pinch zoom and sidebar scrolling", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 600 });
  await page.goto("/dev/import-preview?edit=1");
  const canvas = page.getByLabel("Design canvas", { exact: true });
  const scene = canvas.locator('div[style*="transform: translate("]').first();
  await page
    .getByRole("toolbar", { name: "Canvas tools", exact: true })
    .getByRole("button", { name: "Select tool", exact: true })
    .click();
  await expect(page.locator('[data-node-id="desktop-screen"]')).toBeVisible();
  const url = page.url();

  await canvas.hover();
  for (const [deltaX, deltaY] of [
    [160, 0],
    [-160, 0],
    [120, 90],
    [-120, -90],
  ]) {
    const before = await canvasView(scene);
    await page.mouse.wheel(deltaX, deltaY);
    await expect
      .poll(async () => {
        const after = await canvasView(scene);
        return Math.max(
          Math.abs(after.x - (before.x - deltaX)),
          Math.abs(after.y - (before.y - deltaY)),
        );
      })
      .toBeLessThan(0.01);
    expect((await canvasView(scene)).zoom).toBe(before.zoom);
    await expect(page).toHaveURL(url);
  }

  const beforeZoom = await canvasView(scene);
  await page.keyboard.down("Control");
  try {
    await page.mouse.wheel(0, -40);
    await expect.poll(async () => (await canvasView(scene)).zoom).toBeGreaterThan(beforeZoom.zoom);
  } finally {
    await page.keyboard.up("Control");
  }
  await expect(page).toHaveURL(url);

  const layers = page.getByRole("tabpanel", { name: "Layers", exact: true });
  await expect
    .poll(() => layers.evaluate((element) => element.scrollHeight - element.clientHeight))
    .toBeGreaterThan(0);
  const beforeSidebarScroll = await canvasView(scene);
  await layers.hover();
  await page.mouse.wheel(0, 240);
  await expect.poll(() => layers.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  expect(await canvasView(scene)).toEqual(beforeSidebarScroll);
  await page.mouse.wheel(0, -240);
  await expect.poll(() => layers.evaluate((element) => element.scrollTop)).toBe(0);
  expect(await canvasView(scene)).toEqual(beforeSidebarScroll);
  await expect(page).toHaveURL(url);
});
