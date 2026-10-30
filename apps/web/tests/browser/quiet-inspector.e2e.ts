import { test, expect } from "./fixtures";
import type { Page } from "playwright/test";

const inspector = (page: Page) => page.getByLabel("Inspector", { exact: true });
const summary = (page: Page, title: string) =>
  inspector(page)
    .locator("summary")
    .filter({ has: page.getByText(title, { exact: true }) });
async function select(page: Page, name: string) {
  await page
    .getByRole("button", { name: `Select ${name}`, exact: true })
    .first()
    .click();
}
async function choose(page: Page, name: RegExp, value: string) {
  await inspector(page).getByRole("button", { name }).click();
  await page.getByRole("menuitemradio", { name: value, exact: true }).click();
}

test("quiet text inspector preserves measured size, editing, sizing modes and undo", async ({
  page,
}) => {
  await page.goto("/dev/import-preview?edit=1");
  await select(page, "Welcome heading");
  const panel = inspector(page);
  await expect(panel.getByRole("heading", { name: "Typography" })).toBeVisible();
  await expect(summary(page, "Layout").locator("..")).not.toHaveAttribute("open");
  await expect(summary(page, "Advanced").locator("..")).not.toHaveAttribute("open");
  await expect(summary(page, "Export").locator("..")).not.toHaveAttribute("open");
  await expect(panel.getByRole("spinbutton", { name: "Rotation", exact: true })).toHaveCount(0);
  await expect(panel.getByText("Text case", { exact: true })).toHaveCount(0);
  await expect(panel.getByRole("button", { name: "Bold", exact: true })).toHaveCount(0);
  await summary(page, "Text details").click();
  await expect(panel.getByText("Text case", { exact: true })).toBeVisible();
  await summary(page, "Text details").click();
  await expect(panel.getByText("Text case", { exact: true })).toHaveCount(0);
  await summary(page, "Formatting").click();
  await expect(panel.getByRole("button", { name: "Bold", exact: true })).toBeVisible();
  await summary(page, "Formatting").click();
  await expect(panel.getByRole("button", { name: "Bold", exact: true })).toHaveCount(0);
  const width = panel.getByRole("spinbutton", { name: "Width", exact: true });
  await width.fill("420");
  await width.press("Enter");
  await expect(page.locator('[data-node-id="desktop-heading"]')).toHaveCSS("width", "420px");
  await choose(page, /^Text width:/, "Auto");
  await expect(panel.getByRole("button", { name: "Text width: Auto", exact: true })).toBeVisible();
  expect(Number(await width.inputValue())).toBeGreaterThan(0);
  await width.fill("400");
  await width.press("Enter");
  await expect(panel.getByRole("button", { name: "Text width: Fixed", exact: true })).toBeVisible();
  await summary(page, "Transform & constraints").click();
  const rotation = panel.getByRole("spinbutton", { name: "Rotation", exact: true });
  await rotation.fill("15");
  await rotation.press("Enter");
  await expect(page.locator('[data-node-id="desktop-heading"]')).toHaveCSS("transform", /matrix/);
  await page.getByLabel("Design canvas", { exact: true }).focus();
  await page.keyboard.press("ControlOrMeta+z");
  await expect(rotation).toHaveValue("0");
  await expect(page.locator('[data-node-id="desktop-heading"]')).toHaveCSS("transform", "none");
});

test("layout disclosure edits real container flow and preserves its open state across selection", async ({
  page,
}) => {
  await page.goto("/dev/import-preview?edit=1");
  await select(page, "Authentication panel");
  await summary(page, "Layout").click();
  await choose(page, /^Flow /, "Vertical");
  const gap = inspector(page).getByRole("spinbutton", { name: "Gap", exact: true });
  await gap.fill("16");
  await gap.press("Enter");
  const panel = page.locator('[data-node-id="desktop-panel"]');
  await expect(panel).toHaveCSS("flex-direction", "column");
  await expect(panel).toHaveCSS("gap", "16px");
  await expect(summary(page, "Layout")).toContainText("Vertical · Gap 16");
  await choose(page, /^Flow /, "Grid");
  const columns = inspector(page).getByRole("spinbutton", { name: "Columns", exact: true });
  await columns.fill("3");
  await columns.press("Enter");
  await expect(panel).toHaveCSS("display", "grid");
  await expect(summary(page, "Layout")).toContainText("Grid · 3 columns · Gap 16");
  await select(page, "Welcome heading");
  await select(page, "Authentication panel");
  await expect(gap).toBeVisible();
  await expect(gap).toHaveValue("16");
});

test("selection colour editing changes matching descendants and leaves other colours intact", async ({
  page,
}) => {
  await page.goto("/dev/import-preview?edit=1");
  await select(page, "Authentication panel");
  const panel = inspector(page);
  await expect(panel.getByRole("heading", { name: "Selection colours" })).toBeVisible();
  const colour = panel.getByRole("textbox", { name: "Selection colour #1e1e1e", exact: true });
  await colour.fill("#224466");
  await colour.press("Enter");
  await expect(page.locator('[data-node-id="desktop-heading"]')).toHaveCSS(
    "color",
    "rgb(34, 68, 102)",
  );
  await expect(page.locator('[data-node-id="desktop-submit"]')).toHaveCSS(
    "background-color",
    "rgb(255, 93, 0)",
  );
  await page.getByLabel("Design canvas", { exact: true }).focus();
  await page.keyboard.press("ControlOrMeta+z");
  await expect(page.locator('[data-node-id="desktop-heading"]')).toHaveCSS(
    "color",
    "rgb(30, 30, 30)",
  );
});

test("appearance disclosure retains strokes, shadows and independent corners", async ({ page }) => {
  await page.goto("/dev/import-preview?edit=1");
  await select(page, "Authentication panel");
  await summary(page, "Add appearance").click();
  await inspector(page).getByRole("button", { name: "Add stroke", exact: true }).click();
  await inspector(page).getByRole("button", { name: "Add shadow", exact: true }).click();
  const layer = page.locator('[data-node-id="desktop-panel"]');
  await expect(layer).toHaveCSS("box-shadow", /rgba|rgb/);
  await summary(page, "More appearance").click();
  await inspector(page)
    .getByRole("button", { name: "Independent corner radii", exact: true })
    .click();
  const radius = inspector(page).getByRole("spinbutton", { name: "Top left radius", exact: true });
  await radius.fill("24");
  await radius.press("Enter");
  await expect(layer).toHaveCSS("border-top-left-radius", "24px");
});

test("instance management is disclosed and read-only inspection still exports", async ({
  page,
}) => {
  await page.goto("/dev/import-preview?edit=1&components=1");
  await select(page, "Card instance");
  const detach = inspector(page).getByRole("button", { name: "Detach instance", exact: true });
  await expect(detach).toBeHidden();
  await summary(page, "Instance actions").click();
  await expect(detach).toBeEnabled();
  await detach.click();
  await expect(summary(page, "Instance actions")).toHaveCount(0);
  await page.goto("/dev/import-preview?edit=1&viewer=1");
  await select(page, "Welcome heading");
  await expect(
    inspector(page).getByRole("heading", { name: "Rendered values", exact: true }),
  ).toBeVisible();
  await expect(inspector(page).getByRole("button", { name: /png/i })).toBeVisible();
});

test("image fit and crop remain available in a quiet inspector in both themes", async ({
  page,
}) => {
  await page.goto("/dev/import-preview?edit=1&images=1");
  await select(page, "Landscape");
  await choose(page, /^Image fit/, "Fill");
  await expect(page.locator('[data-node-id="landscape"] img').first()).toHaveCSS(
    "object-fit",
    "cover",
  );
  await expect(
    inspector(page).getByRole("button", { name: "Crop image", exact: true }),
  ).toBeVisible();
  for (const theme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await expect(inspector(page)).toHaveCSS(
      "background-color",
      theme === "dark" ? "rgb(32, 32, 32)" : "rgb(250, 250, 250)",
    );
    await expect(
      inspector(page).getByRole("spinbutton", { name: "Width", exact: true }),
    ).toBeVisible();
    const overflow = await inspector(page).evaluate((panel) => {
      const right = panel.getBoundingClientRect().right;
      return [...panel.querySelectorAll("input, button, summary")].some(
        (element) => element.checkVisibility() && element.getBoundingClientRect().right > right + 1,
      );
    });
    expect(overflow).toBe(false);
  }
});

test("exposed component properties stay primary while authoring remains in Advanced", async ({
  page,
}) => {
  await page.goto("/dev/import-preview?edit=1&components=1");
  await select(page, "Card");
  await summary(page, "Advanced").click();
  await choose(page, /^Property layer:/, "Label");
  await choose(page, /^Property:/, "text");
  const name = inspector(page).getByRole("textbox", { name: "Property name", exact: true });
  await name.fill("Button label");
  await name.press("Enter");
  await inspector(page).getByRole("button", { name: "Expose property", exact: true }).click();
  await expect(
    inspector(page).getByRole("heading", { name: "Manage properties", exact: true }),
  ).toBeVisible();
  await select(page, "Card instance");
  await summary(page, "Advanced").click();
  const label = inspector(page).getByRole("textbox", { name: "Button label", exact: true });
  await expect(label).toBeVisible();
  await label.fill("Updated label");
  await label.press("Enter");
  await expect(page.locator('[data-node-id="instance-0"]')).toContainText("Updated label");
});

test("a mixed selection can add a fill when only some layers already have one", async ({
  page,
}) => {
  await page.goto("/dev/import-preview?edit=1");
  await select(page, "Welcome heading");
  await page
    .getByRole("button", { name: "Select Sign in button", exact: true })
    .first()
    .click({ modifiers: ["Shift"] });
  await expect(inspector(page)).toContainText("2 layers");
  await summary(page, "Add appearance").click();
  await inspector(page).getByRole("button", { name: "Add fill", exact: true }).click();
  await expect(
    inspector(page).getByRole("button", { name: "Edit fill 1", exact: true }),
  ).toBeVisible();
  const paints = page.locator(
    '[data-node-id="desktop-submit"] > [data-fill-stack] > [data-fill-id]',
  );
  await expect(paints).toHaveCount(2);
  await expect(paints.last()).toHaveCSS("background-color", "rgb(255, 255, 255)");
});

async function number(page: Page, label: string, value: string) {
  const input = inspector(page).getByRole("spinbutton", { name: label, exact: true });
  await input.fill(value);
  await input.press("Enter");
}

test("responsive parent layouts expose the correct child controls after expanding transform settings", async ({
  page,
}) => {
  await page.goto("/dev/import-preview?edit=1");
  await select(page, "Authentication panel");
  await summary(page, "Advanced").click();
  await inspector(page)
    .locator("summary")
    .filter({ hasText: /^Responsive breakpoints$/ })
    .click();
  for (const [width, flow] of [
    ["900", "Grid"],
    ["600", "Vertical"],
  ] as const) {
    await inspector(page).getByRole("button", { name: "Add breakpoint", exact: true }).click();
    const threshold = inspector(page)
      .getByRole("spinbutton", { name: "Frame width up to", exact: true })
      .last();
    await threshold.fill(width);
    await threshold.press("Enter");
    await inspector(page)
      .getByRole("button", { name: /^Breakpoint flow / })
      .last()
      .click();
    await page.getByRole("menuitemradio", { name: flow, exact: true }).click();
  }
  for (const width of [1200, 800, 400]) {
    await select(page, "Desktop 1440 · /login");
    await number(page, "Width", String(width));
    await select(page, "Email input");
    const panel = inspector(page);
    const transform = summary(page, "Transform & constraints").locator("..");
    if (!(await transform.evaluate((element) => element.hasAttribute("open"))))
      await summary(page, "Transform & constraints").click();
    await expect(panel.getByRole("button", { name: /^Horizontal constraint / })).toHaveCount(
      width === 1200 ? 1 : 0,
    );
    await expect(panel.getByRole("spinbutton", { name: "Column span", exact: true })).toHaveCount(
      width === 800 ? 1 : 0,
    );
    await expect(
      panel.getByRole("spinbutton", { name: "Gap adjustment", exact: true }),
    ).toHaveCount(width === 400 ? 1 : 0);
    await expect(page.locator('[data-node-id="desktop-panel"]')).toHaveCSS(
      "display",
      width === 1200 ? "block" : width === 800 ? "grid" : "flex",
    );
  }
});

test("breakpoint edits normalize overlap, padding sides and explicit grid tracks through the real inspector", async ({
  page,
}) => {
  await page.goto("/dev/import-preview?edit=1");
  await select(page, "Desktop 1440 · /login");
  await number(page, "Width", "800");
  await select(page, "Authentication panel");
  await summary(page, "Advanced").click();
  const panel = inspector(page);
  await panel
    .locator("summary")
    .filter({ hasText: /^Responsive breakpoints$/ })
    .click();
  await panel.getByRole("button", { name: "Add breakpoint", exact: true }).click();
  await number(page, "Frame width up to", "900");
  await choose(page, /^Breakpoint flow /, "Grid");
  await number(page, "Breakpoint column gap", "4");
  await choose(page, /^Breakpoint flow /, "Horizontal");
  await number(page, "Breakpoint gap", "-8");
  const artwork = page.locator('[data-node-id="desktop-panel"]');
  await expect(artwork).toHaveCSS("column-gap", "0px");
  await expect(page.locator('[data-node-id="desktop-heading"]')).toHaveCSS("margin-left", "-8px");
  await panel
    .locator("summary")
    .filter({ hasText: /^Padding by side$/ })
    .click();
  await number(page, "Breakpoint padding left", "30");
  await number(page, "Breakpoint padding", "12");
  await expect(artwork).toHaveCSS("padding-left", "12px");
  await choose(page, /^Breakpoint wrap /, "Wrap");
  const gap = panel.getByRole("spinbutton", { name: "Breakpoint gap", exact: true });
  await expect(gap).toHaveValue("0");
  await expect(gap).toHaveAttribute("min", "0");
  await choose(page, /^Breakpoint flow /, "Grid");
  await panel
    .locator("summary")
    .filter({ hasText: /^Breakpoint grid tracks$/ })
    .click();
  await choose(page, /^Breakpoint column 1 unit /, "Pixels");
  await number(page, "Breakpoint column 1 size", "50");
  await expect(artwork).toHaveCSS("grid-template-columns", /^50px /);
  await number(page, "Breakpoint columns", "3");
  await expect
    .poll(() =>
      artwork.evaluate(
        (element) => getComputedStyle(element).gridTemplateColumns.split(" ").length,
      ),
    )
    .toBe(3);
  await expect(artwork).not.toHaveCSS("grid-template-columns", /^50px /);
});
