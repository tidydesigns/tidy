import { test, expect, required } from "./fixtures";

for (const viewport of [
  { width: 1280, height: 500 },
  { width: 390, height: 844 },
]) {
  test(`file actions leave Components accessible at ${viewport.width} × ${viewport.height}`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await page.route("**/api/files/preview/history", (route) =>
      route.fulfill({ json: { versions: [], nextCursor: null } }),
    );
    await page.goto("/dev/import-preview?edit=1&components=1&realtime=1");
    await page.addStyleTag({ content: "nextjs-portal { display: none; }" });
    const sidebar = page.getByRole("complementary", {
      name: "File sidebar",
      exact: true,
    });
    if (viewport.width < 768)
      await page.getByRole("button", { name: "Expand editor panels", exact: true }).click();
    const components = sidebar.locator("summary").filter({ hasText: /^Components/ });
    const actions = page.getByRole("button", {
      name: "File actions",
      exact: true,
    });
    await expect(actions).toHaveCount(1);
    await expect(sidebar.getByRole("button", { name: "File actions", exact: true })).toBeVisible();
    for (const expanded of [true, false]) {
      const componentBox = required(await components.boundingBox());
      const actionBox = required(await actions.boundingBox());
      expect(componentBox.y + componentBox.height).toBeLessThanOrEqual(actionBox.y);
      await components.click();
      await expect(components.locator("..")).toHaveJSProperty("open", expanded);
    }
    await actions.focus();
    await actions.press("ArrowUp");
    const menu = page.getByRole("menu", { name: "File actions", exact: true });
    await expect(menu).toBeVisible();
    const menuBox = required(await menu.boundingBox());
    expect(menuBox.y).toBeGreaterThanOrEqual(0);
    expect(menuBox.y + menuBox.height).toBeLessThanOrEqual(viewport.height);
    await menu.getByRole("menuitem", { name: "Version history", exact: true }).click();
    const history = page.getByRole("dialog", {
      name: "Version history",
      exact: true,
    });
    await expect(history).toBeVisible();
    await history.getByRole("button", { name: "Close history", exact: true }).click();
    await expect(actions).toBeFocused();
    await page.getByRole("button", { name: "Minimize editor panels", exact: true }).click();
    await expect(sidebar).toBeHidden();
    await expect(actions).toHaveCount(1);
    await expect(actions).toBeVisible();
    await actions.click();
    await expect(menu).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(actions).toBeFocused();
    await page.getByRole("button", { name: "Expand editor panels", exact: true }).click();
    await expect(sidebar.getByRole("button", { name: "File actions", exact: true })).toBeVisible();
    await expect(actions).toHaveCount(1);
  });
}
