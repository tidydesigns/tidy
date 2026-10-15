import assert from "node:assert/strict";

import { test, required, expect } from "./fixtures";

test("short viewport recovery and imported artboard navigation", async ({ page, baseURL }) => {
  const base = baseURL!;

  await page.setViewportSize({ width: 1375, height: 80 });
  await page.goto(`${base}/dev/import-preview?compact=1&edit=1`);
  await page.getByLabel("Design canvas", { exact: true }).waitFor();
  await page.setViewportSize({ width: 1375, height: 800 });
  await page.waitForFunction(() => {
    const root = document.querySelector('[data-node-id="desktop-screen"]');
    return root && getComputedStyle(root).visibility === "visible";
  });
  const bounds = required(await page.locator('[data-node-id="desktop-screen"]').boundingBox());
  assert.ok(bounds.width > 500 && bounds.x >= 0 && bounds.y >= 0);
  assert.ok(bounds.x + bounds.width <= 1376 && bounds.y + bounds.height <= 801);

  // A link to a captured descendant opens its enclosing artboard, even if it is
  // far from the previously imported roots. Unknown IDs retain the normal fit.
  for (const target of ["mobile-email-input", "missing-node"]) {
    await page.goto(`${base}/dev/import-preview?compact=1&node=${target}`);
    await page.waitForFunction(() => {
      const root = document.querySelector('[data-node-id="mobile-screen"]');
      return root && getComputedStyle(root).visibility === "visible";
    });
    const mobile = required(await page.locator('[data-node-id="mobile-screen"]').boundingBox());
    assert.ok(mobile.width > 0 && mobile.y >= 0 && mobile.y + mobile.height <= 801);
    if (target === "mobile-email-input")
      await expect
        .poll(async () => {
          const bounds = required(
            await page.locator('[data-node-id="mobile-screen"]').boundingBox(),
          );
          const canvas = required(
            await page.getByLabel("Design canvas", { exact: true }).boundingBox(),
          );
          const viewportCenter = canvas.x + canvas.width / 2;
          return Math.abs(bounds.x + bounds.width / 2 - viewportCenter);
        })
        .toBeLessThan(1);
  }

  console.log("Short viewport recovery, imported artboard navigation and unknown targets passed.");
});
