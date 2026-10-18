import type { Page } from "playwright";
import { test, expect, required } from "./fixtures";

async function openEditor(page: Page, fixture = "tokens") {
  // These tests do not export artwork. The shared export-scale helper edits a
  // field when an inspector first opens, which would move keyboard focus.
  await page.removeLocatorHandler(
    page
      .getByRole("spinbutton", { name: "Export scale", exact: true })
      .and(page.locator('[value="2"]')),
  );
  await page.goto(`/dev/import-preview?edit=1&${fixture}=1`);
  const canvas = page.getByRole("region", { name: "Design canvas", exact: true });
  await expect(canvas).toBeVisible();
  await expect(page.getByRole("button", { name: "Select tool", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  return canvas;
}

test("Tab and menu navigation keep focus and artwork independent", async ({ page }) => {
  const canvas = await openEditor(page);
  const layer = page.getByRole("button", { name: "Select Tokens frame", exact: true });
  await layer.click();
  const row = page.getByRole("treeitem", { name: "Tokens frame", exact: true });
  await expect(row).toBeFocused();
  const position = page.getByRole("spinbutton", { name: "Y", exact: true });
  const before = await position.inputValue();
  await row.press("ArrowDown");
  const child = page.getByRole("treeitem", { name: "Card", exact: true });
  await expect(child).toBeFocused();
  await expect(position).toHaveValue(before);
  await child.press("Tab");
  await expect(child).not.toBeFocused();
  await expect(page.locator(":focus")).toHaveCount(1);
  await expect(page.getByRole("textbox", { name: "Layer name", exact: true })).toHaveValue(
    "Tokens frame",
  );
  await expect(position).toHaveValue(before);

  await layer.focus();
  await layer.press("r");
  await expect(page.getByRole("button", { name: "Select tool", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await layer.press("Shift+F10");
  const menu = page.getByRole("menu", { name: "Layer actions", exact: true });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "Copy properties", exact: true })).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(menu.getByRole("menuitem", { name: "Paste properties", exact: true })).toBeFocused();
  await expect(position).toHaveValue(before);
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(layer).toBeFocused();

  await canvas.focus();
  await canvas.press("ArrowDown");
  await expect(position).not.toHaveValue(before);
  await canvas.press("Tab");
  await expect(canvas).not.toBeFocused();
  await expect(page.locator(":focus")).toHaveCount(1);
  await expect(page.getByRole("textbox", { name: "Layer name", exact: true })).toHaveValue(
    "Tokens frame",
  );
});

test("file tabs and the layer tree provide coherent keyboard navigation", async ({ page }) => {
  await openEditor(page);
  const layers = page.getByRole("tab", { name: "Layers", exact: true });
  const tokens = page.getByRole("tab", { name: "Tokens", exact: true });
  await layers.focus();
  await layers.press("ArrowRight");
  await expect(tokens).toBeFocused();
  await expect(tokens).toHaveAttribute("tabindex", "0");
  await expect(layers).toHaveAttribute("tabindex", "-1");
  await expect(page.getByRole("tabpanel", { name: "Tokens", exact: true })).toBeVisible();
  await tokens.press("Home");
  await expect(layers).toBeFocused();
  await expect(page.getByRole("tabpanel", { name: "Layers", exact: true })).toBeVisible();

  const tree = page.getByRole("tree", { name: "Layers", exact: true });
  await expect(tree).toHaveAttribute("aria-multiselectable", "true");
  const frame = tree.getByRole("treeitem", { name: "Tokens frame", exact: true });
  const card = tree.getByRole("treeitem", { name: "Card", exact: true });
  const label = tree.getByRole("treeitem", { name: "Label", exact: true });
  await frame.focus();
  await frame.press("ArrowLeft");
  await expect(frame).toHaveAttribute("aria-expanded", "false");
  await expect(tree.getByRole("treeitem")).toHaveCount(1);
  await frame.press("ArrowRight");
  await expect(frame).toHaveAttribute("aria-expanded", "true");
  await frame.press("ArrowRight");
  await expect(card).toBeFocused();
  await card.press("Enter");
  await expect(card).toHaveAttribute("aria-selected", "true");
  await card.press("ArrowDown");
  await expect(label).toBeFocused();
  await label.press("Shift+Space");
  await expect(tree.getByRole("treeitem", { selected: true })).toHaveCount(2);
  await label.press("ArrowLeft");
  await expect(frame).toBeFocused();
  await expect(tree.getByRole("treeitem", { selected: true })).toHaveCount(2);
  await frame.press("Shift+F10");
  const menu = page.getByRole("menu", { name: "Layer actions", exact: true });
  await expect(menu).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(frame).toBeFocused();
  await frame.press("End");
  const secondCard = tree.getByRole("treeitem", { name: "Second card", exact: true });
  await expect(secondCard).toBeFocused();
  await secondCard.press("Enter");
  await secondCard.press("ControlOrMeta+d");
  await expect(tree.getByRole("treeitem", { name: "Second card copy", exact: true })).toBeVisible();
});

test("keyboard insertion works in an empty file and can be undone", async ({ page }) => {
  const canvas = await openEditor(page);
  await canvas.focus();
  await canvas.press("ControlOrMeta+a");
  await canvas.press("Delete");
  await expect(page.locator("[data-node-id]")).toHaveCount(0);

  const frameTool = page.getByRole("button", { name: "Frame tool", exact: true });
  await frameTool.focus();
  await frameTool.press("Enter");
  await expect(frameTool).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("[data-node-id]")).toHaveCount(0);
  await canvas.focus();
  await canvas.press("Enter");
  await expect(page.locator("[data-node-id]")).toHaveCount(1);
  await expect(page.getByRole("textbox", { name: "Layer name", exact: true })).toHaveValue("Frame");
  await expect(canvas).toBeFocused();

  for (const [shortcut, name] of [
    ["r", "Rectangle"],
    ["t", "Text"],
  ]) {
    await canvas.press("Escape");
    await canvas.press(shortcut);
    await canvas.press("Enter");
    await expect(page.getByRole("textbox", { name: "Layer name", exact: true })).toHaveValue(name);
    await expect(canvas).toBeFocused();
  }
  await expect(page.locator("[data-node-id]")).toHaveCount(3);
  await canvas.press("ControlOrMeta+z");
  await expect(page.locator("[data-node-id]")).toHaveCount(2);
});

test("vector focus chooses the point and native editing buttons keep Enter", async ({ page }) => {
  const canvas = await openEditor(page, "vector");
  await page.getByRole("button", { name: "Select Editable path", exact: true }).click();
  await page.getByRole("button", { name: "Edit points", exact: true }).click();
  const second = page.getByRole("button", { name: "Anchor p2", exact: true });
  await second.focus();
  const x = page.getByRole("spinbutton", { name: "Point X", exact: true });
  await expect(x).toHaveValue("140");
  await second.press("ArrowRight");
  await expect(x).toHaveValue("141");
  const first = page.getByRole("button", { name: "Anchor p1", exact: true });
  await first.focus();
  await expect(x).toHaveValue("20");

  const pathData = async () => {
    const source = required(
      await page
        .locator('[data-node-id="editable-path"] img[data-vector-path]')
        .getAttribute("src"),
    );
    return required(
      decodeURIComponent(source.slice(source.indexOf(",") + 1)).match(
        /<path\b[^>]*\sd="([^"]*)"/,
      )?.[1],
    );
  };
  const before = await pathData();
  const handle = page.getByRole("button", { name: "Outgoing handle p1", exact: true });
  await handle.focus();
  await handle.press("ArrowRight");
  expect(await pathData()).not.toBe(before);
  await expect(x).toHaveValue("20");
  const open = page.getByRole("button", { name: "Open contour", exact: true });
  await open.focus();
  await open.press("Enter");
  await expect(page.locator("[data-vector-editor]")).toBeVisible();
  expect(await pathData()).not.toMatch(/Z$/);
  const close = page.getByRole("button", { name: "Close contour", exact: true });
  await close.press("Enter");
  expect(await pathData()).toMatch(/Z$/);
  await second.focus();
  await second.press("Delete");
  await expect(second).toHaveCount(0);
  await expect(first).toBeFocused();
  await first.press("Escape");
  await expect(page.locator("[data-vector-editor]")).toHaveCount(0);
  await expect(canvas).toBeFocused();
});

test("virtual layer navigation reaches offscreen rows and retains a single Tab destination", async ({
  page,
}) => {
  await page.goto("/dev/performance-preview?nodes=1000");
  const tree = page.getByRole("tree", { name: "Layers", exact: true });
  const first = tree.getByRole("treeitem").first();
  await first.focus();
  await first.press("End");
  const last = tree.getByRole("treeitem", { name: "Layer 999", exact: true });
  await expect(last).toBeFocused();
  await last.press("Enter");
  await expect(last).toHaveAttribute("aria-selected", "true");
  await last.press("Home");
  await expect(tree.getByRole("treeitem").first()).toBeFocused();
  const canvas = page.getByRole("region", { name: "Design canvas", exact: true });
  await canvas.focus();
  // Restore the last canvas selection after keyboard focus has moved to the
  // beginning of the tree. A mounted row must remain a Tab destination.
  await expect(last).toHaveAttribute("tabindex", "0");
  await expect(tree.locator('[role="treeitem"][tabindex="0"]')).toHaveCount(1);
});
