import { test, expect, required } from "./fixtures";

test.use({ hasTouch: true, isMobile: true });

for (const preference of ["left", "bottom"]) {
  for (const viewport of [
    { width: 320, height: 640 },
    { width: 390, height: 844 },
    { width: 740, height: 360 },
  ]) {
    test(`mobile canvas uses a left rail at ${viewport.width}px with ${preference} preference`, async ({
      page,
      baseURL,
    }) => {
      await page.setViewportSize(viewport);
      await page.context().addCookies([
        { name: "tidy-editor-toolbar", value: preference, url: baseURL! },
        { name: "tidy-editor-panels", value: "open", url: baseURL! },
      ]);
      await page.goto("/dev/import-preview?edit=1");
      // The development badge otherwise covers the last tool in landscape.
      await page.addStyleTag({ content: "nextjs-portal { display: none; }" });
      const canvas = page.getByLabel("Design canvas", { exact: true });
      const tools = page.getByRole("toolbar", { name: "Canvas tools", exact: true });
      await expect(tools).toHaveAttribute("aria-orientation", "vertical");
      await expect(page.getByRole("button", { name: "Expand editor panels" })).toBeVisible();
      await expect(page.getByRole("tab", { name: "Layers", exact: true })).toHaveCount(0);
      const canvasBox = required(await canvas.boundingBox());
      expect(canvasBox.x).toBe(0);
      expect(canvasBox.width).toBeGreaterThan(viewport.width - 20);
      const rail = tools.locator("..");
      const railBox = required(await rail.boundingBox());
      expect(railBox.x).toBeLessThan(20);
      expect(railBox.y).toBeGreaterThanOrEqual(90);
      expect(railBox.y + railBox.height).toBeLessThanOrEqual(viewport.height);
      const select = tools.getByRole("button", { name: "Select tool", exact: true });
      expect(required(await select.boundingBox()).height).toBeGreaterThanOrEqual(44);

      // The full tool set stays reachable on short screens without wrapping.
      const imageTool = tools.getByRole("button", { name: "Add image", exact: true });
      await imageTool.scrollIntoViewIfNeeded();
      const imageBox = required(await imageTool.boundingBox());
      expect(imageBox.y + imageBox.height).toBeLessThanOrEqual(viewport.height);
      // Local editors omit cloud comments; exercise touch switching with the hand tool.
      await expect(tools.getByRole("button", { name: "Comment tool", exact: true })).toHaveCount(0);
      const hand = tools.getByRole("button", { name: "Hand tool", exact: true });
      await hand.scrollIntoViewIfNeeded();
      await hand.tap();
      await expect(hand).toHaveAttribute("aria-pressed", "true");
      await select.scrollIntoViewIfNeeded();
      await select.click();

      await page.getByRole("button", { name: "Expand editor panels" }).click();
      await expect(page.getByRole("tab", { name: "Layers", exact: true })).toBeVisible();
      expect(await canvas.boundingBox()).toEqual(canvasBox);
      await expect(tools).toBeHidden();
      await page
        .getByRole("button", { name: "Select Welcome heading", exact: true })
        .first()
        .click();
      await expect(page.getByRole("tab", { name: "Layers", exact: true })).toBeHidden();
      await expect(page.getByLabel("Inspector", { exact: true })).toBeVisible();
      expect(await canvas.boundingBox()).toEqual(canvasBox);
      await expect
        .poll(async () => {
          const box = required(await page.getByLabel("Inspector", { exact: true }).boundingBox());
          return Math.round(box.x + box.width);
        })
        .toBeLessThanOrEqual(viewport.width);
      const inspector = required(await page.getByLabel("Inspector", { exact: true }).boundingBox());
      expect(inspector.x).toBeGreaterThanOrEqual(0);
      await page.getByRole("button", { name: "Close inspector", exact: true }).click();
      await expect(tools).toBeVisible();
      const cookies = await page.context().cookies();
      expect(cookies.find((cookie) => cookie.name === "tidy-editor-toolbar")?.value).toBe(
        preference,
      );
      expect(cookies.find((cookie) => cookie.name === "tidy-editor-panels")?.value).toBe("open");
    });
  }
}

test("returning to desktop restores its panel state and toolbar preference", async ({
  page,
  baseURL,
}) => {
  await page
    .context()
    .addCookies([{ name: "tidy-editor-toolbar", value: "bottom", url: baseURL! }]);
  await page.goto("/dev/import-preview?edit=1&compact=1");
  const tools = page.getByRole("toolbar", { name: "Canvas tools", exact: true });
  await expect(tools).toHaveAttribute("aria-orientation", "horizontal");
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(tools).toHaveAttribute("aria-orientation", "vertical");
  await page.getByRole("button", { name: "Expand editor panels" }).click();
  await expect(page.getByRole("tab", { name: "Layers", exact: true })).toBeVisible();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await expect(tools).toBeVisible();
  await expect(tools).toHaveAttribute("aria-orientation", "horizontal");
  await expect(page.getByRole("tab", { name: "Layers", exact: true })).toBeHidden();
});
