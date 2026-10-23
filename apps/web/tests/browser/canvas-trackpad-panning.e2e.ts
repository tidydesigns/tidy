import { test, expect, required } from "./fixtures";

for (const fixture of [
  { name: "nested artwork", url: "/dev/hover-preview?complex=1" },
  { name: "dense artwork", url: "/dev/hover-preview?nodes=5000" },
]) {
  test(`trackpad panning over ${fixture.name} suspends hover through momentum`, async ({
    page,
  }) => {
    await page.goto(fixture.url);
    const canvas = page.getByLabel("Design canvas", { exact: true });
    const board = canvas.locator("[data-node-id]").first();
    await board.hover({ position: { x: 100, y: 100 } });
    await expect(page.locator('[data-hover-kind="target"]')).toHaveCount(1);
    await page.mouse.wheel(0, 8);
    const result = await canvas.evaluate(async (element) => {
      const scene = element.querySelector<HTMLElement>('div[style*="transform: translate("]');
      if (!scene) throw new Error("Missing canvas scene");
      const original = document.elementFromPoint;
      let hits = 0;
      document.elementFromPoint = function (x, y) {
        hits++;
        return original.call(this, x, y);
      };
      const before = new DOMMatrix(getComputedStyle(scene).transform);
      let dx = 0,
        dy = 0,
        hoverFrames = 0;
      try {
        for (const delta of [24, 18, 12, 8, 4, 2, 1, -1, -2, -4, -8, -12]) {
          element.dispatchEvent(
            new WheelEvent("wheel", {
              bubbles: true,
              cancelable: true,
              deltaX: delta / 2,
              deltaY: delta,
            }),
          );
          dx += delta / 2;
          dy += delta;
          await new Promise<void>((resolve) => setTimeout(resolve, 40));
          if (element.querySelector("[data-hover-node-id]")) hoverFrames++;
        }
        const after = new DOMMatrix(getComputedStyle(scene).transform);
        return {
          hits,
          hoverFrames,
          error: Math.max(
            Math.abs(after.m41 - before.m41 + dx),
            Math.abs(after.m42 - before.m42 + dy),
          ),
          scrollY: window.scrollY,
        };
      } finally {
        document.elementFromPoint = original;
      }
    });
    expect(result.hoverFrames).toBe(0);
    expect(result.hits).toBe(0);
    expect(result.error).toBeLessThan(0.01);
    expect(result.scrollY).toBe(0);
    await expect(page.locator('[data-hover-kind="target"]')).toHaveCount(1);
    await expect(page.locator('[data-selected="true"]')).toHaveCount(0);
    await board.click({ position: { x: 100, y: 100 } });
    await expect(board).toHaveAttribute("data-selected", "true");
  });
}

test("pinch zoom pauses canvas hover and a click can select before the gesture settles", async ({
  page,
}) => {
  await page.goto("/dev/hover-preview");
  const canvas = page.getByLabel("Design canvas", { exact: true });
  const artwork = page.locator('[data-node-id="hover-card-value"]');
  await artwork.hover();
  await expect(page.locator('[data-hover-kind="target"]')).toHaveCount(1);
  await canvas.evaluate(async (element) => {
    const rect = element.getBoundingClientRect();
    element.dispatchEvent(
      new WheelEvent("wheel", {
        bubbles: true,
        cancelable: true,
        ctrlKey: true,
        deltaY: -20,
        clientX: rect.x + rect.width / 2,
        clientY: rect.y + rect.height / 2,
      }),
    );
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
  });
  await expect(page.locator("[data-hover-node-id]")).toHaveCount(0);
  await artwork.click();
  await expect(page.locator('[data-node-id="hover-board"]')).toHaveAttribute(
    "data-selected",
    "true",
  );
  await expect(page.getByRole("button", { name: /^Zoom / })).toContainText("%");
});

test("leaving the canvas during momentum keeps hover cleared and layer previews respond", async ({
  page,
}) => {
  await page.goto("/dev/hover-preview");
  const canvas = page.getByLabel("Design canvas", { exact: true });
  await page.locator('[data-node-id="hover-card-value"]').hover();
  await page.mouse.wheel(0, 12);
  await page.getByRole("tab", { name: "Layers", exact: true }).hover();
  await page.waitForTimeout(200);
  await expect(page.locator("[data-hover-node-id]")).toHaveCount(0);
  await page.getByRole("button", { name: "Select Votes card", exact: true }).hover();
  await expect(page.locator('[data-hover-node-id="hover-card"]')).toHaveCount(1);
  await expect(canvas).toBeVisible();
});

for (const width of [1440, 700]) {
  test(`native wheel input pans identically over blank space and artwork at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/dev/hover-preview");
    const canvas = page.getByLabel("Design canvas", { exact: true });
    const scene = canvas.locator('div[style*="transform: translate("]').first();
    const view = () =>
      scene.evaluate((element) => {
        const matrix = new DOMMatrix(getComputedStyle(element).transform);
        return { x: matrix.m41, y: matrix.m42, zoom: matrix.a };
      });
    const canvasBox = required(await canvas.boundingBox());
    for (const target of ["blank", "artwork"] as const) {
      if (target === "blank") await page.mouse.move(canvasBox.x + 5, canvasBox.y + 200);
      else await page.locator('[data-node-id="hover-card-value"]').hover();
      const before = await view();
      for (const [dx, dy] of [
        [12, 24],
        [-12, -24],
        [0, -40],
        [0, 40],
      ]) {
        const start = await view();
        await page.mouse.wheel(dx, dy);
        await expect
          .poll(async () => {
            const next = await view();
            return Math.max(Math.abs(next.x - start.x + dx), Math.abs(next.y - start.y + dy));
          })
          .toBeLessThan(0.01);
        expect((await view()).zoom).toBe(before.zoom);
      }
      expect(await view()).toEqual(before);
      expect(await page.evaluate(() => scrollY)).toBe(0);
    }
  });
}

test("Safari gesture events preserve pinch zoom and release ordinary panning", async ({ page }) => {
  await page.goto("/dev/hover-preview");
  const canvas = page.getByLabel("Design canvas", { exact: true });
  await page.locator('[data-node-id="hover-card-value"]').hover();
  await expect(page.locator('[data-hover-kind="target"]')).toHaveCount(1);
  const result = await canvas.evaluate(async (element) => {
    const scene = element.querySelector<HTMLElement>('div[style*="transform: translate("]');
    if (!scene) throw new Error("Missing canvas scene");
    const view = () => new DOMMatrix(getComputedStyle(scene).transform);
    const settle = () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
    const rect = element.getBoundingClientRect();
    const before = view();
    element.dispatchEvent(new Event("gesturestart", { bubbles: true, cancelable: true }));
    element.dispatchEvent(
      Object.assign(new Event("gesturechange", { bubbles: true, cancelable: true }), {
        scale: 1.2,
        clientX: rect.x + rect.width / 2,
        clientY: rect.y + rect.height / 2,
      }),
    );
    await settle();
    const zoomed = view();
    const hoverCount = element.querySelectorAll("[data-hover-node-id]").length;
    element.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: 20 }));
    await settle();
    const during = view();
    element.dispatchEvent(new Event("gestureend", { bubbles: true, cancelable: true }));
    element.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: 20 }));
    await settle();
    const after = view();
    return {
      ratio: zoomed.a / before.a,
      hoverCount,
      ignoredPan: during.m42 - zoomed.m42,
      resumedPan: after.m42 - zoomed.m42,
      finalZoom: after.a / zoomed.a,
    };
  });
  expect(result.ratio).toBeGreaterThan(1);
  expect(result.hoverCount).toBe(0);
  expect(result.ignoredPan).toBe(0);
  expect(result.resumedPan).toBeCloseTo(-20, 3);
  expect(result.finalZoom).toBe(1);
  await expect(page.locator('[data-hover-kind="target"]')).toHaveCount(1);
});
