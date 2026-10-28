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

for (const failure of [
  "pointer capture loss",
  "an intercepted release",
  "release detected by movement",
  "release detected by capture loss",
] as const) {
  test(`quick drops survive ${failure} and remain undoable once`, async ({ page }) => {
    await page.goto("/dev/hover-preview");
    await page.getByRole("button", { name: "Rectangle tool", exact: true }).click();
    await page.mouse.move(900, 550);
    await page.mouse.down();
    await page.mouse.move(1000, 650);
    await page.mouse.up();
    await page.getByRole("button", { name: "Select tool", exact: true }).click();
    const rectangle = page.locator("[data-node-id]").last();
    const canvas = page.getByLabel("Design canvas", { exact: true });
    await page.waitForTimeout(300);
    const before = required(await rectangle.boundingBox());
    const x = before.x + before.width / 2,
      y = before.y + before.height / 2;
    await page.keyboard.down("Control");
    await page.mouse.move(x, y);
    await page.mouse.down();
    await canvas.evaluate((element, failure) => {
      if (failure === "pointer capture loss")
        element.addEventListener(
          "pointermove",
          (event) => {
            if (event instanceof PointerEvent) element.releasePointerCapture(event.pointerId);
          },
          { once: true },
        );
      else if (failure === "an intercepted release")
        element.addEventListener("pointerup", (event) => event.stopPropagation(), { once: true });
      else
        element.addEventListener(
          "pointermove",
          (event) => {
            if (!(event instanceof PointerEvent)) return;
            element.dispatchEvent(
              new PointerEvent(
                failure === "release detected by movement" ? "pointermove" : "lostpointercapture",
                {
                  pointerId: event.pointerId,
                  clientX: event.clientX + 40,
                  clientY: event.clientY + 30,
                  buttons: 0,
                  ctrlKey: true,
                  bubbles: true,
                },
              ),
            );
          },
          { once: true },
        );
    }, failure);
    await page.mouse.move(x + 40, y + 30);
    await page.mouse.move(x + 80, y + 60);
    await page.mouse.up();
    await page.keyboard.up("Control");
    await expect
      .poll(async () => required(await rectangle.boundingBox()).x - before.x)
      .toBeCloseTo(80, 0);
    await expect
      .poll(async () => required(await rectangle.boundingBox()).y - before.y)
      .toBeCloseTo(60, 0);
    await canvas.focus();
    await page.keyboard.press("ControlOrMeta+z");
    await expect
      .poll(async () => required(await rectangle.boundingBox()).x - before.x)
      .toBeCloseTo(0, 0);
  });
}

test("quick selection and release keep the drop under the pointer while the inspector opens", async ({
  page,
}) => {
  await page.goto("/dev/hover-preview");
  await page.getByRole("button", { name: "Rectangle tool", exact: true }).click();
  await page.mouse.move(900, 550);
  await page.mouse.down();
  await page.mouse.move(1000, 650);
  await page.mouse.up();
  await page.getByRole("button", { name: "Select tool", exact: true }).click();
  const rectangle = page.locator("[data-node-id]").last();
  await rectangle.waitFor();
  await page.getByRole("button", { name: "Minimize editor panels", exact: true }).click();
  await page.getByLabel("Design canvas", { exact: true }).focus();
  for (let i = 0; i < 3; i++) await page.keyboard.press("Escape");
  await expect(page.locator('[data-kind="inspector"]')).toHaveAttribute("data-open", "false");
  await page.waitForTimeout(350);
  const before = required(await rectangle.boundingBox());
  const x = before.x + before.width / 2,
    y = before.y + before.height / 2;
  await page.keyboard.down("Control");
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x - 60, y - 40);
  await page.mouse.up();
  await page.keyboard.up("Control");
  await expect(page.locator('[data-kind="inspector"]')).toHaveAttribute("data-open", "true");
  await page.waitForTimeout(350);
  const after = required(await rectangle.boundingBox());
  expect(after.x - before.x).toBeCloseTo(-60, 0);
  expect(after.y - before.y).toBeCloseTo(-40, 0);
});

test("selection inspector cycles do not drift artwork while explicit resizes preserve its center", async ({
  page,
}) => {
  await page.goto("/dev/hover-preview");
  const card = page.locator('[data-node-id="hover-card"]');
  const canvas = page.getByLabel("Design canvas", { exact: true });
  const inspector = page.locator('[data-kind="inspector"]');
  await page.getByRole("button", { name: "Minimize editor panels", exact: true }).click();
  await page.waitForTimeout(350);
  const before = required(await card.boundingBox());
  for (let i = 0; i < 4; i++) {
    await card.click({ position: { x: 12, y: 12 } });
    await expect(inspector).toHaveAttribute("data-open", "true");
    await page.waitForTimeout(i % 2 ? 40 : 350);
    expect(required(await card.boundingBox()).x).toBeCloseTo(before.x, 1);
    if (i % 2) await page.mouse.click(20, 700);
    else {
      await canvas.focus();
      await page.keyboard.press("Escape");
    }
    await expect(inspector).toHaveAttribute("data-open", "false");
    await page.waitForTimeout(350);
    expect(required(await card.boundingBox()).x).toBeCloseTo(before.x, 1);
  }
  const offset = async () => {
    const node = required(await card.boundingBox());
    const viewport = required(await canvas.boundingBox());
    return {
      x: node.x - viewport.x - viewport.width / 2,
      y: node.y - viewport.y - viewport.height / 2,
    };
  };
  const centered = await offset();
  for (const name of ["Expand editor panels", "Minimize editor panels"]) {
    await page.getByRole("button", { name, exact: true }).click();
    await page.waitForTimeout(350);
    expect((await offset()).x).toBeCloseTo(centered.x, 1);
  }
  for (const width of [1320, 700, 660, 1320]) {
    await page.setViewportSize({ width, height: 900 });
    await page.waitForTimeout(100);
    const resized = await offset();
    expect(resized.x).toBeCloseTo(centered.x, 1);
    expect(resized.y).toBeCloseTo(centered.y, 1);
    if (width === 700) {
      await card.click({ position: { x: 12, y: 12 } });
      await expect(inspector).toHaveAttribute("data-open", "true");
    }
  }
});

test("canvas stylesheet defaults survive appearance edits and undo", async ({ page }) => {
  await page.goto("/dev/hover-preview");
  await page.getByRole("button", { name: "Select Header", exact: true }).click();
  const layer = page.locator('[data-node-id="hover-header"]');
  const defaults = async () => {
    await expect(layer).toHaveCSS("box-sizing", "border-box");
    await expect(layer).toHaveCSS("flex-direction", "row");
    await expect(layer).toHaveCSS("flex-wrap", "nowrap");
    await expect(layer).toHaveCSS("border-top-color", "rgb(0, 0, 0)");
    await expect(layer).toHaveCSS("border-top-style", "solid");
    await expect(layer).toHaveCSS("border-top-width", "0px");
    await expect(layer).toHaveCSS("border-top-left-radius", "0px");
    await expect(layer).toHaveCSS("border-image-source", "none");
  };
  await defaults();
  await page
    .locator("summary")
    .filter({ hasText: /^Add appearance$/ })
    .click();
  await page.getByRole("button", { name: "Add stroke", exact: true }).click();
  await expect(layer).not.toHaveCSS("border-image-source", "none");
  const stroke = await layer.evaluate((element) => getComputedStyle(element).borderImageSource);
  await page.getByLabel("Design canvas", { exact: true }).focus();
  await page.keyboard.press("ControlOrMeta+z");
  await defaults();
  await page.keyboard.press("ControlOrMeta+Shift+z");
  await expect(layer).toHaveCSS("border-image-source", stroke);
  await expect(page.locator('[data-node-id="hover-table"]')).toHaveCSS("flex-direction", "column");
  await expect(page.locator('[data-node-id="hover-title"]')).toHaveCSS("flex-direction", "column");
});
