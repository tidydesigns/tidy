export function selectMenu(page, label) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const labelled = page
    .getByText(label, { exact: true })
    .locator("..")
    .locator('button[aria-haspopup="menu"]');
  const unlabelled = page
    .getByRole("button", { name: new RegExp(`^${escaped}: `) })
    .and(page.locator('[aria-haspopup="menu"]'));
  return labelled.or(unlabelled);
}

export async function chooseSelectMenu(page, label, option) {
  await selectMenu(page, label).click();
  await page
    .getByRole("menu", { name: label, exact: true })
    .getByRole("menuitemradio", { name: option, exact: true })
    .click();
}

export async function selectMenuText(page, label) {
  return selectMenu(page, label).locator("span").first().textContent();
}

export async function selectMenuOptions(page, label) {
  await selectMenu(page, label).click();
  const options = await page
    .getByRole("menu", { name: label, exact: true })
    .getByRole("menuitemradio")
    .locator("span:first-child")
    .allTextContents();
  await page.keyboard.press("Escape");
  return options;
}
