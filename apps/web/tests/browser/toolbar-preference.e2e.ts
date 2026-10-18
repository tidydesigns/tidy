import { test, expect, required } from "./fixtures";

for (const placement of ["left", "bottom"] as const) {
  for (const initiallyOpen of [false, true]) {
    test(`desktop ${placement} toolbar survives sidebar toggles (${initiallyOpen ? "open" : "closed"} initially)`, async ({
      page,
      baseURL,
    }) => {
      await page
        .context()
        .addCookies([{ name: "tidy-editor-toolbar", value: placement, url: baseURL! }]);
      await page.goto(`/dev/import-preview?edit=1${initiallyOpen ? "" : "&compact=1"}`);
      const tools = page.getByRole("toolbar", { name: "Canvas tools", exact: true });
      const canvas = page.getByLabel("Design canvas", { exact: true });
      async function check(open: boolean) {
        await expect(tools).toHaveCount(1);
        await expect(tools).toHaveAttribute(
          "aria-orientation",
          placement === "bottom" ? "horizontal" : "vertical",
        );
        const toolBox = required(await tools.boundingBox());
        const canvasBox = required(await canvas.boundingBox());
        if (placement === "bottom") {
          expect(toolBox.y + toolBox.height).toBeGreaterThan(900);
          expect(
            Math.abs(toolBox.x + toolBox.width / 2 - (canvasBox.x + canvasBox.width / 2)),
          ).toBeLessThan(2);
          if (open) {
            expect(canvasBox.x).toBe(256);
            await expect(page.locator('.editor-panel[data-kind="tools"]')).toBeHidden();
          }
        } else {
          expect(toolBox.x).toBeLessThan(open ? 310 : 30);
          expect(toolBox.height).toBeGreaterThan(toolBox.width);
        }
      }
      await check(initiallyOpen);
      if (!initiallyOpen) await page.getByRole("button", { name: "Expand editor panels" }).click();
      await page
        .getByRole("button", { name: "Select Welcome heading", exact: true })
        .first()
        .click();
      await expect(page.getByLabel("Inspector", { exact: true })).toBeVisible();
      await tools.getByRole("button", { name: "Rectangle tool", exact: true }).click();

      for (const open of [false, true, false, true]) {
        await page
          .getByRole("button", {
            name: open ? "Expand editor panels" : "Minimize editor panels",
            exact: true,
          })
          .click();
        // Wait for the existing panel transition before measuring layout.
        await expect
          .poll(async () => (await canvas.boundingBox())?.x)
          .toBe(open ? (placement === "bottom" ? 256 : 309) : 0);
        await check(open);
        await expect(tools.getByRole("button", { name: "Rectangle tool" })).toHaveAttribute(
          "aria-pressed",
          "true",
        );
      }
    });
  }
}

test("changing the desktop preference applies immediately with Layers open", async ({ page }) => {
  await page.goto("/dev/import-preview?edit=1");
  const tools = page.getByRole("toolbar", { name: "Canvas tools", exact: true });
  await expect(tools).toHaveAttribute("aria-orientation", "vertical");
  for (const placement of ["bottom", "left", "bottom"]) {
    await page.evaluate((value) => {
      document.cookie = `tidy-editor-toolbar=${value}; Path=/; SameSite=Lax`;
      window.dispatchEvent(new Event("tidy-editor-toolbar-change"));
    }, placement);
    await expect(tools).toHaveCount(1);
    await expect(tools).toHaveAttribute(
      "aria-orientation",
      placement === "bottom" ? "horizontal" : "vertical",
    );
    await expect(page.getByRole("tab", { name: "Layers", exact: true })).toBeVisible();
  }
});
