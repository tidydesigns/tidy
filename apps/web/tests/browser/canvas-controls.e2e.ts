import { expect, test } from "./fixtures";

for (const fixture of [
  { kind: "local", path: "/dev/hover-preview", layer: "Data / Dark" },
  {
    kind: "comments",
    path: "/dev/import-preview?edit=1&realtime=1",
    layer: "Desktop 1440 · /login",
  },
]) {
  for (const viewport of [
    { width: 1440, height: 1000 },
    { width: 1024, height: 768 },
    { width: 390, height: 844 },
    { width: 844, height: 390 },
  ]) {
    test(`${fixture.kind} canvas controls stay above selection UI at ${viewport.width}×${viewport.height}`, async ({
      page,
    }) => {
      await page.setViewportSize(viewport);
      await page.emulateMedia({ colorScheme: viewport.width === 1440 ? "dark" : "light" });
      if (fixture.kind === "comments") {
        await page.route("**/api/files/preview/comments?*", (route) =>
          route.fulfill({
            json: {
              threads: [],
              viewerId: "00000000-0000-4000-8000-000000000001",
              reactionsAvailable: false,
              canModerateThreads: false,
              nextCursor: null,
            },
          }),
        );
      }
      await page.goto(fixture.path);
      const mode = page.getByRole("group", { name: "Canvas mode" });
      const zoom = page.getByRole("button", { name: /^Zoom \d+%$/ });
      await expect(mode).toBeVisible();
      const modeBox = await mode.boundingBox();
      const zoomBox = await zoom.boundingBox();
      if (!modeBox || !zoomBox) throw new Error("Canvas controls have no bounds");
      expect(zoomBox.height).toBe(modeBox.height);
      expect(zoomBox.y).toBe(modeBox.y);
      expect(await mode.evaluate((element) => getComputedStyle(element).backgroundColor)).toMatch(
        /^rgb\(/,
      );

      if (viewport.width < 768)
        await page.getByRole("button", { name: "Expand editor panels" }).click();
      await page.getByRole("button", { name: `Select ${fixture.layer}`, exact: true }).click();
      if (viewport.width < 768)
        await page.getByRole("button", { name: "Close inspector", exact: true }).click();
      const canvas = page.getByRole("region", { name: "Design canvas", exact: true });
      const handle = page.getByRole("button", {
        name: `Resize ${fixture.layer} top right`,
        exact: true,
      });
      await expect(handle).toBeAttached();
      const handleBox = await handle.boundingBox();
      const inspect = mode.getByRole("button", { name: "Inspect", exact: true });
      const inspectBox = await inspect.boundingBox();
      if (!handleBox || !inspectBox) throw new Error("Selection handle has no bounds");
      const target = {
        x: inspectBox.x + inspectBox.width / 2,
        y: inspectBox.y + inspectBox.height / 2,
      };
      await canvas.evaluate(
        (element, delta) => {
          element.dispatchEvent(
            new WheelEvent("wheel", { ...delta, bubbles: true, cancelable: true }),
          );
        },
        {
          deltaX: handleBox.x + handleBox.width / 2 - target.x,
          deltaY: handleBox.y + handleBox.height / 2 - target.y,
        },
      );
      await expect
        .poll(async () => {
          const box = await handle.boundingBox();
          return box
            ? Math.max(
                Math.abs(box.x + box.width / 2 - target.x),
                Math.abs(box.y + box.height / 2 - target.y),
              )
            : Infinity;
        })
        .toBeLessThan(1);
      expect(
        await page.evaluate(
          ({ x, y }) => document.elementFromPoint(x, y)?.closest("button")?.textContent,
          target,
        ),
      ).toBe("Inspect");
      await inspect.click();
      await expect(inspect).toHaveAttribute("aria-pressed", "true");
      await mode.getByRole("button", { name: "Design", exact: true }).click();
      await expect(handle).toBeAttached();
      await zoom.click();
      const menu = page.getByRole("menu", { name: "Canvas view" });
      const menuBox = await menu.boundingBox();
      if (!menuBox) throw new Error("Zoom menu has no bounds");
      expect(menuBox.y).toBeGreaterThanOrEqual(zoomBox.y + zoomBox.height);
      expect(menuBox.y + menuBox.height).toBeLessThanOrEqual(viewport.height);
      await menu.getByRole("menuitem", { name: "Zoom to 100%" }).click();
      await expect(zoom).toHaveAccessibleName("Zoom 100%");
      await zoom.click();
      await menu.getByRole("menuitem", { name: "Zoom to selection" }).click();
      await zoom.click();
      await menu.getByRole("menuitem", { name: "Zoom to fit" }).click();
      await zoom.click();
      await menu.getByRole("menuitemcheckbox", { name: /^Show comments/ }).scrollIntoViewIfNeeded();
      await page.keyboard.press("Escape");
      await expect(menu).toBeHidden();
      await expect(zoom).toBeFocused();
    });
  }
}

for (const width of [320, 1440]) {
  test(`read-only canvas keeps zoom usable at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 640 });
    await page.goto("/dev/hover-preview?viewer=1");
    await expect(page.getByRole("group", { name: "Canvas mode" })).toHaveCount(0);
    const zoom = page.getByRole("button", { name: /^Zoom \d+%$/ });
    await zoom.click();
    const menu = page.getByRole("menu", { name: "Canvas view" });
    await expect(menu.getByRole("menuitem", { name: "Zoom to selection" })).toBeDisabled();
    await menu.getByRole("menuitem", { name: "Zoom in" }).click();
    await zoom.click();
    await menu.getByRole("menuitem", { name: "Zoom out" }).click();
    await zoom.click();
    const nudge = menu.getByRole("spinbutton", { name: "Nudge step" });
    await nudge.scrollIntoViewIfNeeded();
    await expect(nudge).toBeInViewport();
    await page.keyboard.press("Escape");
    await expect(zoom).toBeFocused();
  });
}
