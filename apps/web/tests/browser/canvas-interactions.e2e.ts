import { test, expect, required } from "./fixtures";

test.beforeEach(async ({ page }) => {
  await page.removeLocatorHandler(
    page
      .getByRole("spinbutton", { name: "Export scale", exact: true })
      .and(page.locator('[value="2"]')),
  );
});

declare global {
  interface Window {
    selectionReads?: { count: number; restore: () => void };
  }
}

test("selection clicks in a dense artboard do not measure snapping candidates", async ({
  page,
}) => {
  await page.goto("/dev/hover-preview?nodes=5000");
  await page.getByRole("button", { name: "Select Data / Dark", exact: true }).click();
  await page.evaluate(() => {
    const original = Element.prototype.getBoundingClientRect;
    const audit = {
      count: 0,
      restore() {
        Element.prototype.getBoundingClientRect = original;
      },
    };
    window.selectionReads = audit;
    Element.prototype.getBoundingClientRect = function () {
      if (this.hasAttribute("data-node-id")) audit.count++;
      return original.call(this);
    };
  });
  try {
    await page.locator('[data-node-id="dense-25"]').click();
    await expect(page.locator('[data-node-id="dense-25"]')).toHaveAttribute(
      "data-selected",
      "true",
    );
    // Selection handles and scoped hover may measure a few affected nodes;
    // the other 4,999 candidates must not be measured for a click.
    expect(await page.evaluate(() => window.selectionReads?.count)).toBeLessThan(50);
  } finally {
    await page.evaluate(() => {
      window.selectionReads?.restore();
      delete window.selectionReads;
    });
  }
});

test("selection outlines keep screen-pixel widths through zoom and restore layer outlines", async ({
  page,
}) => {
  await page.goto("/dev/hover-preview");
  await page.getByRole("button", { name: "Select Votes card", exact: true }).click();
  const card = page.locator('[data-node-id="hover-card"]');
  await page.getByRole("button", { name: /^Zoom / }).click();
  await page.getByRole("menuitem", { name: /^Zoom to 100%/ }).click();
  const point = required(await card.boundingBox());
  await page.mouse.move(point.x + point.width / 2, point.y + point.height / 2);
  await page.keyboard.down("Control");
  for (const [percent, delta] of [
    [50, Math.log(2) / 0.0075],
    [200, (-2 * Math.log(2)) / 0.0075],
    [100, Math.log(2) / 0.0075],
  ]) {
    await page.mouse.wheel(0, delta);
    await expect(page.getByRole("button", { name: `Zoom ${percent}%`, exact: true })).toBeVisible();
    const actual = await card.evaluate((element) => {
      const style = getComputedStyle(element);
      const scale = element.getBoundingClientRect().width / parseFloat(style.width);
      return {
        width: parseFloat(style.outlineWidth) * scale,
        offset: parseFloat(element.style.outlineOffset) * scale,
        inheritedZoom: style.getPropertyValue("--canvas-zoom"),
      };
    });
    expect(actual.width).toBeCloseTo(2, 1);
    expect(actual.offset).toBeCloseTo(1, 1);
    expect(actual.inheritedZoom).toBe("");
  }
  await page.keyboard.up("Control");
  await page.getByRole("button", { name: "Select Header", exact: true }).click();
  await expect(card).toHaveCSS("outline-style", "none");
});

test("deferred multi-layer drags preserve offsets and support undo and cancellation", async ({
  page,
}) => {
  await page.goto("/dev/hover-preview");
  const card = page.locator('[data-node-id="hover-card"]');
  const header = page.locator('[data-node-id="hover-header"]');
  await page.getByRole("button", { name: "Select Votes card", exact: true }).click();
  await page
    .getByRole("button", { name: "Select Header", exact: true })
    .click({ modifiers: ["Shift"] });
  const before = required(await card.boundingBox());
  const other = required(await header.boundingBox());
  const point = { x: before.x + before.width / 2, y: before.y + before.height / 2 };
  await page.mouse.move(point.x, point.y);
  await page.mouse.down();
  await page.mouse.move(point.x + 40, point.y + 30, { steps: 5 });
  await page.mouse.up();
  await expect
    .poll(async () => required(await card.boundingBox()).x - before.x)
    .toBeGreaterThan(20);
  const moved = required(await card.boundingBox());
  const otherMoved = required(await header.boundingBox());
  expect(otherMoved.x - moved.x).toBeCloseTo(other.x - before.x, 1);
  await page.getByLabel("Design canvas", { exact: true }).focus();
  await page.keyboard.press("ControlOrMeta+z");
  await expect
    .poll(async () => Math.abs(required(await card.boundingBox()).x - before.x))
    .toBeLessThan(0.2);
  await page.mouse.move(point.x, point.y);
  await page.mouse.down();
  await page.mouse.move(point.x + 35, point.y + 25, { steps: 3 });
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await expect
    .poll(async () => Math.abs(required(await card.boundingBox()).x - before.x))
    .toBeLessThan(0.2);
});

test("cached hover restores resize observation after leaving and returning", async ({ page }) => {
  await page.goto("/dev/hover-preview");
  const card = page.locator('[data-node-id="hover-card"]');
  const layer = page.getByRole("button", { name: "Select Votes card", exact: true });
  await layer.hover();
  await expect(page.locator('[data-hover-node-id="hover-card"]')).toHaveCount(1);
  await page.getByRole("tab", { name: "Layers", exact: true }).hover();
  await expect(page.locator('[data-hover-node-id="hover-card"]')).toHaveCount(0);
  await layer.hover();
  await expect(page.locator('[data-hover-node-id="hover-card"]')).toHaveCount(1);
  // Isolate a browser-driven layout change with no document/model update.
  await card.evaluate((element) => {
    element.style.width = "300px";
  });
  await expect
    .poll(async () => {
      const artwork = required(await card.boundingBox());
      const overlay = await page
        .locator('[data-hover-node-id="hover-card"]')
        .evaluate((element) => element.getBoundingClientRect().width);
      return Math.abs(artwork.width - overlay);
    })
    .toBeLessThan(0.2);
});

test("cursor presence reads layout once per frame and cancels pending work on leave", async ({
  page,
}) => {
  await page.goto("/dev/performance-preview?nodes=5000");
  await page.getByRole("button", { name: "Select tool", exact: true }).click();
  const result = await page
    .getByRole("region", { name: "Design canvas", exact: true })
    .evaluate(async (canvas) => {
      const original = Element.prototype.getBoundingClientRect;
      let reads = 0;
      Element.prototype.getBoundingClientRect = function () {
        if (this === canvas) reads++;
        return original.call(this);
      };
      const settle = () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        );
      const move = () =>
        canvas.dispatchEvent(
          new PointerEvent("pointermove", {
            bubbles: true,
            pointerType: "mouse",
            clientX: 500,
            clientY: 400,
          }),
        );
      try {
        for (let i = 0; i < 1000; i++) move();
        await settle();
        const burstReads = reads;
        reads = 0;
        move();
        canvas.dispatchEvent(new PointerEvent("pointerout", { bubbles: true }));
        canvas.dispatchEvent(new PointerEvent("pointerleave"));
        await settle();
        return { burstReads, leaveReads: reads };
      } finally {
        Element.prototype.getBoundingClientRect = original;
      }
    });
  expect(result).toEqual({ burstReads: 1, leaveReads: 0 });
});
