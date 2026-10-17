import { expect, test } from "./fixtures";

test("file action menus restore the trigger on Escape without stealing rename focus", async ({
  page,
}) => {
  await page.goto("/dev/performance-preview?workspace=1&files=2&edit=1");
  const trigger = page.getByRole("button", { name: "Actions for File 0", exact: true });
  await trigger.focus();
  await page.keyboard.press("Enter");
  const menu = page.getByRole("menu", { name: "Actions for File 0", exact: true });
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  await expect(menu.getByRole("menuitem").first()).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(menu.getByRole("menuitem").nth(1)).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await expect(trigger).toHaveAttribute("aria-expanded", "false");

  await page.keyboard.press("Enter");
  await menu.getByRole("menuitem", { name: "Rename", exact: true }).click();
  const name = page.getByRole("textbox", { name: "File name", exact: true });
  await expect(name).toBeFocused();
  // Cancel without invoking the fixture's real server action.
  await name.press("Escape");
  await expect(name).toHaveCount(0);
  await expect(trigger).toBeFocused();

  await trigger.press("Enter");
  await menu.getByRole("menuitem", { name: "Move to…", exact: true }).click();
  const back = menu.getByRole("menuitem", { name: "← Back", exact: true });
  await expect(back).toBeFocused();
  await back.press("Enter");
  await expect(menu.getByRole("menuitem", { name: "Open", exact: true })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
});

test("outside clicks keep focus on their destination when a file menu closes", async ({ page }) => {
  await page.goto("/dev/performance-preview?workspace=1&files=2&edit=1");
  await page.getByRole("button", { name: "Actions for File 0", exact: true }).click();
  const destination = page.getByRole("button", { name: "Actions for File 1", exact: true });
  await destination.click();
  await page.keyboard.press("Escape");
  await expect(destination).toBeFocused();
});

test("removing the invoking file keeps focus on a surviving item through rollback", async ({
  page,
}) => {
  await page.goto("/dev/performance-preview?workspace=1&files=2&edit=1");
  const original = page.getByRole("button", { name: "Actions for File 0", exact: true });
  const next = page.getByRole("button", { name: "Actions for File 1", exact: true });
  await original.click();
  await page.getByRole("menuitem", { name: "Archive", exact: true }).click();
  await expect(next).toBeFocused();
  // The isolated fixture has no database; failure restores the file without undoing focus.
  await expect(original).toBeVisible();
  await expect(next).toBeFocused();
});
