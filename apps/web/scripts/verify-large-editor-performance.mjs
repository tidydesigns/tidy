import assert from "node:assert/strict";
import { chromium } from "playwright";
const base = process.env.EDITOR_TEST_URL || "http://localhost:3107";
if (!["localhost", "127.0.0.1"].includes(new URL(base).hostname))
  throw new Error("Use local development fixtures.");
const browser = await chromium.launch({ headless: true });
try {
  for (const count of [100, 1000, 5000]) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${base}/dev/performance-preview?nodes=${count}`);
    const tree = page.getByRole("tree", { name: "Layers", exact: true });
    await tree.waitFor();
    await page
      .getByRole("button", { name: /^Zoom / })
      .first()
      .click();
    await page.getByRole("menuitem", { name: "Zoom to 100%" }).click();
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
    const mounted = await page.locator("[data-node-id]").count();
    const rows = await tree.getByRole("treeitem").count();
    assert.ok(mounted <= 300, `Only nearby frames mount at 100% (${count}: ${mounted})`);
    assert.ok(rows <= 100, `Layer DOM remains bounded (${count}: ${rows})`);
    if (count > 200) {
      await tree.evaluate((element) => {
        const scroller = element.closest('[role="tabpanel"]');
        scroller.scrollTop = scroller.scrollHeight;
      });
      await page.getByRole("button", { name: `Select Layer ${count - 1}`, exact: true }).waitFor();
      await page.getByRole("button", { name: `Select Layer ${count - 1}`, exact: true }).focus();
      await page.keyboard.press("Enter");
      await page.getByRole("textbox", { name: "Layer name", exact: true }).waitFor();
      assert.ok(
        await page.locator(`[data-node-id="layer-${count - 1}"]`).count(),
        "Offscreen selected content remains mounted",
      );
      assert.ok((await tree.getByRole("treeitem").count()) <= 100);
    }
    assert.deepEqual(errors, []);
    console.log(
      `PASS: ${count}-node editor, 100% zoom: mounted=${mounted}, layerRows=${rows}; virtual scroll and keyboard selection`,
    );
    await page.close();
  }
} finally {
  await browser.close();
}
