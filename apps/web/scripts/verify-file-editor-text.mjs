import { chooseSelectMenu } from "./select-menu-controls.mjs";
import assert from "node:assert/strict";
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const browser = await chromium.launch({ headless: true, args: ["--no-proxy-server"] });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(
    `${process.env.EDITOR_TEST_URL || "http://127.0.0.1:3107"}/dev/import-preview?edit=1`,
  );
  const heading = page.locator('[data-node-id="desktop-heading"]');
  // Nested text must enter editing even when drag capture sends both clicks to the canvas.
  await heading.dblclick();
  const initialEditor = heading.getByRole("textbox", { name: "Edit Welcome heading" });
  await initialEditor.waitFor();
  await initialEditor.press("Escape");
  assert.equal(await heading.getAttribute("data-selected"), "true");
  await page.getByRole("button", { name: "Select Welcome heading", exact: true }).first().click();
  const field = (name) => page.getByRole("spinbutton", { name, exact: true });
  const set = async (name, value) => {
    await field(name).fill(String(value));
    await field(name).press("Enter");
  };
  await chooseSelectMenu(page, "Line height mode", "px");
  await set("Line height px", 42);
  assert.equal(await heading.evaluate((element) => getComputedStyle(element).lineHeight), "42px");
  await chooseSelectMenu(page, "Line height mode", "%");
  assert.ok(Math.abs(Number(await field("Line height %").inputValue()) - 140) < 0.1);
  await chooseSelectMenu(page, "Line height mode", "Auto");
  assert.equal(await heading.evaluate((element) => element.style.lineHeight), "normal");
  await chooseSelectMenu(page, "Line height mode", "%");
  await set("Paragraph spacing", 12);
  await chooseSelectMenu(page, "Vertical align", "Bottom");
  assert.equal(await heading.evaluate((element) => element.style.justifyContent), "flex-end");
  await heading.dblclick();
  const editor = heading.getByRole("textbox", { name: "Edit Welcome heading" });
  await editor.waitFor();
  await editor.press("ControlOrMeta+a");
  await editor.type("First");
  await editor.press("Enter");
  await editor.type("Second");
  assert.equal(await editor.evaluate((element) => element.children.length), 2);
  await page.getByRole("button", { name: "Select Welcome heading", exact: true }).first().click();
  await page.waitForTimeout(100);
  const rendered = heading.locator("[data-design-text]");
  assert.equal(await rendered.locator(":scope > *").count(), 2);
  assert.equal(
    await rendered
      .locator(":scope > *")
      .nth(1)
      .evaluate((element) => element.style.marginTop),
    "12px",
  );
  assert.equal(await rendered.innerText(), "First\nSecond");
  await chooseSelectMenu(page, "Text width", "Auto width");
  const width = await heading.evaluate((element) => element.getBoundingClientRect().width);
  assert.ok(width > 0 && width < 200, `Auto width should fit the text, got ${width}`);
  await chooseSelectMenu(page, "Text height", "Auto height");
  const naturalHeight = await heading.evaluate((element) => element.scrollHeight);
  assert.ok(
    naturalHeight >= 2 * 35 + 12,
    `Auto height should fit two lines and spacing, got ${naturalHeight}`,
  );
  await chooseSelectMenu(page, "Text case", "UPPERCASE");
  await heading.dblclick();
  const uppercaseEditor = heading.getByRole("textbox", { name: "Edit Welcome heading" });
  await uppercaseEditor.press("ControlOrMeta+a");
  await uppercaseEditor.type("mixed Case");
  await uppercaseEditor.evaluate((element) => {
    const data = new DataTransfer();
    data.setData("text/plain", "\nnext <raw>\n");
    element.dispatchEvent(
      new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: data }),
    );
  });
  await page.getByRole("button", { name: "Select Welcome heading", exact: true }).first().click();
  await page.waitForTimeout(100);
  assert.equal(
    await page.getByRole("textbox", { name: "Content", exact: true }).inputValue(),
    "mixed Case\nnext <raw>\n",
  );
  assert.equal(await rendered.locator(":scope > *").count(), 3);
  assert.equal(await rendered.locator(":scope > *").first().textContent(), "mixed Case");
  await page.getByLabel("Design canvas", { exact: true }).focus();
  await page.keyboard.press("ControlOrMeta+z");
  assert.equal(
    await page.getByRole("textbox", { name: "Content", exact: true }).inputValue(),
    "First\nSecond",
  );
  await set("Maximum lines", 1);
  const clamp = await heading.evaluate((element) => {
    const text = element.querySelector("[data-design-text]");
    return {
      height: text.getBoundingClientRect().height,
      scrollHeight: text.scrollHeight,
      lineHeight: parseFloat(getComputedStyle(element).lineHeight),
    };
  });
  assert.ok(
    clamp.height > 0 && clamp.height < clamp.scrollHeight,
    `Maximum lines should clip additional paragraphs: ${JSON.stringify(clamp)}`,
  );
  await field("Maximum lines").fill("");
  await field("Maximum lines").press("Enter");
  await chooseSelectMenu(page, "Text width", "Fixed");
  await set("Width", 100);
  const content = page.getByRole("textbox", { name: "Content", exact: true });
  await content.fill("A very long single line that should truncate");
  await content.press("ControlOrMeta+Enter");
  await chooseSelectMenu(page, "Text wrapping", "Single line");
  await chooseSelectMenu(page, "Truncation", "Ellipsis");
  const truncated = await heading
    .locator("[data-design-text] > *")
    .first()
    .evaluate((element) => ({
      overflow: getComputedStyle(element).textOverflow,
      width: element.clientWidth,
      contentWidth: element.scrollWidth,
    }));
  assert.equal(truncated.overflow, "ellipsis");
  assert.ok(
    truncated.contentWidth > truncated.width,
    `Ellipsis needs overflowing text: ${JSON.stringify(truncated)}`,
  );
  // Long/empty editing must keep the native caret and current layer selection.
  await chooseSelectMenu(page, "Text wrapping", "Wrap");
  await chooseSelectMenu(page, "Text case", "Original");
  await chooseSelectMenu(page, "Text width", "Auto width");
  await content.fill("ab");
  await content.press("ControlOrMeta+Enter");
  await heading.dblclick();
  const live = heading.getByRole("textbox", { name: "Edit Welcome heading" });
  const beforeWidth = await heading.evaluate((element) => element.getBoundingClientRect().width);
  await live.evaluate((element) => {
    const text = document.createTreeWalker(element, NodeFilter.SHOW_TEXT).nextNode(),
      range = document.createRange();
    range.setStart(text, 1);
    range.collapse(true);
    const selection = getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  });
  await page.keyboard.insertText("XYZ");
  assert.equal(await live.textContent(), "aXYZb");
  assert.equal(
    await live.evaluate(() => getSelection().anchorOffset),
    4,
    "typing preserves the insertion caret",
  );
  assert.ok(
    (await heading.evaluate((element) => element.getBoundingClientRect().width)) > beforeWidth,
    "auto width grows during editing",
  );
  await live.press("Escape");
  assert.equal(
    await content.inputValue(),
    "ab",
    "Escape cancels without overwriting persisted text",
  );
  assert.equal(await heading.getAttribute("data-selected"), "true");
  const longText = "Long text with spaces and <literal> content. ".repeat(35) + "\n\nEnd";
  await content.fill(longText);
  await content.press("ControlOrMeta+Enter");
  await chooseSelectMenu(page, "Text width", "Fixed");
  await set("Width", 220);
  const longHeight = await heading.evaluate((element) => element.getBoundingClientRect().height);
  assert.ok(longHeight > 200, `auto height fits long text: ${longHeight}`);
  await chooseSelectMenu(page, "Text width", "Auto width");
  await page.getByLabel("Design canvas", { exact: true }).focus();
  await page.keyboard.press("Enter");
  await live.press("ControlOrMeta+a");
  await live.press("Backspace");
  const emptySize = await heading.evaluate((element) => ({
    width: parseFloat(getComputedStyle(element).width),
    height: parseFloat(getComputedStyle(element).height),
  }));
  assert.ok(
    emptySize.width >= 1 && emptySize.height > 0,
    `empty auto-sized text stays targetable: ${JSON.stringify(emptySize)}`,
  );
  await page
    .getByRole("button", { name: "Select Sign in description", exact: true })
    .first()
    .click();
  const description = page.locator('[data-node-id="desktop-description"]');
  assert.equal(
    await description.getAttribute("data-selected"),
    "true",
    "committing text must preserve the next selection",
  );
  assert.equal(await heading.locator("[data-design-text]").textContent(), "");
  assert.ok(
    (await heading.evaluate((element) => parseFloat(getComputedStyle(element).width))) >= 1,
    "committed empty auto-width text stays targetable",
  );
  await page.getByRole("button", { name: "Select Welcome heading", exact: true }).first().click();
  assert.equal(await content.inputValue(), "");
  await page.getByLabel("Design canvas", { exact: true }).focus();
  await page.keyboard.press("ControlOrMeta+z");
  assert.equal(
    await content.inputValue(),
    longText,
    "undo restores the complete long text including empty paragraphs",
  );
  await page.keyboard.press("ControlOrMeta+Shift+z");
  assert.equal(await content.inputValue(), "", "redo restores empty text");
  await page
    .getByRole("button", { name: "Select Sign in description", exact: true })
    .first()
    .click({ modifiers: ["Shift"] });
  await set("Font size", 20);
  await chooseSelectMenu(page, "Line height mode", "px");
  await set("Line height px", 28);
  await set("Paragraph spacing", 9);
  for (const layer of [heading, description]) {
    assert.equal(await layer.getAttribute("data-selected"), "true");
    assert.deepEqual(
      await layer.evaluate((element) => ({
        fontSize: getComputedStyle(element).fontSize,
        lineHeight: getComputedStyle(element).lineHeight,
      })),
      { fontSize: "20px", lineHeight: "28px" },
    );
  }
  assert.equal(await heading.locator("[data-design-text]").textContent(), "");
  assert.equal(
    await description.locator("[data-design-text]").textContent(),
    "Sign in to your Tidy account.",
    "multi-edit preserves each layer's text",
  );
  assert.deepEqual(errors, []);
  console.log(
    "PASS: text line height modes, paragraph spacing, vertical alignment, multiline editing, plain-text paste, case preservation, auto sizing, truncation undo, long/empty text, live sizing/caret, next selection and multi-edit; no page errors",
  );
} finally {
  await browser.close();
}
