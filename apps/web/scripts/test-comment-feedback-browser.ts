import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { chromium } from "playwright";
import tailwindcss from "@tailwindcss/postcss";
import { commentMutationSchema, type CommentThread } from "@tidy/editor/design/comment-contract";

const root = resolve(import.meta.dirname, "..");
const fixture = resolve(root, ".artifacts/comment-feedback");
await mkdir(fixture, { recursive: true });
await Bun.write(
  `${fixture}/entry.tsx`,
  `
import React, {useRef, useState} from "react";
import {createRoot} from "react-dom/client";
import {CanvasComments} from "../../../../packages/editor/src/editor/canvas-comments";
function Fixture() {
  const viewport = useRef(null);
  const [notificationRoot, setNotificationRoot] = useState(null);
  return <div ref={viewport} style={{position:"relative",height:"100vh"}}>
    <CanvasComments fileId="file" view={{zoom:1,x:0,y:0}} viewport={viewport} notificationRoot={notificationRoot}/>
    <div ref={setNotificationRoot} className="pointer-events-none absolute bottom-4 right-4 z-40 w-80 max-w-[calc(100%-2rem)]"/>
  </div>;
}
createRoot(document.getElementById("root")).render(<Fixture/>);
`,
);
const build = await Bun.build({
  entrypoints: [`${fixture}/entry.tsx`],
  target: "browser",
  outdir: fixture,
});
assert.ok(build.success, String(build.logs));
const postcss = createRequire(import.meta.resolve("@tailwindcss/postcss"))("postcss");
const stylesheet = await postcss([tailwindcss({ base: root })]).process(
  await Bun.file(resolve(root, "app/globals.css")).text(),
  { from: resolve(root, "app/globals.css") },
);
const thread: CommentThread = {
  id: crypto.randomUUID(),
  pageId: "page-1",
  x: 120,
  y: 120,
  createdBy: "viewer",
  resolved: false,
  messages: [
    {
      id: crypto.randomUUID(),
      authorId: "viewer",
      authorName: "Morgan",
      authorImage: null,
      body: "Could we give this a little more space?",
      createdAt: new Date().toISOString(),
      reactions: [],
    },
  ],
};
let hold: Promise<void> | null = null;
let release: (() => void) | undefined;
let fail = false;
const mutations: boolean[] = [];
const preview = process.argv.includes("--preview");
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: preview ? 4388 : 0,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/entry.js") return new Response(Bun.file(`${fixture}/entry.js`));
    if (url.pathname === "/styles.css")
      return new Response(stylesheet.css, { headers: { "Content-Type": "text/css" } });
    if (url.pathname.startsWith("/assets/"))
      return new Response(
        Bun.file(resolve(root, "../../packages/editor/src", url.pathname.slice(1))),
      );
    if (url.pathname.startsWith("/api/")) {
      if (request.method === "GET")
        return Response.json({
          threads: [thread],
          viewerId: "viewer",
          viewer: { name: "Morgan", image: null },
          reactionsAvailable: true,
          canModerateThreads: true,
        });
      const input = commentMutationSchema.parse(await request.json());
      if (input.action === "resolve") mutations.push(input.resolved);
      if (hold) await hold;
      if (preview) await Bun.sleep(1500);
      if (fail) return Response.json({ error: "Could not update comment" }, { status: 500 });
      if (input.action === "resolve") thread.resolved = input.resolved;
      if (input.action === "reply") {
        const message = {
          ...thread.messages[0],
          id: input.messageId ?? crypto.randomUUID(),
          body: input.body,
        };
        thread.messages.push(message);
        return Response.json({ message });
      }
      return Response.json({});
    }
    return new Response(
      `<!doctype html><html data-theme="light"><head><link rel="stylesheet" href="/styles.css"></head>
    <body style="margin:0;font-family:Inter,system-ui,sans-serif;background:var(--color-canvas,#f6f6f6)"><div id="root"></div><script type="module" src="/entry.js"></script></body></html>`,
      { headers: { "Content-Type": "text/html" } },
    );
  },
});
if (preview) {
  console.log(`Comment feedback preview: ${server.url}`);
  await new Promise(() => {});
}
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url.href);
  const pin = page.getByRole("button", { name: "Open comment by Morgan", exact: true });
  const popup = page.getByRole("region", { name: "Comment thread", exact: true });
  const undo = page.getByRole("button", { name: "Undo", exact: true });
  const resolveButton = popup.getByRole("button", { name: "Resolve", exact: true });
  async function settle() {
    await page.evaluate(
      () =>
        new Promise<void>((done) =>
          requestAnimationFrame(() => requestAnimationFrame(() => done())),
        ),
    );
  }
  async function waitFor(check: () => boolean) {
    for (let i = 0; i < 100; i++) {
      if (check()) return;
      await Bun.sleep(20);
    }
    assert.fail("Condition did not settle");
  }
  await pin.click();
  hold = new Promise((done) => {
    release = done;
  });
  await page.getByLabel("Write a reply").fill("Looks good to me");
  await popup.getByRole("button", { name: "Post", exact: true }).click();
  await popup.getByText("Looks good to me", { exact: true }).waitFor();
  await Bun.sleep(1200);
  assert.equal(await popup.getByText("Sending…", { exact: true }).count(), 0);
  assert.equal(await popup.getByRole("status").count(), 0);
  release?.();
  hold = null;
  await resolveButton.waitFor({ state: "visible" });
  await waitFor(() => thread.messages.length === 2);
  await settle();
  hold = new Promise((done) => {
    release = done;
  });
  await resolveButton.click();
  await undo.waitFor();
  assert.equal(await pin.count(), 0);
  await undo.click();
  await pin.waitFor();
  assert.deepEqual(mutations, [true]);
  release?.();
  hold = null;
  await waitFor(() => mutations.length === 2 && !thread.resolved);
  await pin.click();
  await page.getByLabel("Write a reply").fill("Keep this draft");
  await settle();
  assert.equal(await page.getByLabel("Write a reply").inputValue(), "Keep this draft");
  await resolveButton.click();
  await undo.waitFor();
  await waitFor(() => thread.resolved);
  await settle();
  await undo.click();
  await pin.waitFor();
  await waitFor(() => !thread.resolved);
  await pin.click();
  await settle();
  fail = true;
  await resolveButton.click();
  await popup.getByRole("alert").waitFor();
  assert.equal(await undo.count(), 0);
  assert.equal(thread.resolved, false);
  fail = false;
  await resolveButton.click();
  await undo.waitFor();
  await page.screenshot({ path: resolve(fixture, "resolved-light.png") });
  await page.evaluate(() => (document.documentElement.dataset.theme = "dark"));
  await page.screenshot({ path: resolve(fixture, "resolved-dark.png") });
  await page.setViewportSize({ width: 360, height: 640 });
  const bounds = await page.getByRole("status").boundingBox();
  assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= 360);
  await page.screenshot({ path: resolve(fixture, "resolved-mobile.png") });
  await undo.focus();
  await Bun.sleep(6200);
  assert.equal(await undo.count(), 1, "Keyboard focus keeps Undo available");
  fail = true;
  await undo.click();
  await page.getByRole("alert").waitFor();
  await waitFor(() => thread.resolved);
  assert.equal(await pin.count(), 0, "Failed Undo restores the resolved state");
  fail = false;
  thread.resolved = false;
  await page.reload();
  await pin.click();
  hold = new Promise((done) => {
    release = done;
  });
  await resolveButton.click();
  await undo.waitFor();
  fail = true;
  await undo.click();
  await pin.waitFor();
  await pin.click();
  await page.getByLabel("Write a reply").fill("Draft during undo");
  release?.();
  hold = null;
  await popup.getByRole("alert").waitFor();
  assert.equal(await page.getByLabel("Write a reply").inputValue(), "Draft during undo");
  assert.equal(thread.resolved, false, "Failed resolve needs no compensating request");
  fail = false;
  await resolveButton.click();
  await undo.waitFor();
  await page.mouse.move(0, 0);
  await undo.waitFor({ state: "hidden", timeout: 8000 });
  await waitFor(() => thread.resolved);
  thread.resolved = false;
  await page.reload();
  await pin.click();
  await resolveButton.click();
  await undo.waitFor();
  await page.getByRole("button", { name: "Dismiss notification" }).click();
  assert.equal(await undo.count(), 0);
  assert.deepEqual(errors, []);
  console.log(
    "PASS: instant posting, pending and acknowledged Undo, failure rollback, draft preservation, focus pause, timeout, dismissal, and narrow viewport",
  );
} finally {
  await browser.close();
  server.stop(true);
  await rm(`${fixture}/entry.tsx`, { force: true });
  await rm(`${fixture}/entry.js`, { force: true });
}
