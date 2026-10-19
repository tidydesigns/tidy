// Isolated browser regression for the real component; no database or account is used.
import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { chromium } from "playwright";
import tailwindcss from "@tailwindcss/postcss";
import { commentMutationSchema, type CommentThread } from "../lib/design/comment-contract";

const postcss = createRequire(import.meta.resolve("@tailwindcss/postcss"))("postcss");
const root = resolve(import.meta.dirname, "..");
const fixture = resolve(
  root,
  process.argv.includes("--preview")
    ? ".artifacts/comment-picker-preview"
    : ".artifacts/comment-picker-browser",
);
await mkdir(fixture, { recursive: true });
await Bun.write(
  `${fixture}/entry.tsx`,
  `import React, {useRef, useState} from "react";
import {createRoot} from "react-dom/client";
import {CanvasComments, type CanvasCommentsHandle} from "../../app/files/[uid]/canvas-comments";
function Fixture() {
  const viewport = useRef<HTMLDivElement>(null);
  const comments = useRef<CanvasCommentsHandle>(null);
  const [version, setVersion] = useState(0);
  return <><button onClick={() => comments.current?.place(100,100)}>New comment</button>
    <button onClick={() => setVersion(value => value + 1)}>Refresh comments</button>
    <div ref={viewport} style={{position:"relative",width:"100%",maxWidth:900,height:"calc(100dvh - 48px)"}}>
      <CanvasComments ref={comments} fileId="file" view={{zoom:1,x:0,y:0}} viewport={viewport} liveVersion={version} notificationRoot={null}/>
    </div></>;
}
createRoot(document.getElementById("root")!).render(<Fixture/>);`,
);
const build = await Bun.build({
  entrypoints: [`${fixture}/entry.tsx`],
  target: "browser",
  outdir: fixture,
});
assert.ok(build.success, String(build.logs));
const stylesheet = await postcss([tailwindcss({ base: root })]).process(
  await Bun.file(resolve(root, "app/globals.css")).text(),
  { from: resolve(root, "app/globals.css") },
);
const firstMessage: CommentThread["messages"][number] = {
  id: crypto.randomUUID(),
  authorId: "viewer",
  authorName: "Viewer",
  authorImage: null,
  body: "Check the spacing here",
  createdAt: new Date().toISOString(),
  reactions: [],
};
const threads: CommentThread[] = [
  {
    id: crypto.randomUUID(),
    pageId: "page-1",
    x: 40,
    y: 40,
    createdBy: "viewer",
    resolved: false,
    messages: [firstMessage],
  },
];
const preview = process.argv.includes("--preview");
let posts = 0;
let reads = 0;
let failReads = false;
let failReaction = false;
let reactionPostGate: Promise<void> | null = null;
let readGate: Promise<void> | null = null;
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: preview ? 4390 : 0,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/entry.js") return new Response(Bun.file(`${fixture}/entry.js`));
    if (url.pathname === "/styles.css")
      return new Response(stylesheet.css, { headers: { "Content-Type": "text/css" } });
    if (url.pathname.startsWith("/icons/"))
      return new Response(Bun.file(resolve(root, "public", url.pathname.slice(1))));
    if (url.pathname === "/api/files/file/comments") {
      if (request.method === "GET") {
        reads++;
        if (failReads) return Response.json({ error: "Read unavailable" }, { status: 503 });
        const snapshot = structuredClone(
          threads.filter(
            (thread) =>
              !url.searchParams.has("threadId") || thread.id === url.searchParams.get("threadId"),
          ),
        );
        if (readGate) await readGate;
        if (preview) await Bun.sleep(500);
        return Response.json({
          threads: snapshot,
          viewerId: "viewer",
          viewer: { name: "Viewer", image: null },
          reactionsAvailable: true,
          canModerateThreads: true,
        });
      }
      const input = commentMutationSchema.parse(await request.json());
      posts++;
      if (preview) await Bun.sleep(1500);
      if (input.action === "create" || input.action === "reply") {
        const message = {
          id: input.messageId ?? crypto.randomUUID(),
          authorId: "viewer",
          authorName: "Viewer",
          authorImage: null,
          body: input.body,
          createdAt: new Date().toISOString(),
          reactions: [],
        };
        if (input.action === "create") {
          const existing = threads.find((thread) => thread.id === input.threadId);
          if (existing) return Response.json({ id: existing.id, message: existing.messages[0] });
          const thread = {
            id: input.threadId ?? crypto.randomUUID(),
            pageId: input.pageId,
            x: input.x,
            y: input.y,
            createdBy: "viewer",
            resolved: false,
            messages: [message],
          };
          threads.push(thread);
          return Response.json({ id: thread.id, message });
        }
        const thread = threads.find((thread) => thread.id === input.threadId);
        if (!thread) return Response.json({ error: "Thread not found" }, { status: 409 });
        const existing = thread.messages.find((item) => item.id === message.id);
        if (!existing) thread.messages.push(message);
        return Response.json({ message: existing ?? message });
      }
      if (input.action === "react") {
        if (reactionPostGate) await reactionPostGate;
        if (failReaction)
          return Response.json({ error: "Reaction limit reached" }, { status: 409 });
        const message = threads[0].messages.find((message) => message.id === input.messageId);
        if (!message) return Response.json({ error: "Comment not found" }, { status: 404 });
        message.reactions = message.reactions.some((reaction) => reaction.emoji === input.emoji)
          ? message.reactions.filter((reaction) => reaction.emoji !== input.emoji)
          : [...message.reactions, { emoji: input.emoji, count: 1, reacted: true }];
      }
      return Response.json({});
    }
    return new Response(
      `<!doctype html><html><head><link rel="stylesheet" href="/styles.css"></head>
      <body style="font-family:sans-serif"><div id="root"></div><script type="module" src="/entry.js"></script></body></html>`,
      { headers: { "Content-Type": "text/html" } },
    );
  },
});
if (preview) {
  console.log(`Reaction picker usability preview: ${server.url.href}`);
  await new Promise(() => {});
}
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const popup = page.getByRole("region", { name: "Comment thread", exact: true });
  const reply = page.getByLabel("Write a reply");
  const picker = page.getByRole("menu", { name: "Add emoji reaction", exact: true });
  const triggers = popup.getByRole("button", { name: "Add emoji reaction", exact: true });
  async function until(check: () => boolean | Promise<boolean>) {
    for (let i = 0; i < 100; i++) {
      if (await check()) return;
      await Bun.sleep(20);
    }
    assert.fail("Condition did not become true");
  }
  async function load(count: number) {
    threads[0].messages = Array.from({ length: count }, (_, index) => ({
      ...firstMessage,
      id: crypto.randomUUID(),
      body: index === 0 ? firstMessage.body : `Review note ${index}`,
      reactions: [],
    }));
    await page.goto(server.url.href);
    await page.getByRole("button", { name: "Open comment by Viewer", exact: true }).click();
    await reply.fill("Keep this reply draft");
  }
  let layouts = 0;
  for (const [width, height] of [
    [1280, 800],
    [539, 795],
    [360, 640],
    [320, 480],
    [640, 320],
  ]) {
    await page.setViewportSize({ width, height });
    for (const count of [1, 12]) {
      await load(count);
      const trigger = triggers.last();
      await trigger.scrollIntoViewIfNeeded();
      const before = await reply.boundingBox();
      const scrollBefore = await popup
        .locator("div.min-h-0.space-y-3")
        .evaluate((element) => element.scrollTop);
      await trigger.click();
      await picker.waitFor();
      assert.deepEqual(
        await reply.boundingBox(),
        before,
        `Picker must not move reply composer (${width}x${height}, ${count} messages)`,
      );
      assert.equal(
        await popup.locator("div.min-h-0.space-y-3").evaluate((element) => element.scrollTop),
        scrollBefore,
        "Opening does not move the message list",
      );
      const menuBox = await picker.boundingBox();
      const triggerBox = await trigger.boundingBox();
      assert.ok(menuBox && triggerBox && before);
      assert.ok(menuBox.y + menuBox.height <= triggerBox.y, "Picker sits above its trigger");
      assert.ok(menuBox.y + menuBox.height <= before.y, "Picker stays above the reply field");
      assert.ok(
        menuBox.x >= 8 && menuBox.x + menuBox.width <= width - 8,
        "Picker stays within horizontal viewport edges",
      );
      assert.ok(
        menuBox.y >= 8 && menuBox.y + menuBox.height <= height - 8,
        "Picker stays within vertical viewport edges",
      );
      assert.equal(await picker.getAttribute("aria-orientation"), "horizontal");
      assert.equal(await picker.getByRole("menuitem").count(), 6);
      assert.equal(
        await picker.getByRole("menuitem").evaluateAll((items) =>
          items.every((item) => {
            const box = item.getBoundingClientRect();
            const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
            return hit !== null && item.contains(hit);
          }),
        ),
        true,
        "Every emoji can be clicked without clipping or scrolling",
      );
      await page.keyboard.press("Escape");
      assert.equal(await picker.count(), 0);
      assert.equal(await trigger.getAttribute("aria-expanded"), "false");
      assert.equal(
        await trigger.evaluate((element) => element === document.activeElement),
        true,
        "Escape returns focus to the trigger",
      );
      assert.equal(await reply.inputValue(), "Keep this reply draft");
      layouts++;
    }
  }
  await page.setViewportSize({ width: 539, height: 795 });
  await load(1);
  const trigger = triggers.first();
  await trigger.focus();
  await page.keyboard.press("ArrowDown");
  const thumbs = picker.getByRole("menuitem", { name: "React with 👍", exact: true });
  await thumbs.waitFor();
  assert.equal(await thumbs.evaluate((element) => element === document.activeElement), true);
  await page.keyboard.press("ArrowRight");
  assert.equal(
    await picker
      .getByRole("menuitem", { name: "React with ❤️", exact: true })
      .evaluate((element) => element === document.activeElement),
    true,
  );
  await page.keyboard.press("End");
  assert.equal(
    await picker
      .getByRole("menuitem", { name: "React with 👀", exact: true })
      .evaluate((element) => element === document.activeElement),
    true,
  );
  await page.keyboard.press("Home");
  await page.keyboard.press("Enter");
  const reaction = popup.getByRole("button", { name: "👍 reaction, 1, remove yours", exact: true });
  await reaction.waitFor();
  await until(async () => posts === 1 && (await reaction.isEnabled()));
  assert.equal(await picker.count(), 0, "Choosing an emoji dismisses the picker");
  assert.equal(await reply.inputValue(), "Keep this reply draft");
  await reaction.click();
  await reaction.waitFor({ state: "hidden" });
  await until(() => posts === 2);
  await trigger.click();
  await reply.click();
  assert.equal(
    await picker.count(),
    0,
    "Clicking the reply field dismisses before starting to type",
  );
  assert.equal(await reply.evaluate((element) => element === document.activeElement), true);
  await trigger.click();
  await trigger.click();
  assert.equal(await picker.count(), 0, "Clicking the trigger again closes the picker");
  await trigger.click();
  await page.mouse.move(5, 5);
  await page.mouse.wheel(0, 100);
  await picker.waitFor({ state: "hidden" });
  assert.equal(
    await trigger.evaluate((element) => element === document.activeElement),
    true,
    "Wheel dismissal returns menu-item focus to its trigger",
  );
  await trigger.click();
  await reply.focus();
  await picker.waitFor();
  await page.mouse.wheel(0, 100);
  await picker.waitFor({ state: "hidden" });
  assert.equal(
    await reply.evaluate((element) => element === document.activeElement),
    true,
    "Wheel dismissal preserves focus moved outside the picker",
  );
  await trigger.click();
  await page.keyboard.press("Tab");
  assert.equal(await picker.count(), 0, "Tab leaves the picker");
  assert.equal(
    await reply.evaluate((element) => element === document.activeElement),
    true,
    "Tab proceeds to the reply field",
  );

  // A successful toggle must survive a failed confirmation read without flickering.
  await load(1);
  failReads = true;
  const beforeFailedRead = posts;
  await triggers.first().click();
  await picker.getByRole("menuitem", { name: "React with 👍", exact: true }).click();
  await until(async () => posts === beforeFailedRead + 1 && (await triggers.first().isEnabled()));
  assert.equal(
    await reaction.count(),
    1,
    "A failed read must not undo a saved optimistic reaction",
  );
  assert.equal(await reaction.evaluate((element) => getComputedStyle(element).opacity), "1");
  assert.equal(await reply.inputValue(), "Keep this reply draft");
  failReads = false;
  const refreshButton = page.getByRole("button", { name: "Refresh comments", exact: true });
  let beforeRead = reads;
  await refreshButton.click();
  await until(() => reads >= beforeRead + 2);
  await reaction.waitFor();
  // Once confirmed, another client's update must replace the local overlay.
  threads[0].messages[0].reactions = [];
  await refreshButton.click();
  await reaction.waitFor({ state: "hidden" });

  // An older read arriving around acknowledgement must never erase the selected emoji.
  let releasePost!: () => void;
  let releaseRead!: () => void;
  reactionPostGate = new Promise<void>((resolve) => {
    releasePost = resolve;
  });
  readGate = new Promise<void>((resolve) => {
    releaseRead = resolve;
  });
  await triggers.first().click();
  await picker.getByRole("menuitem", { name: "React with 👍", exact: true }).click();
  await reaction.waitFor();
  assert.equal(
    await reaction.evaluate((element) => getComputedStyle(element).opacity),
    "1",
    "Pending reactions retain full contrast",
  );
  beforeRead = reads;
  await refreshButton.click();
  await until(() => reads >= beforeRead + 2);
  const staleResponse = page.waitForResponse(
    (response) => response.url().includes("/comments?") && response.ok(),
  );
  releaseRead();
  readGate = null;
  await staleResponse;
  await page.evaluate(() => new Promise(requestAnimationFrame));
  assert.equal(
    await reaction.count(),
    1,
    "A pre-commit snapshot cannot erase the pending reaction",
  );
  readGate = new Promise<void>((resolve) => {
    releaseRead = resolve;
  });
  releasePost();
  reactionPostGate = null;
  await until(async () => await triggers.first().isEnabled());
  assert.equal(await reaction.count(), 1, "Acknowledgement does not wait for the blocked refresh");
  await triggers.first().click();
  await picker.getByRole("menuitem", { name: "React with 👀", exact: true }).click();
  await until(async () => await triggers.first().isEnabled());
  assert.equal(
    await reaction.count(),
    1,
    "A second emoji preserves the first unconfirmed reaction",
  );
  assert.equal(
    await popup.getByRole("button", { name: "👀 reaction, 1, remove yours", exact: true }).count(),
    1,
  );
  releaseRead();
  readGate = null;
  await until(async () => (await reaction.getAttribute("aria-pressed")) === "true");
  assert.equal(await reply.inputValue(), "Keep this reply draft");

  // Failed additions and removals restore the prior reaction and leave the composer usable.
  failReaction = true;
  reactionPostGate = new Promise<void>((resolve) => {
    releasePost = resolve;
  });
  await reaction.click();
  await reaction.waitFor({ state: "hidden" });
  await reply.fill("Draft typed while reaction failed");
  releasePost();
  reactionPostGate = null;
  await popup.getByRole("alert").filter({ hasText: "Reaction limit reached" }).waitFor();
  await reaction.waitFor();
  await until(async () => await reaction.isEnabled());
  const beforeFailure = posts;
  await triggers.first().click();
  await picker.getByRole("menuitem", { name: "React with ❤️", exact: true }).click();
  await until(async () => posts === beforeFailure + 1 && (await triggers.first().isEnabled()));
  assert.equal(
    await popup.getByRole("button", { name: "❤️ reaction, 1, remove yours", exact: true }).count(),
    0,
  );
  assert.equal(await reaction.count(), 1, "Another reaction is not removed on failure");
  assert.equal(await reply.inputValue(), "Draft typed while reaction failed");
  failReaction = false;

  await load(12);
  const scroller = popup.locator("div.min-h-0.space-y-3");
  await triggers.last().scrollIntoViewIfNeeded();
  await triggers.last().click();
  await picker.waitFor();
  await scroller.evaluate((element) => {
    element.scrollTop = 0;
  });
  await picker.waitFor({ state: "hidden" });
  assert.equal(
    await triggers.last().evaluate((element) => element === document.activeElement),
    true,
    "Scroll dismissal returns focus without scrolling its trigger back into view",
  );
  assert.equal(await scroller.evaluate((element) => element.scrollTop), 0);
  await triggers.first().click();
  const oldId = await triggers.first().getAttribute("aria-controls");
  await triggers.nth(1).click();
  assert.equal(await picker.count(), 1, "Only one message's picker can remain open");
  assert.notEqual(await triggers.nth(1).getAttribute("aria-controls"), oldId);
  await popup.getByRole("button", { name: "Close comments" }).click();
  assert.equal(await picker.count(), 0, "Closing the thread removes its picker");

  // The existing list menu retains its keyboard interaction after adding horizontal options.
  await page.getByRole("button", { name: /^Comments/ }).click();
  await page.getByRole("button", { name: /^Comment status:/ }).click();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: "Comment status: Resolved (0)", exact: true }).waitFor();
  assert.deepEqual(errors, []);
  console.log(
    `Reaction picker usability checks passed: ${layouts} short/long-thread layouts, all six choices visible above the composer, no layout/scroll shift, Escape, Tab, arrows, click-away, single picker, scroll dismissal, reaction reconciliation, failed-write rollback and list-menu keyboard regression.`,
  );
} finally {
  await browser.close();
  server.stop(true);
  await rm(fixture, { recursive: true, force: true });
}
