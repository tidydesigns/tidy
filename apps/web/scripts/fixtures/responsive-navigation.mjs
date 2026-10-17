import assert from "node:assert/strict";

// Run against the same disposable workspace as the router regression suite.
export async function testResponsiveNavigation(page, base) {
  const originalViewport = page.viewportSize();
  const menu = page.getByRole("button", { name: "Menu", exact: true });
  const panel = page.getByRole("dialog", { name: "Workspace menu", exact: true });
  const close = panel.getByRole("button", { name: "Close", exact: true });
  const openMenu = async () => {
    await menu.click();
    await panel.waitFor();
    assert.equal(await menu.getAttribute("aria-expanded"), "true");
    assert(await close.evaluate((button) => button === document.activeElement));
  };
  const noOverflow = async () => {
    const layout = await page.evaluate(() => ({
      width: window.innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
      overflowing: [...document.querySelectorAll("body *")]
        .filter((element) => element.getBoundingClientRect().right > window.innerWidth + 1)
        .slice(0, 12)
        .map((element) => ({ tag: element.tagName, className: element.className })),
    }));
    if (layout.scrollWidth > layout.width)
      await page.screenshot({ path: ".artifacts/navigation/responsive-overflow.png" });
    assert(
      layout.scrollWidth <= layout.width,
      `The responsive workspace must not scroll horizontally: ${JSON.stringify(layout)}`,
    );
  };
  try {
    for (const width of [320, 390, 768]) {
      await page.setViewportSize({ width, height: 844 });
      await noOverflow();
      assert.equal(await page.getByRole("navigation", { name: "Workspace" }).count(), 0);
      await openMenu();
      await noOverflow();
      const bounds = await panel.boundingBox();
      assert.equal(bounds.width, width);
      assert.equal(bounds.height, 844);
      await page.keyboard.press("Shift+Tab");
      await page.keyboard.press("Shift+Tab");
      assert(
        await panel.evaluate(
          (dialog) =>
            dialog.contains(document.activeElement) || document.activeElement === document.body,
        ),
        "Keyboard focus must not reach background content (native dialogs allow browser chrome).",
      );
      await page.keyboard.press("Tab");
      assert(await panel.evaluate((dialog) => dialog.contains(document.activeElement)));
      await page.keyboard.press("Escape");
      await panel.waitFor({ state: "hidden" });
      await menu.and(page.locator('[aria-expanded="false"]')).waitFor();
      assert(await menu.evaluate((button) => button === document.activeElement));
      assert.equal(await menu.getAttribute("aria-expanded"), "false");
    }

    await page.setViewportSize({ width: 320, height: 844 });
    await page.evaluate(() => {
      document.documentElement.style.fontSize = "200%";
    });
    await noOverflow();
    await openMenu();
    await noOverflow();
    await close.click();
    await panel.waitFor({ state: "hidden" });
    await page.evaluate(() => document.documentElement.style.removeProperty("font-size"));
    await page.setViewportSize({ width: 390, height: 844 });

    await openMenu();
    await panel.getByRole("link", { name: "Archive", exact: true }).click();
    await page.waitForURL(`${base}/files?view=archive`);
    await page.getByRole("heading", { name: "Archive", exact: true }).waitFor();
    await panel.waitFor({ state: "hidden" });
    await openMenu();
    assert.equal(
      await panel.getByRole("link", { name: "Archive", exact: true }).getAttribute("aria-current"),
      "page",
    );
    await page.goBack();
    await page.waitForURL(`${base}/files`);
    await panel.waitFor({ state: "hidden" });

    await openMenu();
    await panel.getByRole("button", { name: "Send feedback", exact: true }).click();
    const feedback = page.getByRole("dialog", { name: "Send feedback", exact: true });
    await feedback.waitFor();
    await page.keyboard.press("Escape");
    await feedback.waitFor({ state: "hidden" });
    assert(await panel.isVisible(), "Closing feedback must preserve the workspace menu.");
    assert(
      await panel
        .getByRole("button", { name: "Send feedback", exact: true })
        .evaluate((button) => button === document.activeElement),
    );

    await panel.getByRole("button", { name: /Switch organization/ }).click();
    const organizations = page.getByLabel("Organizations", { exact: true });
    await organizations.waitFor();
    await page.keyboard.press("Escape");
    await organizations.waitFor({ state: "hidden" });
    assert(await panel.isVisible(), "Escape must dismiss the popover before its parent menu.");

    await page.setViewportSize({ width: 844, height: 390 });
    await noOverflow();
    await close.click();
    await panel.waitFor({ state: "hidden" });
    await openMenu();
    await page.setViewportSize({ width: 1440, height: 960 });
    await panel.waitFor({ state: "hidden" });
    assert.equal(await menu.isVisible(), false);
    assert.equal(await page.getByRole("navigation", { name: "Workspace" }).count(), 1);
    assert.equal(await page.locator("dialog[open]").count(), 0);
    await page.screenshot({ path: ".artifacts/navigation/responsive-desktop.png" });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: ".artifacts/navigation/responsive-mobile.png" });
    await openMenu();
    await page.screenshot({ path: ".artifacts/navigation/responsive-menu.png" });
    await close.click();
    await panel.waitFor({ state: "hidden" });
  } finally {
    await page.evaluate(() => document.documentElement.style.removeProperty("font-size"));
    await page.setViewportSize(originalViewport);
  }
}
