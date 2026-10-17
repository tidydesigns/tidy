import assert from "node:assert/strict";
import { test } from "./fixtures";

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
      '<p>Hello <b>bold</b> <em>italic</em> <a href="https://example.com">link</a></p><ol><li>First</li><li><u>Second</u></li></ol><p><br></p><script>(window as Window & { richPasteExecuted?: boolean }).richPasteExecuted=true</script><img src="https://invalid.test/leak">',
    );
    element.dispatchEvent(
      new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: data }),
    );
  });
  assert.equal(
    await page.evaluate(
      () => (window as Window & { richPasteExecuted?: boolean }).richPasteExecuted,
    ),
    undefined,
  );
  assert.equal(await editor.locator("img,script").count(), 0);
  assert.equal(await editor.locator("ol li").count(), 2);
  assert.equal(await editor.locator('a[href="https://example.com"]').innerText(), "link");
  assert.equal(
    await page.getByRole("textbox", { name: "Content", exact: true }).count(),
    0,
    "whole-layer controls should collapse during range editing",
  );
  const select = async (value: string) => {
    await editor.evaluate((root, text) => {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode()))
        if (node.textContent!.includes(text)) {
          const range = document.createRange();
          const offset = node.textContent!.indexOf(text);
          range.setStart(node, offset);
          range.setEnd(node, offset + text.length);
          const selection = window.getSelection();
          selection!.removeAllRanges();
          selection!.addRange(range);
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
      new ClipboardEvent("copy", { bubbles: true, cancelable: true, clipboardData: data }),
    );
    return { text: data.getData("text/plain"), html: data.getData("text/html") };
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

  console.log(
    "PASS: rich paste sanitization, emphasis keyboard/selection controls, safe links, lists, contextual inspector, reopen and one-step undo/redo",
  );
});
