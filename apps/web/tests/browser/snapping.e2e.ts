import sharp from "sharp";
import type { Page } from "playwright/test";
import { test, expect, required } from "./fixtures";

declare global {
  interface Window {
    snapReads: Record<string, number>;
    restoreSnapReads: () => void;
  }
}

test.beforeEach(async ({ page }) => {
  await page.removeLocatorHandler(
    page
      .getByRole("spinbutton", { name: "Export scale", exact: true })
      .and(page.locator('[value="2"]')),
  );
});

async function openScene(page: Page, nodes = 0) {
  await page.goto(`/dev/snapping-preview?nodes=${nodes}`);
  await page.getByRole("button", { name: "Select moving", exact: true }).click();
  await page.getByRole("button", { name: "Minimize editor panels", exact: true }).click();
  await page.getByRole("button", { name: /^Zoom / }).click();
  const snap = page.getByRole("menuitemcheckbox", { name: "Snap to objects", exact: true });
  if ((await snap.getAttribute("aria-checked")) !== "true") await snap.click();
  await page.getByRole("menuitem", { name: /^Zoom to 100%/ }).click();
  const moving = required(await page.locator('[data-node-id="moving"]').boundingBox());
  const target = required(await page.locator('[data-node-id="target"]').boundingBox());
  return { moving, target, x: moving.x + moving.width / 2, y: moving.y + moving.height / 2 };
}

test("held alignment reuses geometry beside 5000 imported children", async ({ page }) => {
  const scene = await openScene(page, 5000);
  await expect(page.locator('[data-node-id^="detail-"]')).toHaveCount(5000);
  await page.evaluate(() => {
    const reads: Record<string, number> = {};
    const original = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function () {
      const id = this.getAttribute("data-node-id");
      if (id) reads[id] = (reads[id] ?? 0) + 1;
      return original.call(this);
    };
    window.snapReads = reads;
    window.restoreSnapReads = () => {
      Element.prototype.getBoundingClientRect = original;
    };
  });
  try {
    await page.mouse.move(scene.x, scene.y);
    await page.mouse.down();
    await page.mouse.move(scene.x + scene.target.x - scene.moving.x - 2, scene.y);
    await expect(page.locator('[data-snap-guide="x"]')).toHaveCount(1);
    const first = await page.evaluate(() => ({ ...window.snapReads }));
    for (const offset of [2, 4, 7, 3, -2, 8]) {
      await page.mouse.move(scene.x + scene.target.x - scene.moving.x + offset, scene.y);
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
      );
    }
    const reads: Record<string, number> = await page.evaluate(() => window.snapReads);
    expect(Object.keys(reads).filter((id) => id.startsWith("detail-"))).toEqual([]);
    expect(first.target).toBeGreaterThan(0);
    expect(first.competitor).toBeGreaterThan(0);
    expect(reads).toEqual(first);
    expect(required(await page.locator('[data-node-id="moving"]').boundingBox()).x).toBeCloseTo(
      scene.target.x,
      1,
    );
    await page.mouse.up();
    await expect(page.locator("[data-canvas-alignment]")).toHaveCount(0);
  } finally {
    await page.evaluate(() => window.restoreSnapReads());
  }
});

test("alignment lines remain visible where they cross artwork", async ({ page }) => {
  const scene = await openScene(page);
  await page.mouse.move(scene.x, scene.y);
  await page.mouse.down();
  await page.mouse.move(scene.x, scene.y + scene.target.y - scene.moving.y - 1);
  const guide = page.locator('[data-snap-guide="y"]');
  await expect(guide).toBeVisible();
  const line = required(await guide.boundingBox());
  const artwork = required(await page.locator('[data-node-id="occluder"]').boundingBox());
  const x = Math.round(artwork.x + artwork.width / 2);
  expect(x).toBeGreaterThan(line.x);
  expect(x).toBeLessThan(line.x + line.width);
  const pixel = await page.screenshot({ clip: { x, y: line.y, width: 1, height: 1 } });
  const reference = await page.screenshot({
    clip: {
      x: Math.round(scene.moving.x + scene.moving.width + 12),
      y: line.y,
      width: 1,
      height: 1,
    },
  });
  const actual = await sharp(pixel).removeAlpha().raw().toBuffer();
  const expected = await sharp(reference).removeAlpha().raw().toBuffer();
  expect([...actual]).toEqual([...expected]);
  const surface = await page.screenshot({ clip: { x, y: line.y + 4, width: 1, height: 1 } });
  expect([...actual]).not.toEqual([...(await sharp(surface).removeAlpha().raw().toBuffer())]);
  await page.mouse.up();
});

test("modifier bypass clears a cached alignment without changing position", async ({ page }) => {
  const scene = await openScene(page);
  const source = page.locator('[data-node-id="moving"]');
  const x = scene.x + scene.target.x - scene.moving.x;
  await page.mouse.move(scene.x, scene.y);
  await page.mouse.down();
  await page.mouse.move(x - 2, scene.y);
  await expect(page.locator('[data-snap-guide="x"]')).toHaveCount(1);
  await page.keyboard.down("Control");
  await page.mouse.move(x, scene.y);
  await expect(page.locator("[data-canvas-alignment]")).toHaveCount(0);
  expect(required(await source.boundingBox()).x).toBeCloseTo(scene.target.x, 1);
  await page.keyboard.up("Control");
  await page.mouse.move(x + 4, scene.y);
  await expect
    .poll(async () => required(await source.boundingBox()).x)
    .toBeCloseTo(scene.target.x + 4, 1);
  await page.mouse.up();
});

test("focus loss clears the drag preview and prevents a late commit", async ({ page }) => {
  const scene = await openScene(page);
  await page.mouse.move(scene.x, scene.y);
  await page.mouse.down();
  await page.mouse.move(scene.x + scene.target.x - scene.moving.x - 2, scene.y);
  await expect(page.locator('[data-snap-guide="x"]')).toHaveCount(1);
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  await expect(page.locator("[data-canvas-alignment]")).toHaveCount(0);
  await page.mouse.move(scene.x + 30, scene.y + 10);
  await page.mouse.up();
  const restored = required(await page.locator('[data-node-id="moving"]').boundingBox());
  expect(restored.x).toBeCloseTo(scene.moving.x, 2);
  expect(restored.y).toBeCloseTo(scene.moving.y, 2);
});
