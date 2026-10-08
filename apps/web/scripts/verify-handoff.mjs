import assert from "node:assert/strict";
import { chromium } from "playwright";

const browser = await chromium.launch({ headless: true });
const base = process.env.EDITOR_TEST_URL || "http://localhost:3112";
try {
  for (const viewer of [false, true]) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    page.setDefaultTimeout(15000);
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.addInitScript(() => {
      window.handoffCopies = [];
      window.rejectCopy = false;
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
          writeText: async (text) => {
            if (window.rejectCopy) throw new Error("Clipboard denied");
            window.handoffCopies.push(text);
          },
        },
      });
    });
    await page.goto(`${base}/dev/import-preview?edit=1${viewer ? "&viewer=1" : ""}`);
    await page.waitForFunction(() =>
      [...document.querySelectorAll("button")].some(
        (button) =>
          button.getAttribute("aria-label") === "Select Welcome heading" &&
          Object.keys(button).some((key) => key.startsWith("__reactProps")),
      ),
    );
    await page.getByRole("button", { name: "Select Welcome heading", exact: true }).first().click();
    if (!viewer) await page.getByRole("button", { name: "Inspect mode", exact: true }).click();
    const inspector = page.getByLabel("Inspector", { exact: true });
    await inspector.getByRole("button", { name: "Copy CSS", exact: true }).click();
    await page.getByRole("status").filter({ hasText: "CSS copied" }).waitFor();
    const css = await page.evaluate(() => window.handoffCopies.at(-1));
    assert.equal(css, await page.getByLabel("Generated layer CSS").textContent());
    assert.ok(!css.includes("primary-orange"));
    assert.ok(css.includes("font-size:"));
    assert.ok(css.includes(":nth-child("), "text renderer markup CSS is included");
    assert.equal(await inspector.locator("input").count(), 0);
    if (viewer) assert.equal(await inspector.getByRole("tab").count(), 0);
    const parity = await page.evaluate((css) => {
      const source = document.querySelector('[data-node-id="desktop-heading"]');
      const clone = source.cloneNode(true);
      clone.removeAttribute("style");
      clone.removeAttribute("data-node-id");
      clone.classList.add("tidy-layer");
      const stylesheet = document.createElement("style");
      stylesheet.textContent = css;
      document.head.appendChild(stylesheet);
      source.parentElement.appendChild(clone);
      const expected = getComputedStyle(source),
        actual = getComputedStyle(clone);
      const differences = [
        "width",
        "height",
        "font-size",
        "font-family",
        "font-weight",
        "line-height",
        "letter-spacing",
        "color",
        "white-space",
        "padding-top",
        "display",
      ].filter(
        (property) => expected.getPropertyValue(property) !== actual.getPropertyValue(property),
      );
      clone.remove();
      stylesheet.remove();
      return differences;
    }, css);
    assert.deepEqual(parity, []);
    await page
      .getByRole("button", { name: "Select Authentication panel", exact: true })
      .first()
      .click();
    await inspector.getByRole("button", { name: "Copy CSS", exact: true }).click();
    const panel = page.locator('[data-node-id="desktop-panel"]');
    const before = await panel.getAttribute("style");
    const canvas = page.getByLabel("Design canvas", { exact: true });
    await canvas.focus();
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("Delete");
    assert.equal(
      await panel.getAttribute("style"),
      before,
      "inspection blocks nudging and deletion",
    );
    const panelCss = await page.evaluate(() => window.handoffCopies.at(-1));
    assert.notEqual(panelCss, css, "Inspect mode stays active on later selections");
    assert.ok(!panelCss.includes("data-node-id"));
    await inspector.getByText("Imported source", { exact: true }).click();
    assert.ok((await inspector.textContent()).includes("apps/web/"));
    await page.evaluate(() => {
      window.rejectCopy = true;
    });
    await inspector.getByRole("button", { name: "Copy CSS", exact: true }).click();
    await inspector.getByRole("status").filter({ hasText: "Could not copy" }).waitFor();
    if (!viewer) {
      await canvas.click({ position: { x: 15, y: 15 } });
      await page.getByRole("button", { name: "Inspect mode", exact: true }).click();
      await page.getByRole("button", { name: "Rectangle tool", exact: true }).waitFor();
    }
    assert.deepEqual(errors, []);
    console.log(
      `PASS ${viewer ? "viewer" : "editor"}: CSS parity, read-only inspection, selection changes, source details and clipboard failure`,
    );
    await page.close();
  }
} finally {
  await browser.close();
}
