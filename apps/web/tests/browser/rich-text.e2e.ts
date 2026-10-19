import assert from "node:assert/strict";
import { test, expect } from "./fixtures";
import type { Page } from "playwright/test";

async function openEmptyEditor(page: Page, compact = false) {
  // The shared screenshot helper edits export scale; this test owns keyboard focus.
  await page.removeLocatorHandler(
    page
      .getByRole("spinbutton", { name: "Export scale", exact: true })
      .and(page.locator('[value="2"]')),
  );
  await page.goto(`/dev/import-preview?edit=1${compact ? "&compact=1" : ""}`);
  const canvas = page.getByLabel("Design canvas", { exact: true });
  await canvas.focus();
  await canvas.press("ControlOrMeta+a");
  await canvas.press("Delete");
  await expect(page.locator("[data-node-id]")).toHaveCount(0);
  return canvas;
}

test("new text focuses the canvas editor, replaces the placeholder and grows with typing", async ({
  page,
}) => {
  const canvas = await openEmptyEditor(page, true);
  const bounds = await canvas.boundingBox();
  assert.ok(bounds);
  const point = { x: bounds.x + 200, y: bounds.y + 200 };
  const inspector = page.getByLabel("Inspector", { exact: true });
  await expect(inspector).toBeHidden();
  await page.getByRole("button", { name: "Text tool", exact: true }).click();
  await expect(inspector).toBeHidden();
  await page.mouse.click(point.x, point.y);

  const editor = page.getByRole("textbox", { name: "Edit Text", exact: true });
  await expect(editor).toBeFocused();
  await expect(inspector).toBeVisible();
  assert.equal(await editor.evaluate(() => getSelection()?.toString()), "Text");
  await expect(page.getByRole("button", { name: "Resize Text top left", exact: true })).toHaveCount(
    0,
  );
  const layer = page.locator('[data-node-id][data-selected="true"]');
  const before = await layer.boundingBox();
  assert.ok(before);
  assert.ok(
    Math.abs(before.x - point.x) < 2 && Math.abs(before.y - point.y) < 2,
    JSON.stringify({ before, point }),
  );
  const canvasScroll = await canvas.evaluate((element) => [element.scrollLeft, element.scrollTop]);
  await page.keyboard.type("Fresh text with enough words to grow naturally");
  await expect(editor).toHaveText("Fresh text with enough words to grow naturally");
  await editor.press("ControlOrMeta+z");
  await expect(editor).toBeFocused();
  await expect(editor).not.toHaveText("Fresh text with enough words to grow naturally");
  await editor.press("ControlOrMeta+Shift+z");
  await expect(editor).toHaveText("Fresh text with enough words to grow naturally");
  const after = await layer.boundingBox();
  assert.ok(after && after.width > before.width);
  assert.deepEqual(
    await canvas.evaluate((element) => [element.scrollLeft, element.scrollTop]),
    canvasScroll,
  );
  await editor.press("Enter");
  await page.keyboard.insertText("Second line");
  const multiline = await layer.boundingBox();
  assert.ok(multiline && multiline.height > after.height);

  await editor.press("Escape");
  await expect(editor).toHaveCount(0);
  await expect(canvas).toBeFocused();
  await expect(layer.locator("[data-design-text]")).toContainText("Second line");
  await expect(page.locator("[data-node-id]")).toHaveCount(1);

  await canvas.focus();
  await canvas.press("Enter");
  await expect(editor).toBeFocused();
  await page.keyboard.insertText("Keep this edit");
  await editor.press("Escape");
  await expect(canvas).toBeFocused();
  await expect(layer.locator("[data-design-text]")).toContainText("Keep this edit");
  await canvas.press("ControlOrMeta+z");
  await expect(layer.locator("[data-design-text]")).not.toContainText("Keep this edit");
  await expect(layer.locator("[data-design-text]")).toContainText("Second line");
  await canvas.press("ControlOrMeta+z");
  await expect(layer.locator("[data-design-text]")).toHaveText("Text");
  await canvas.press("ControlOrMeta+z");
  await expect(page.locator("[data-node-id]")).toHaveCount(0);
});

test("dragging text fixes its wrapping width and blur commits the paragraph", async ({ page }) => {
  const canvas = await openEmptyEditor(page);
  const bounds = await canvas.boundingBox();
  assert.ok(bounds);
  await canvas.press("t");
  await page.mouse.move(bounds.x + 150, bounds.y + 150);
  await page.mouse.down();
  await page.mouse.move(bounds.x + 310, bounds.y + 150, { steps: 5 });
  await page.mouse.up();
  const editor = page.getByRole("textbox", { name: "Edit Text", exact: true });
  await expect(editor).toBeFocused();
  const layer = page.locator('[data-node-id][data-selected="true"]');
  const before = await layer.boundingBox();
  assert.ok(before && Math.abs(before.width - 160) < 2, JSON.stringify(before));
  await page.keyboard.insertText(
    "A long paragraph with enough words to wrap onto several lines. ".repeat(8),
  );
  const after = await layer.boundingBox();
  assert.ok(after && Math.abs(after.width - before.width) < 2 && after.height > before.height);
  await page.getByRole("button", { name: "Select tool", exact: true }).click();
  await expect(editor).toHaveCount(0);

  await expect(layer.locator("[data-design-text]")).toContainText(
    "A long paragraph with enough words to wrap onto several lines.",
  );
});

for (const edge of ["right", "bottom"] as const) {
  test(`Escape keeps text and selection aligned after typing past the ${edge} canvas edge`, async ({
    page,
  }) => {
    const canvas = await openEmptyEditor(page);
    await page.getByRole("button", { name: /^Zoom \d+%$/ }).click();
    await page.getByRole("menuitem", { name: /^Zoom to 100%/ }).click();
    await page.getByRole("button", { name: "Text tool", exact: true }).click();
    const size = page.getByRole("spinbutton", {
      name: "Font size",
      exact: true,
    });
    await size.fill("65");
    await size.press("Enter");
    const bounds = await canvas.boundingBox();
    assert.ok(bounds);
    const point =
      edge === "right"
        ? { x: bounds.x + bounds.width - 80, y: bounds.y + 200 }
        : { x: bounds.x + 30, y: bounds.y + bounds.height - 130 };
    await page.mouse.click(point.x, point.y);
    const editor = page.getByRole("textbox", {
      name: "Edit Text",
      exact: true,
    });
    await expect(editor).toBeFocused();
    await page.keyboard.type(edge === "right" ? "Text crossing the canvas edge" : "Line one");
    if (edge === "bottom") {
      await editor.press("Enter");
      await page.keyboard.type("Line two");
      await editor.press("Enter");
      await page.keyboard.type("Line three");
    }
    await editor.press("Escape");
    await expect(editor).toHaveCount(0);
    await expect(canvas).toBeFocused();
    const layer = page.locator('[data-node-id][data-selected="true"]');
    await expect(layer.locator("[data-design-text]")).toContainText(
      edge === "right" ? "Text crossing" : "Line three",
    );
    const layerBox = await layer.boundingBox();
    const handleBox = await page
      .getByRole("button", { name: "Resize Text top left", exact: true })
      .boundingBox();
    assert.ok(layerBox && handleBox);
    expect(Math.abs(handleBox.x + handleBox.width / 2 - layerBox.x)).toBeLessThan(1);
    expect(Math.abs(handleBox.y + handleBox.height / 2 - layerBox.y)).toBeLessThan(1);
    expect(Math.abs(layerBox.x - point.x)).toBeLessThan(1);
    expect(Math.abs(layerBox.y - point.y)).toBeLessThan(1);
    expect(await canvas.evaluate((element) => [element.scrollLeft, element.scrollTop])).toEqual([
      0, 0,
    ]);
  });
}

test("Escape during IME composition keeps typing active until composition finishes", async ({
  page,
}) => {
  const canvas = await openEmptyEditor(page);
  await canvas.press("t");
  await canvas.press("Enter");
  const editor = page.getByRole("textbox", { name: "Edit Text", exact: true });
  await page.keyboard.insertText("日本語");
  await editor.dispatchEvent("keydown", {
    key: "Escape",
    code: "Escape",
    isComposing: true,
  });
  await expect(editor).toBeFocused();
  await expect(editor).toHaveText("日本語");
  await editor.press("Escape");
  await expect(editor).toHaveCount(0);
  await expect(canvas).toBeFocused();
  await expect(page.locator('[data-node-id][data-selected="true"] [data-design-text]')).toHaveText(
    "日本語",
  );
});

test("oversized text stays editable on Escape and commits once corrected", async ({ page }) => {
  const canvas = await openEmptyEditor(page);
  await canvas.press("t");
  await canvas.press("Enter");
  const editor = page.getByRole("textbox", { name: "Edit Text", exact: true });
  await page.keyboard.insertText("a".repeat(10_001));
  await editor.press("Escape");
  await expect(editor).toBeFocused();
  await expect(page.getByRole("status").filter({ hasText: "Shorten the text" })).toBeVisible();
  await editor.press("ControlOrMeta+a");
  await page.keyboard.insertText("Corrected text");
  await editor.press("Escape");
  await expect(editor).toHaveCount(0);
  const text = page.locator('[data-node-id][data-selected="true"] [data-design-text]');
  await expect(text).toHaveText("Corrected text");
  await canvas.press("ControlOrMeta+z");
  await expect(text).toHaveText("Text");
});

test("adopted controls retain their keyboard input", async ({ page, baseURL }) => {
  await page.goto(`${baseURL!}/dev/import-preview?edit=1`);
  await page.getByRole("button", { name: "Select Welcome heading", exact: true }).first().click();
  const heading = page.locator('[data-node-id="desktop-heading"]');
  await heading.locator("[data-design-text]").waitFor();

  const results = await page.evaluate(() => {
    const frame = document.createElement("iframe");
    document.body.appendChild(frame);
    const foreignDocument = frame.contentDocument!;
    const host = document.createElement("div");
    document.body.appendChild(host);
    try {
      return ["input", "textarea", "select", "contenteditable", "contenteditable-false"].map(
        (kind) => {
          const control = foreignDocument.createElement(
            kind.startsWith("contenteditable") ? "div" : kind,
          );
          if (kind.startsWith("contenteditable"))
            control.setAttribute("contenteditable", kind.endsWith("false") ? "false" : "true");
          const target = kind.startsWith("contenteditable")
            ? control.appendChild(foreignDocument.createElement("span"))
            : control;
          host.appendChild(document.adoptNode(control));
          control.focus();
          const prevented = [
            { key: "p", code: "KeyP" },
            { key: " ", code: "Space" },
            { key: "c", code: "KeyC", ctrlKey: true, altKey: true },
            { key: "z", code: "KeyZ", ctrlKey: true },
            { key: "Delete", code: "Delete" },
          ].map((key) => {
            const event = new KeyboardEvent("keydown", {
              ...key,
              bubbles: true,
              cancelable: true,
            });
            target.dispatchEvent(event);
            return event.defaultPrevented;
          });
          return { kind, currentRealm: target instanceof Element, prevented };
        },
      );
    } finally {
      host.remove();
      frame.remove();
    }
  });
  for (const result of results) {
    assert.equal(result.currentRealm, false, result.kind);
    assert.deepEqual(result.prevented, [false, false, false, false, false], result.kind);
  }
  assert.equal(await heading.count(), 1, "typing in an adopted control must retain the layer");
  await page.getByLabel("Design canvas", { exact: true }).focus();
  await page.keyboard.press("Delete");
  await heading.waitFor({ state: "detached" });
});

test("rich text paste sanitisation, formatting and persisted editing", async ({
  page,
  baseURL,
}) => {
  const base = baseURL!;

  await page.goto(`${base}/dev/import-preview?edit=1`);
  await page.waitForFunction(() =>
    [...document.querySelectorAll("[data-node-id]")].some((node) =>
      Object.keys(node).some((key) => key.startsWith("__reactProps")),
    ),
  );
  const heading = page.locator('[data-node-id="desktop-heading"]');
  await page.getByRole("button", { name: "Select Welcome heading", exact: true }).first().click();
  await heading.dblclick();
  const editor = heading.locator("[data-rich-text-editor]");
  await editor.waitFor();
  await editor.press("ControlOrMeta+a");
  await editor.evaluate((element) => {
    const data = new DataTransfer();
    data.setData(
      "text/html",
      '<p>Hello <b>bold</b> <em>italic</em> <a href="https://example.com">link</a></p><ol><li>First</li><li><u>Second</u></li></ol><p><br></p><script>window.richPasteExecuted=true</script><img src="https://invalid.test/leak" onerror="window.richPasteExecuted=true">',
    );
    element.dispatchEvent(
      new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData: data,
      }),
    );
  });
  assert.equal(await page.evaluate(() => Reflect.get(window, "richPasteExecuted")), undefined);
  assert.equal(await editor.locator("img,script").count(), 0);
  assert.equal(await editor.locator("ol li").count(), 2);
  assert.equal(await editor.locator('a[href="https://example.com"]').innerText(), "link");
  assert.equal(
    await page.getByRole("textbox", { name: "Content", exact: true }).count(),
    0,
    "text content is edited on the canvas",
  );
  const select = async (value: string) => {
    await editor.evaluate((root, text) => {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode()))
        if ((node.textContent ?? "").includes(text)) {
          const range = document.createRange();
          const offset = (node.textContent ?? "").indexOf(text);
          range.setStart(node, offset);
          range.setEnd(node, offset + text.length);
          const selection = window.getSelection();
          if (!selection) throw new Error("Text selection unavailable");
          selection.removeAllRanges();
          selection.addRange(range);
          document.dispatchEvent(new Event("selectionchange"));
          return;
        }
      throw new Error(`Missing run ${text}`);
    }, value);
  };
  await select("bold");
  await editor.press("ControlOrMeta+i");
  assert.equal(
    await editor
      .locator("b,i,span,strong")
      .filter({ hasText: /^bold$/ })
      .first()
      .evaluate((el) => getComputedStyle(el).fontStyle),
    "italic",
  );
  await page
    .locator("summary")
    .filter({ hasText: /^Formatting$/ })
    .click();
  await page.getByRole("button", { name: "Strike", exact: true }).click();
  await select("First");
  await page.getByRole("button", { name: "Bulleted list", exact: true }).click();
  assert.equal(await editor.locator("ul li").count(), 1);
  await page.getByRole("button", { name: "Numbered list", exact: true }).click();
  assert.equal(await editor.locator("ol li").count(), 2);
  await select("bold");
  const copied = await editor.evaluate((root) => {
    const data = new DataTransfer();
    root.dispatchEvent(
      new ClipboardEvent("copy", {
        bubbles: true,
        cancelable: true,
        clipboardData: data,
      }),
    );
    return {
      text: data.getData("text/plain"),
      html: data.getData("text/html"),
    };
  });
  assert.equal(copied.text, "bold");
  assert.match(copied.html, /italic/);
  await select("italic");
  const link = page.getByRole("textbox", { name: "Text selection link" });
  await link.fill("javascript:alert(1)");
  assert.equal(await link.getAttribute("aria-invalid"), "true");
  await link.fill("https://tidy.example/docs");
  assert.equal(await editor.locator('a[href="https://tidy.example/docs"]').innerText(), "italic");
  // Commit, reopen and compare the persisted formatting, including lists and blank paragraphs.
  await page.getByRole("button", { name: "Select Welcome heading", exact: true }).first().click();
  await editor.waitFor({ state: "detached" });
  const text = heading.locator("[data-design-text]");
  assert.equal(await text.locator("ol li").count(), 2);
  assert.equal(await text.locator('a[href="https://tidy.example/docs"]').innerText(), "italic");
  assert.equal(
    await text
      .locator("span")
      .filter({ hasText: /^bold$/ })
      .last()
      .evaluate((el) => getComputedStyle(el).fontWeight),
    "700",
  );
  const committed = await text.innerHTML();
  await heading.dblclick();
  await editor.waitFor();
  assert.equal(await editor.locator("ol li").count(), 2);
  await page.getByRole("button", { name: "Select Welcome heading", exact: true }).first().click();
  await editor.waitFor({ state: "detached" });
  assert.equal(await text.innerHTML(), committed);
  await page.getByLabel("Design canvas", { exact: true }).focus();
  await page.keyboard.press("ControlOrMeta+z");
  await text.locator("ol").waitFor({ state: "detached" });
  assert.equal(await text.locator("ol").count(), 0);
  await page.keyboard.press("ControlOrMeta+Shift+z");
  await text.locator("ol").waitFor();
  assert.equal(await text.innerHTML(), committed);
});
