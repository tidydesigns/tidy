import assert from "node:assert/strict";
import { chromium } from "playwright";
const build = await Bun.build({
  entrypoints: [new URL("./fixtures/rich-text-dom.ts", import.meta.url).pathname],
  target: "browser",
  format: "iife",
});
assert.equal(build.success, true, String(build.logs));
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.setContent("<div id='root'></div>");
  await page.addScriptTag({ content: await build.outputs[0].text() });
  const values = await page.evaluate(() => {
    const {
      readEditableRichText: read,
      richTextElements: elements,
      sanitizeRichPaste: sanitize,
    } = window.richTextDOM;
    const parse = (html) => {
      const root = document.createElement("div");
      root.innerHTML = html;
      return read(root);
    };
    const richText = [
      {
        runs: [
          { text: "Hello ", bold: false },
          { text: "bold", bold: true, italic: true },
          { text: " link", href: "https://example.com", underline: true, strike: false },
        ],
      },
      { list: "ordered", runs: [{ text: "First" }] },
      { list: "ordered", runs: [{ text: "Second" }] },
      { runs: [{ text: "" }] },
    ];
    const root = document.createElement("div");
    root.replaceChildren(...elements(richText));
    const normalized = read(root);
    root.replaceChildren(...elements(normalized.richText));
    return {
      normalized,
      reopened: read(root),
      wrapped: parse(
        "<div><div>Hello <b>bold</b></div><ol><li>First</li><li>Second</li></ol><div><br></div></div>",
      ),
      spaced: parse("<p>First</p>\n<p>Second</p>\n<p><br></p>"),
      inline: parse("A<br>B"),
      plain: parse(sanitize("", "A\n\nB\n")),
      safe: parse(
        sanitize(
          '<p><a href="javascript:alert(1)" onclick="bad()">bad</a><a href="/safe">good</a></p><script>bad()</script><svg><text>bad</text></svg>',
          "",
        ),
      ),
    };
  });
  assert.deepEqual(values.normalized, values.reopened);
  assert.equal(values.wrapped.text, "Hello bold\nFirst\nSecond\n");
  assert.equal(values.spaced.text, "First\nSecond\n");
  assert.equal(values.inline.text, "A\nB");
  assert.equal(values.plain.text, "A\n\nB\n");
  assert.equal(values.safe.text, "badgood");
  assert.equal(values.safe.richText[0].runs[0].href, undefined);
  assert.equal(values.safe.richText[0].runs[1].href, "/safe");
  assert.equal(values.wrapped.richText[0].runs[1].bold, true);
  assert.equal(values.wrapped.richText[1].list, "ordered");
  console.log(
    "PASS: DOM run round trips, browser wrapper normalization, list paragraphs, blank/trailing lines and sanitized URLs/markup",
  );
} finally {
  await browser.close();
}
