// Isolated component exercise: real browser UI, mocked upload and analytics services.
import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright";
const root = resolve(import.meta.dirname, "..");
const fixture = resolve(root, ".artifacts/feedback-browser");
await mkdir(fixture, { recursive: true });
await Bun.write(
  `${fixture}/entry.tsx`,
  `
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { FeedbackProvider, SendFeedback } from "../../components/workspace/send-feedback";
import { UpgradeDialog } from "../../components/workspace/upgrade-dialog";
import { openFeedback } from "../../lib/feedback/commands";
function Fixture() {
  const [compact, setCompact] = useState(false);
  return <FeedbackProvider>
    <input aria-label="Other input" /><div contentEditable suppressContentEditableWarning role="textbox" aria-label="Editable text" />
    <button onClick={() => setCompact(value => !value)}>Toggle panels</button>
    <button onClick={openFeedback}>Open with command</button>
    <SendFeedback compact={compact} showShortcut className={compact ? "rounded-full" : ""} />
    <UpgradeDialog organizationId="test-org" owner firstMonthUsed={false} limits={{files:null,editors:null,storageBytes:null}} triggerClassName="" />
    <dialog id="other-dialog"><button onClick={() => document.getElementById("other-dialog").close()}>Close other</button></dialog>
  </FeedbackProvider>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);`,
);
const build = await Bun.build({
  entrypoints: [`${fixture}/entry.tsx`],
  target: "browser",
  outdir: fixture,
  define: { "process.env.NEXT_PUBLIC_POSTHOG_SURVEY_ID": JSON.stringify("test-survey") },
  plugins: [
    {
      name: "mock-posthog",
      setup(build) {
        build.onLoad({ filter: /posthog-js.*\.(js|mjs)$/ }, () => ({
          contents:
            "export default { capture(event, properties) { window.events ??= []; window.events.push({event, properties}); return window.rejectAnalytics ? undefined : {}; } };",
          loader: "js",
        }));
      },
    },
  ],
});
assert.ok(build.success, String(build.logs));
let uploads = 0,
  failUpload = true;
const ids = [];
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/entry.js") return new Response(Bun.file(`${fixture}/entry.js`));
    if (path === "/api/feedback/attachments") {
      uploads++;
      const form = await request.formData();
      ids.push(form.get("id"));
      assert.equal(form.getAll("images").length, 1);
      if (failUpload) return Response.json({ error: "Upload failed for test" }, { status: 503 });
      return Response.json({ urls: ["https://app.example/api/feedback/attachments/test/0"] });
    }
    return new Response(
      '<!doctype html><html><body><div id="root"></div><script type="module" src="/entry.js"></script></body></html>',
      { headers: { "Content-Type": "text/html" } },
    );
  },
});
let browser;
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url.href);
  const trigger = page.getByRole("button", { name: "Send feedback", exact: true });
  const dialog = page.getByRole("dialog", { name: "Send feedback", exact: true });
  const toast = page.getByRole("status").filter({ hasText: "Thanks for your feedback." });
  for (const name of ["Send feedback", "Upgrade to Pro"]) {
    const opener = page.getByRole("button", { name, exact: true });
    const modal = page.getByRole("dialog", { name, exact: true });
    await opener.click();
    const bounds = await modal.boundingBox();
    const inside = { x: bounds.x + 5, y: bounds.y + 5 };
    await page.mouse.click(inside.x, inside.y);
    assert.equal(await modal.isVisible(), true, "Dialog padding does not dismiss");
    await page.mouse.move(inside.x, inside.y);
    await page.mouse.down();
    await page.mouse.move(1, 1);
    await page.mouse.up();
    assert.equal(await modal.isVisible(), true, "Dragging from inside does not dismiss");
    await page.mouse.click(1, 1);
    await modal.waitFor({ state: "hidden" });
    assert.equal(
      await opener.evaluate((element) => element === document.activeElement),
      true,
      "Backdrop dismissal restores focus",
    );
  }
  let releaseCheckout;
  const checkoutHeld = new Promise((resolve) => {
    releaseCheckout = resolve;
  });
  await page.route("**/api/billing/checkout", async (route) => {
    await checkoutHeld;
    await route.fulfill({ status: 503, json: { error: "Checkout failed for test" } });
  });
  await page.getByRole("button", { name: "Upgrade to Pro", exact: true }).click();
  const upgrade = page.getByRole("dialog", { name: "Upgrade to Pro", exact: true });
  await page.getByRole("button", { name: "Continue with monthly Pro" }).click();
  await page.getByRole("button", { name: "Opening checkout…" }).waitFor();
  await page.mouse.click(1, 1);
  assert.equal(await upgrade.isVisible(), true, "Pending checkout blocks backdrop dismissal");
  await page.keyboard.press("Escape");
  assert.equal(await upgrade.isVisible(), true, "Pending checkout blocks Escape");
  releaseCheckout();
  await page.getByRole("alert").filter({ hasText: "Checkout failed for test" }).waitFor();
  await page.mouse.click(1, 1);
  await upgrade.waitFor({ state: "hidden" });
  await trigger.waitFor();
  assert.equal(await trigger.getAttribute("aria-keyshortcuts"), "Shift+F");
  await page.getByLabel("Other input").focus();
  await page.keyboard.press("Shift+F");
  assert.equal(await dialog.count(), 0, "Typing does not open feedback");
  await page.getByRole("textbox", { name: "Editable text" }).focus();
  await page.keyboard.press("Shift+F");
  assert.equal(await dialog.count(), 0, "Contenteditable typing does not open feedback");
  await trigger.focus();
  await page.keyboard.press("f");
  assert.equal(await dialog.count(), 0, "The frame shortcut is unaffected");
  await page.keyboard.press("Shift+F");
  await dialog.waitFor();
  await page.getByLabel("Feedback", { exact: true }).fill("Draft survives");
  await page.mouse.click(1, 1);
  await dialog.waitFor({ state: "hidden" });
  await page.getByRole("button", { name: "Toggle panels" }).click();
  assert.equal(await trigger.textContent(), "", "Minimised feedback is an icon button");
  await page.getByRole("button", { name: "Open with command" }).click();
  await dialog.waitFor();
  assert.equal(await page.getByLabel("Feedback", { exact: true }).inputValue(), "Draft survives");
  await page.keyboard.press("Escape");
  await page.evaluate(() => document.getElementById("other-dialog").showModal());
  await page.keyboard.press("Shift+F");
  assert.equal(await dialog.count(), 0, "Another dialog is not interrupted");
  await page.getByRole("button", { name: "Close other" }).click();
  await trigger.click();
  await page.getByLabel("General feedback", { exact: true }).check();
  await page.getByLabel("Feedback", { exact: true }).fill("Text only");
  await page.getByRole("button", { name: "Submit", exact: true }).click();
  await toast.waitFor();
  await dialog.waitFor({ state: "hidden" });
  assert.equal(uploads, 0);
  assert.equal(
    await trigger.evaluate((element) => element === document.activeElement),
    true,
    "Submission restores focus",
  );
  await toast.waitFor({ state: "hidden", timeout: 7000 });
  await page.getByRole("button", { name: "Send feedback", exact: true }).click();
  await page.getByLabel("Something’s broken", { exact: true }).check();
  await page.getByLabel("Feedback", { exact: true }).fill("Screenshot issue");
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
    "base64",
  );
  await page
    .locator('input[type="file"]')
    .setInputFiles({ name: "picked.png", mimeType: "image/png", buffer: png });
  await page.getByRole("img", { name: "picked.png" }).waitFor();
  await page.getByLabel("Feedback", { exact: true }).evaluate(
    (element, bytes) => {
      const clipboardData = new DataTransfer();
      clipboardData.items.add(
        new File([new Uint8Array(bytes)], "pasted.png", { type: "image/png" }),
      );
      element.dispatchEvent(
        new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true }),
      );
    },
    [...png],
  );
  await page.getByRole("img", { name: "pasted.png" }).waitFor();
  await page.getByRole("button", { name: "Remove picked.png" }).click();
  assert.equal(await page.getByRole("img").count(), 1);
  await page.getByRole("button", { name: "Submit", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: "Upload failed for test" }).waitFor();
  assert.equal(await page.getByLabel("Feedback", { exact: true }).inputValue(), "Screenshot issue");
  assert.equal(await page.getByRole("img").count(), 1);
  failUpload = false;
  await page.evaluate(() => {
    window.rejectAnalytics = true;
  });
  await page.getByRole("button", { name: "Submit", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: "Could not send feedback" }).waitFor();
  await page.evaluate(() => {
    window.rejectAnalytics = false;
  });
  await page.getByRole("button", { name: "Submit", exact: true }).click();
  await toast.waitFor();
  await dialog.waitFor({ state: "hidden" });
  assert.equal(uploads, 3);
  assert.equal(new Set(ids).size, 1, "Retries retain the upload ID");
  const sent = await page.evaluate(() =>
    window.events.filter((item) => item.event === "survey sent").at(-1),
  );
  assert.match(
    sent.properties.$survey_questions[1].response,
    /Screenshot issue\n\nImages:\nhttps:\/\/app.example/,
  );
  assert.equal(sent.properties.feedback_attachment_urls.length, 1);
  assert.deepEqual(errors, []);
  console.log(
    "PASS: feedback/upgrade backdrop dismissal, padding and drag guards, pending checkout dismissal guards, shortcut, editable-field and dialog guards, minimised trigger, shared command, draft retention, automatic dialog close, toast expiry, focus restoration; text-only feedback, picker, screenshot paste, removal, upload failure, analytics failure, retry and survey attachment links",
  );
} finally {
  await browser?.close();
  server.stop(true);
  await rm(fixture, { recursive: true, force: true });
}
