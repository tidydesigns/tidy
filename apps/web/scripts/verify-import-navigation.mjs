// Start bun dev first. Uses the local preview; no account or database writes.
import assert from "node:assert/strict";
import { chromium } from "playwright";

const base = process.env.EDITOR_TEST_URL || "http://localhost:3000";
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1375, height: 80 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${base}/dev/import-preview?compact=1&edit=1`);
  await page.getByLabel("Design canvas", { exact: true }).waitFor();
  await page.setViewportSize({ width: 1375, height: 800 });
  await page.waitForFunction(() => {
    const root = document.querySelector('[data-node-id="desktop-screen"]');
    return root && getComputedStyle(root).visibility === "visible";
  });
  const bounds = await page.locator('[data-node-id="desktop-screen"]').boundingBox();
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
    const mobile = await page.locator('[data-node-id="mobile-screen"]').boundingBox();
    assert.ok(mobile.width > 0 && mobile.y >= 0 && mobile.y + mobile.height <= 801);
    if (target === "mobile-email-input")
      assert.ok(Math.abs(mobile.x + mobile.width / 2 - 1375 / 2) < 1);
  }
  assert.deepEqual(errors, [], "Canvas initializes without runtime errors");
  console.log("Short viewport recovery, imported artboard navigation and unknown targets passed.");
} finally {
  await browser.close();
}
