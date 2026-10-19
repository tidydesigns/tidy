import { test, expect, required } from "./fixtures";

const node = (id: string) => `[data-node-id="${id}"]`;
const outline = (id: string) => `[data-hover-node-id="${id}"]`;

// These tests own canvas focus and do not export images.
test.beforeEach(async ({ page }) => {
  await page.removeLocatorHandler(
    page
      .getByRole("spinbutton", { name: "Export scale", exact: true })
      .and(page.locator('[value="2"]')),
  );
});

test("inactive shared editors suppress hover feedback until activated", async ({ page }) => {
  await page.goto("/dev/hover-preview?active=0");
  await page.locator(node("hover-card-value")).hover();
  // Allow the hover measurement frame to run before asserting absence.
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  await expect(page.locator("[data-hover-node-id]")).toHaveCount(0);

  await page.goto("/dev/hover-preview");
  await page.locator(node("hover-card-value")).hover();
  await expect(page.locator('[data-hover-kind="target"]')).toHaveAttribute(
    "data-hover-node-id",
    "hover-board",
  );
});

test("hover remains at the artboard until clicks progressively enter sections and leaves", async ({
  page,
}) => {
  await page.goto("/dev/hover-preview");
  const text = page.locator(node("hover-name-0"));
  for (const id of ["hover-title", "hover-card-value", "hover-name-0"]) {
    await page.locator(node(id)).hover();
    await expect(page.locator('[data-hover-kind="target"]')).toHaveAttribute(
      "data-hover-node-id",
      "hover-board",
    );
  }
  await expect(page.locator('[data-hover-kind="child"]')).toHaveCount(5);
  await expect(page.locator('[data-selected="true"]')).toHaveCount(0);
  for (const id of ["hover-board", "hover-table", "hover-row-0", "hover-name-0"]) {
    await text.click();
    await expect(page.locator('[data-node-id][data-selected="true"]')).toHaveAttribute(
      "data-node-id",
      id,
    );
    await expect(page.locator('[contenteditable="true"]')).toHaveCount(0);
  }
  await page.locator(node("hover-status-0")).hover();
  await expect(page.locator('[data-hover-kind="target"]')).toHaveAttribute(
    "data-hover-node-id",
    "hover-status-0",
  );
  await page.getByLabel("Design canvas", { exact: true }).focus();
  for (const id of ["hover-row-0", "hover-table", "hover-board"]) {
    await page.getByLabel("Design canvas", { exact: true }).focus();
    await page.keyboard.press("Escape");
    await expect(page.locator('[data-node-id][data-selected="true"]')).toHaveAttribute(
      "data-node-id",
      id,
    );
  }
  await page.getByLabel("Design canvas", { exact: true }).focus();
  await page.keyboard.press("Escape");
  await expect(page.locator('[data-node-id][data-selected="true"]')).toHaveCount(0);
});

test("modifiers and the deep-selection preference bypass scope without changing it on hover", async ({
  page,
}) => {
  await page.goto("/dev/hover-preview");
  const text = page.locator(node("hover-card-value"));
  await text.hover();
  await page.keyboard.down("Control");
  await expect(page.locator('[data-hover-kind="target"]')).toHaveAttribute(
    "data-hover-node-id",
    "hover-card-value",
  );
  await page.keyboard.up("Control");
  await expect(page.locator('[data-hover-kind="target"]')).toHaveAttribute(
    "data-hover-node-id",
    "hover-board",
  );
  await text.click({ modifiers: ["Control"] });
  await expect(text).toHaveAttribute("data-selected", "true");
  await page.getByRole("button", { name: /^Zoom / }).click();
  await page.getByRole("menuitemcheckbox", { name: "Use deep selection" }).click();
  await page.keyboard.press("Escape");
  await page.locator(node("hover-title")).hover();
  await expect(page.locator('[data-hover-kind="target"]')).toHaveAttribute(
    "data-hover-node-id",
    "hover-title",
  );
});

test("layer rows preview exact layers on hover and keyboard focus, including locked layers", async ({
  page,
}) => {
  await page.goto("/dev/hover-preview");
  const row = page.getByRole("button", { name: "Select Votes card", exact: true });
  await row.hover();
  await expect(page.locator(outline("hover-card"))).toHaveCount(1);
  await expect(page.locator('[data-selected="true"]')).toHaveCount(0);
  await row.focus();
  await expect(page.locator(outline("hover-card"))).toHaveCount(1);
  await page.getByRole("button", { name: "Select Locked footer", exact: true }).hover();
  await expect(page.locator(outline("hover-locked"))).toHaveCount(1);
  await page.locator(node("hover-locked")).hover();
  await expect(page.locator('[data-hover-kind="target"]')).toHaveAttribute(
    "data-hover-node-id",
    "hover-board",
  );
});

test("rotated bounds retain their orientation and ancestor clipping", async ({ page }) => {
  await page.goto("/dev/hover-preview");
  await page.keyboard.down("Control");
  await page.locator(node("hover-rotated")).hover();
  const ribbon = page.locator(outline("hover-rotated"));
  await expect(ribbon).toHaveCount(1);
  const points = required(await ribbon.getAttribute("points"))
    .split(" ")
    .map((p) => p.split(",").map(Number));
  expect(Math.abs(points[0][1] - points[1][1])).toBeGreaterThan(10);
  const ribbonBox = required(await page.locator(node("hover-rotated")).boundingBox());
  const overlayBox = await ribbon.evaluate((e) => e.getBoundingClientRect().toJSON());
  expect(overlayBox.x).toBeCloseTo(ribbonBox.x, 1);
  expect(overlayBox.y).toBeCloseTo(ribbonBox.y, 1);
  expect(overlayBox.width).toBeCloseTo(ribbonBox.width, 1);
  expect(await page.locator("[data-canvas-hover] clipPath").count()).toBeGreaterThanOrEqual(2);
  await expect(ribbon).toHaveAttribute("stroke-width", "1");
  await page.keyboard.up("Control");
  await page.getByRole("button", { name: /^Zoom / }).click();
  await page.getByRole("menuitem", { name: "Zoom to 100%" }).click();
  await page.keyboard.down("Control");
  await page.locator(node("hover-rotated")).hover();
  await expect(page.locator(outline("hover-rotated"))).toHaveAttribute("stroke-width", "1");
});

test("stationary and same-layer movement do no continuing geometry work", async ({ page }) => {
  await page.goto("/dev/hover-preview");
  await page.locator(node("hover-card-value")).hover();
  await expect(page.locator(outline("hover-board"))).toHaveCount(1);
  // Let the initial ResizeObserver delivery settle before measuring steady state.
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  const result = await page.evaluate(async () => {
    const target = document.querySelector('[data-node-id="hover-card-value"]');
    const overlay = document.querySelector("[data-canvas-hover]");
    if (!target || !overlay) throw new Error("Missing hover fixture");
    const rect = target.getBoundingClientRect();
    let reads = 0,
      mutations = 0;
    const original = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function () {
      // The existing presence handler reads the viewport on every movement.
      // Hover must not add artwork measurements when its target is unchanged.
      if (this.hasAttribute("data-node-id")) reads++;
      return original.call(this);
    };
    const observer = new MutationObserver((records) => {
      mutations += records.length;
    });
    observer.observe(overlay, { subtree: true, attributes: true, childList: true });
    try {
      for (let i = 0; i < 12; i++) {
        target.dispatchEvent(
          new PointerEvent("pointermove", {
            bubbles: true,
            pointerType: "mouse",
            clientX: rect.x + 5 + i,
            clientY: rect.y + 5,
          }),
        );
        await new Promise(requestAnimationFrame);
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
      return { reads, mutations };
    } finally {
      Element.prototype.getBoundingClientRect = original;
      observer.disconnect();
    }
  });
  expect(result).toEqual({ reads: 0, mutations: 0 });
});

test("a dense single artboard keeps hover outlines bounded", async ({ page }) => {
  await page.goto("/dev/hover-preview?nodes=5000");
  await expect(page.locator("[data-node-id]")).toHaveCount(5001);
  await page.locator(node("hover-board")).hover({ position: { x: 2, y: 2 } });
  await expect(page.locator("[data-hover-node-id]")).toHaveCount(1);
  await page.locator(node("dense-0")).hover();
  await expect(page.locator(outline("hover-board"))).toHaveCount(1);
  await page.locator(node("dense-0")).click();
  await page.locator(node("dense-25")).hover();
  await expect(page.locator(outline("dense-25"))).toHaveCount(1);
  await page.locator(node("dense-25")).click();
  await page.locator(node("dense-26")).hover();
  await expect(page.locator('[data-hover-kind="target"]')).toHaveAttribute(
    "data-hover-node-id",
    "dense-26",
  );
  expect(await page.getByRole("treeitem").count()).toBeLessThan(100);
});

test("feedback clears during drag, blur, text editing, and document visibility changes", async ({
  page,
}) => {
  await page.goto("/dev/hover-preview");
  const value = page.locator(node("hover-card-value"));
  await value.hover();
  await expect(page.locator(outline("hover-board"))).toHaveCount(1);
  await page.mouse.down();
  await expect(page.locator("[data-hover-node-id]")).toHaveCount(0);
  await page.mouse.move(900, 500);
  await expect(page.locator("[data-hover-node-id]")).toHaveCount(0);
  await page.mouse.up();
  await page.keyboard.press("ControlOrMeta+z");
  await value.hover();
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  await expect(page.locator("[data-hover-node-id]")).toHaveCount(0);
  await page.locator(node("hover-card")).hover({ position: { x: 5, y: 5 } });
  await expect(page.locator(outline("hover-card"))).toHaveCount(1);
  await page.getByRole("button", { name: "Hide Votes card", exact: true }).click();
  await expect(page.locator(node("hover-card"))).toHaveCount(0);
  await expect(page.locator(outline("hover-card"))).toHaveCount(0);
  await page.getByRole("button", { name: "Show Votes card", exact: true }).click();
  await value.click({ modifiers: ["Control"] });
  await value.dblclick();
  await expect(page.locator("[contenteditable=true]")).toBeVisible();
  await expect(page.locator("[data-hover-node-id]")).toHaveCount(0);
});

test("hovering an offscreen layer row does not mount its artboard", async ({ page }) => {
  await page.goto("/dev/performance-preview?nodes=5000");
  await page.keyboard.up("Control");
  await page.getByRole("button", { name: /^Zoom / }).click();
  await page.getByRole("menuitem", { name: "Zoom to 100%" }).click();
  const tree = page.getByRole("tree", { name: "Layers", exact: true });
  await expect.poll(() => page.locator("[data-node-id]").count()).toBeLessThanOrEqual(300);
  const before = await page.locator("[data-node-id]").count();
  await tree.evaluate((element) => {
    const scroller = element.closest('[role="tabpanel"]');
    if (!scroller) throw new Error("Missing layer scroller");
    scroller.scrollTop = scroller.scrollHeight;
  });
  await page.getByRole("button", { name: "Select Layer 4999", exact: true }).hover();
  await expect(page.locator('[data-node-id="layer-4999"]')).toHaveCount(0);
  await expect(page.locator("[data-hover-node-id]")).toHaveCount(0);
  expect(await page.locator("[data-node-id]").count()).toBe(before);
});

test("cached world geometry follows pan and zoom, including targets first measured after zoom", async ({
  page,
}) => {
  await page.goto("/dev/hover-preview");
  const row = page.getByRole("button", { name: "Select Votes card", exact: true });
  await row.hover();
  const shape = page.locator(outline("hover-card"));
  await expect(shape).toHaveCount(1);
  const points = await shape.getAttribute("points");
  const canvas = page.getByLabel("Design canvas", { exact: true });
  for (const ctrlKey of [false, true, false, true]) {
    await canvas.dispatchEvent("wheel", {
      bubbles: true,
      cancelable: true,
      deltaX: 8,
      deltaY: 18,
      ctrlKey,
      clientX: 650,
      clientY: 450,
    });
    await expect
      .poll(async () => {
        const actual = required(await page.locator(node("hover-card")).boundingBox());
        const overlay = await shape.evaluate((e) => e.getBoundingClientRect().toJSON());
        return Math.max(
          Math.abs(actual.x - overlay.x),
          Math.abs(actual.y - overlay.y),
          Math.abs(actual.width - overlay.width),
        );
      })
      .toBeLessThan(0.2);
    await expect(shape).toHaveAttribute("points", required(points));
  }
  await page.getByRole("button", { name: "Select Team table", exact: true }).hover();
  const actual = required(await page.locator(node("hover-table")).boundingBox());
  const overlay = await page
    .locator(outline("hover-table"))
    .evaluate((e) => e.getBoundingClientRect().toJSON());
  expect(overlay.width).toBeCloseTo(actual.width, 1);
  expect(overlay.x).toBeCloseTo(actual.x, 1);
});

test("deep clipped layouts stay at one scope and support exact deep selection", async ({
  page,
}) => {
  await page.goto("/dev/hover-preview?complex=1");
  const leaf = page.locator(node("complex-label-0"));
  await leaf.hover();
  await expect(page.locator('[data-hover-kind="target"]')).toHaveAttribute(
    "data-hover-node-id",
    "complex-board",
  );
  for (const id of ["complex-board", "complex-layout", "complex-card-0", "complex-depth-0"]) {
    await leaf.click();
    await expect(page.locator('[data-node-id][data-selected="true"]')).toHaveAttribute(
      "data-node-id",
      id,
    );
  }
  await leaf.click({ modifiers: ["Control"] });
  await expect(leaf).toHaveAttribute("data-selected", "true");
  await page.getByLabel("Design canvas", { exact: true }).focus();
  await page.keyboard.press("Escape");
  await expect(page.locator(node("complex-depth-23"))).toHaveAttribute("data-selected", "true");
  await leaf.hover();
  await expect(page.locator(outline("complex-label-0"))).toHaveCount(1);
  const actual = required(await leaf.boundingBox());
  const overlay = await page
    .locator(outline("complex-label-0"))
    .evaluate((e) => e.getBoundingClientRect().toJSON());
  expect(overlay.x).toBeCloseTo(actual.x, 1);
  expect(overlay.y).toBeCloseTo(actual.y, 1);
  expect(await page.locator("[data-canvas-hover] clipPath").count()).toBeGreaterThan(20);
});

test("dragging a scoped section moves the section and preserves its children", async ({ page }) => {
  await page.goto("/dev/hover-preview");
  const value = page.locator(node("hover-card-value"));
  await value.click(); // artboard scope
  const card = page.locator(node("hover-card"));
  const before = required(await card.boundingBox());
  const childBefore = required(await value.boundingBox());
  await value.hover();
  await page.mouse.down();
  await page.mouse.move(
    childBefore.x + childBefore.width / 2 + 48,
    childBefore.y + childBefore.height / 2 + 28,
    { steps: 6 },
  );
  await page.mouse.up();
  await expect(card).toHaveAttribute("data-selected", "true");
  await expect
    .poll(async () => Math.abs(required(await card.boundingBox()).x - before.x))
    .toBeGreaterThan(30);
  const after = required(await card.boundingBox());
  const childAfter = required(await value.boundingBox());
  expect(childAfter.x - after.x).toBeCloseTo(childBefore.x - before.x, 1);
  await value.hover();
  await expect(page.locator(outline("hover-card-value"))).toHaveCount(1);
});

declare global {
  interface Window {
    hoverAudit?: { styles: number; rectangles: number; stop: () => void };
  }
}

test("moving across previously measured sibling cards performs no artwork geometry reads", async ({
  page,
}) => {
  await page.goto("/dev/hover-preview?complex=1");
  await page.getByRole("button", { name: "Select Dashboard grid", exact: true }).click();
  for (let i = 0; i < 24; i++) await page.locator(node(`complex-label-${i}`)).hover();
  await page.evaluate(() => {
    const rect = Element.prototype.getBoundingClientRect;
    const style = window.getComputedStyle;
    const audit = {
      styles: 0,
      rectangles: 0,
      stop() {
        Element.prototype.getBoundingClientRect = rect;
        window.getComputedStyle = style;
      },
    };
    window.hoverAudit = audit;
    Element.prototype.getBoundingClientRect = function () {
      if (this.hasAttribute("data-node-id")) audit.rectangles++;
      return rect.call(this);
    };
    window.getComputedStyle = function (element, pseudo) {
      if (element.hasAttribute("data-node-id")) audit.styles++;
      return style.call(window, element, pseudo);
    };
  });
  try {
    for (let round = 0; round < 2; round++)
      for (let i = 0; i < 24; i++) {
        await page.locator(node(`complex-label-${i}`)).hover();
        await expect(page.locator('[data-hover-kind="target"]')).toHaveAttribute(
          "data-hover-node-id",
          `complex-card-${i}`,
        );
      }
    const counts = await page.evaluate(() => ({
      styles: window.hoverAudit?.styles,
      rectangles: window.hoverAudit?.rectangles,
    }));
    expect(counts).toEqual({ styles: 0, rectangles: 0 });
  } finally {
    await page.evaluate(() => {
      window.hoverAudit?.stop();
      delete window.hoverAudit;
    });
  }
});

test("layout edits invalidate cached section geometry", async ({ page }) => {
  await page.goto("/dev/hover-preview");
  const row = page.getByRole("button", { name: "Select Votes card", exact: true });
  await row.hover();
  await expect(page.locator(outline("hover-card"))).toHaveCount(1);
  const oldPoints = await page.locator(outline("hover-card")).getAttribute("points");
  await row.click();
  const width = page.getByRole("spinbutton", { name: "Width", exact: true });
  await width.fill("320");
  await width.press("Enter");
  await page.getByLabel("Design canvas", { exact: true }).focus();
  await page.keyboard.press("Escape");
  await page.locator(node("hover-card-value")).hover();
  const shape = page.locator(outline("hover-card"));
  await expect(shape).toHaveCount(1);
  await expect(shape).not.toHaveAttribute("points", required(oldPoints));
  const actual = required(await page.locator(node("hover-card")).boundingBox());
  const overlay = await shape.evaluate((e) => e.getBoundingClientRect().toJSON());
  expect(overlay.x).toBeCloseTo(actual.x, 1);
  expect(overlay.width).toBeCloseTo(actual.width, 1);
});

test("a fast double-click advances through hierarchy without jumping into nested text editing", async ({
  page,
}) => {
  await page.goto("/dev/hover-preview");
  await page.locator(node("hover-name-0")).dblclick();
  await expect(page.locator('[data-node-id][data-selected="true"]')).toHaveAttribute(
    "data-node-id",
    "hover-table",
  );
  await expect(page.locator('[contenteditable="true"]')).toHaveCount(0);
  await page.getByLabel("Design canvas", { exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(page.locator(node("hover-row-0"))).toHaveAttribute("data-selected", "true");
  await page.keyboard.press("Escape");
  await expect(page.locator(node("hover-table"))).toHaveAttribute("data-selected", "true");
});
