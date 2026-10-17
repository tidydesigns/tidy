import type { Locator } from "playwright";
import { expect, test, required } from "./fixtures";

async function contrast(control: Locator, property: "borderTopColor" | "outlineColor" | "color") {
  const colors = await control.evaluate((element, property) => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    const context = canvas.getContext("2d")!;
    const pixels = (color: string) => {
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = color;
      context.fillRect(0, 0, 1, 1);
      return Array.from(context.getImageData(0, 0, 1, 1).data);
    };
    let background = [255, 255, 255, 255];
    for (let ancestor: Element | null = element; ancestor; ancestor = ancestor.parentElement) {
      const color = pixels(getComputedStyle(ancestor).backgroundColor);
      if (color[3] === 255) {
        background = color;
        break;
      }
    }
    return [pixels(getComputedStyle(element)[property]), background];
  }, property);
  const luminance = (color: number[]) =>
    color.slice(0, 3).reduce((sum, value, index) => {
      const channel = value / 255;
      return (
        sum +
        (channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4) *
          [0.2126, 0.7152, 0.0722][index]
      );
    }, 0);
  const values = colors.map(luminance);
  return (Math.max(...values) + 0.05) / (Math.min(...values) + 0.05);
}

test("invalid token values explain the error, preserve artwork and allow correction or cancellation", async ({
  page,
}) => {
  await page.goto("/dev/import-preview?edit=1&tokens=1");
  const card = page.locator('[data-node-id="token-card"]');
  await expect(card).toBeVisible();
  await page.getByRole("tab", { name: "Tokens", exact: true }).click();
  const token = (name: string) =>
    page
      .locator("details")
      .filter({ has: page.locator("summary").filter({ hasText: `${name} ·` }) });
  await token("rounded").locator("summary").click();
  const radius = token("rounded").getByRole("spinbutton", { name: "Value", exact: true });
  const originalRadius = await card.evaluate(
    (element) => getComputedStyle(element).borderTopLeftRadius,
  );
  await radius.fill("-1");
  await radius.press("Enter");
  await expect(radius).toHaveAttribute("aria-invalid", "true");
  await expect(radius).toHaveAccessibleName("Value");
  await expect(radius).toHaveAccessibleDescription("Enter a number from 0 to 5000.");
  expect(await card.evaluate((element) => getComputedStyle(element).borderTopLeftRadius)).toBe(
    originalRadius,
  );
  await radius.fill("24");
  await radius.press("Enter");
  await expect(card).toHaveCSS("border-top-left-radius", "24px");
  await expect(radius).not.toHaveAttribute("aria-invalid");

  await token("body").locator("summary").click();
  const text = page.locator('[data-node-id="token-label"]');
  for (const [label, message, cssProperty, expectedCss, correction] of [
    ["Font size", "Enter a font size from 6 to 300.", "font-size", "18px", "20"],
    ["Font weight", "Enter a font weight from 1 to 1000.", "font-weight", "500", "600"],
    ["Line height", "Enter a line height as a percentage.", "line-height", "28px", "150"],
  ]) {
    const field = token("body").getByRole("spinbutton", { name: label, exact: true });
    await expect(field).toHaveAttribute("required", "");
    await field.fill("");
    await field.press("Enter");
    await expect(field).toHaveAttribute("aria-invalid", "true");
    await expect(field).toHaveAccessibleDescription(message);
    await expect(text).toHaveCSS(cssProperty, expectedCss);
    await expect(page.getByText("Could not change layers.", { exact: true })).toHaveCount(0);
    await field.fill(correction);
    await field.press("Enter");
    await expect(field).toHaveValue(correction);
    await expect(field).not.toHaveAttribute("aria-invalid");
    await expect(field).not.toHaveAttribute("aria-describedby");
  }

  await page.getByRole("button", { name: "+ Color token", exact: true }).click();
  await token("color_1").locator("summary").click();
  const color = token("color_1").getByRole("textbox", { name: "Color", exact: true });
  await expect(color).not.toHaveAttribute("aria-label");
  await color.fill("not-a-color");
  await color.press("Enter");
  await expect(color).toHaveAttribute("aria-invalid", "true");
  await expect(color).toHaveAccessibleName("Color");
  await expect(color).toHaveAccessibleDescription(
    "Enter a hex color such as #336699 or #336699ff.",
  );
  const error = page.locator(`[id="${required(await color.getAttribute("aria-describedby"))}"]`);
  await expect(error).toHaveAttribute("role", "alert");
  await expect(page.getByText("Could not change layers.", { exact: true })).toHaveCount(0);
  await color.fill("#336699ff");
  await color.press("Enter");
  await expect(color).toHaveValue("#336699ff");
  await expect(color).not.toHaveAttribute("aria-invalid");
  await expect(color).not.toHaveAttribute("aria-describedby");
  await color.fill("another-invalid-color");
  await color.press("Enter");
  await expect(color).toHaveAttribute("aria-invalid", "true");
  await color.press("Escape");
  await expect(color).toHaveValue("#336699ff");
  await expect(error).toHaveCount(0);
});

test("empty field boundaries, guidance and keyboard menu focus remain readable in both themes", async ({
  page,
}) => {
  await page.goto("/reset-password?token=accessibility-fixture-no-submit");
  for (const theme of ["light", "dark"]) {
    await page.evaluate((theme) => (document.documentElement.dataset.theme = theme), theme);
    const password = page.getByLabel("New password", { exact: true });
    await expect(password).toBeEmpty();
    expect(await contrast(password, "borderTopColor")).toBeGreaterThanOrEqual(3);
    expect(
      await contrast(page.getByText("Use at least 8 characters.", { exact: true }), "color"),
    ).toBeGreaterThanOrEqual(4.5);
  }

  await page.goto("/dev/import-preview?edit=1&tokens=1");
  for (const theme of ["light", "dark"]) {
    await page.evaluate((theme) => (document.documentElement.dataset.theme = theme), theme);
    const trigger = page.getByRole("button", { name: /^Shape tool/ });
    await trigger.focus();
    await trigger.press("ArrowDown");
    const menu = page.getByRole("menu", { name: "Shape tool", exact: true });
    const line = menu.getByRole("menuitemradio", { name: "Line", exact: true });
    await page.keyboard.press("ArrowDown");
    await expect(line).toBeFocused();
    await expect(line).not.toHaveAttribute("aria-checked", "true");
    expect(await contrast(line, "outlineColor")).toBeGreaterThanOrEqual(3);
    await expect(line).toHaveCSS("outline-style", "solid");
    await expect(line).toHaveCSS("outline-width", "2px");
    await line.press("Escape");
    await expect(trigger).toBeFocused();
  }
});

test("the fill image picker uses its visible label and reflects keyboard focus", async ({
  page,
}) => {
  await page.goto("/dev/import-preview?edit=1&tokens=1");
  await page.getByRole("button", { name: "Select Card", exact: true }).first().click();
  await page.getByRole("button", { name: /^Fill type:/ }).click();
  await page
    .getByRole("menu", { name: "Fill type", exact: true })
    .getByRole("menuitemradio", { name: "Image", exact: true })
    .click();
  const upload = page.getByLabel("Choose fill image", { exact: true });
  await expect(upload).not.toHaveAttribute("aria-label");
  await upload.focus();
  await expect(upload).toBeFocused();
  const label = upload.locator("..");
  await expect(label).toHaveCSS("outline-style", "solid");
  await expect(label).toHaveCSS("outline-width", "2px");
  expect(await contrast(label, "outlineColor")).toBeGreaterThanOrEqual(3);
});
