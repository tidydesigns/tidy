// Isolated browser regression for the real component; no database or account is used.
import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { chromium } from "playwright";
import tailwindcss from "@tailwindcss/postcss";
import type { CommentMutation, CommentThread } from "../lib/design/comment-contract";

const postcss = createRequire(import.meta.resolve("@tailwindcss/postcss"))("postcss");
const root = resolve(import.meta.dirname, "..");
const fixture = resolve(root, ".artifacts/comment-posting-browser");
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
    <div ref={viewport} style={{position:"relative",width:900,height:700}}>
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
const threads: CommentThread[] = [];
let posts = 0;
let reads = 0;
let failPost = false;
let failRead = false;
let readGate: Promise<void> | null = null;
let releaseReads: (() => void) | undefined;
function holdReads() {
  readGate = new Promise<void>((resolve) => {
    releaseReads = resolve;
  });
}
function resumeReads() {
  readGate = null;
  releaseReads?.();
}
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
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
        if (readGate) await readGate;
        if (failRead) return Response.json({ error: "Read failed" }, { status: 500 });
        return Response.json({
          threads: threads.filter(
            (thread) =>
              !url.searchParams.has("threadId") || thread.id === url.searchParams.get("threadId"),
          ),
          viewerId: "viewer",
          reactionsAvailable: true,
          canModerateThreads: true,
        });
      }
      const input = (await request.json()) as CommentMutation;
      await Bun.sleep(100);
      posts++;
      if (failPost) return Response.json({ error: "Post failed" }, { status: 500 });
      if (input.action === "create" || input.action === "reply") {
        const message = {
          id: crypto.randomUUID(),
          authorId: "viewer",
          authorName: "Viewer",
          authorImage: null,
          body: input.body,
          createdAt: new Date().toISOString(),
          reactions: [],
        };
        if (input.action === "create") {
          const thread = {
            id: crypto.randomUUID(),
            pageId: input.pageId,
            x: input.x,
            y: input.y,
            createdBy: "viewer",
            resolved: false,
            messages: [message],
          };
          threads.push(thread);
          return Response.json({ id: thread.id });
        }
        threads.find((thread) => thread.id === input.threadId)!.messages.push(message);
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
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url.href);
  await page.waitForResponse((response) => response.url().includes("/comments?") && response.ok());
  const popup = page.getByRole("region", { name: "Comment thread", exact: true });
  const newComment = page.getByRole("button", { name: "New comment", exact: true });
  const refresh = page.getByRole("button", { name: "Refresh comments", exact: true });
  const post = popup.getByRole("button", { name: "Post", exact: true });
  const close = popup.getByRole("button", { name: "Close comments" });
  async function until(check: () => boolean | Promise<boolean>) {
    for (let i = 0; i < 100; i++) {
      if (await check()) return;
      await Bun.sleep(20);
    }
    assert.fail("Condition did not become true");
  }
  await newComment.click();
  await page.getByLabel("Write a comment").fill("First comment");
  // Observe every DOM update, including short gaps between acknowledged POST and GET.
  await page.evaluate(() => {
    const state = window as unknown as { lostPopup: boolean; observer: MutationObserver };
    state.lostPopup = false;
    state.observer = new MutationObserver(() => {
      if (!document.querySelector('[aria-label="Comment thread"]')) state.lostPopup = true;
    });
    state.observer.observe(document.body, { subtree: true, childList: true });
  });
  holdReads();
  await post.click();
  await until(() => posts === 1 && reads >= 3);
  assert.equal(
    await popup.count(),
    1,
    "Acknowledged creation keeps the popup visible while reads wait",
  );
  // A live refresh can supersede the post's read without losing its draft-to-thread handoff.
  const beforeRefresh = reads;
  await refresh.click();
  await until(() => reads >= beforeRefresh + 2);
  resumeReads();
  await popup.getByText("First comment", { exact: true }).waitFor();
  assert.equal(
    await page.evaluate(() => {
      const state = window as unknown as { lostPopup: boolean; observer: MutationObserver };
      state.observer.disconnect();
      return state.lostPopup;
    }),
    false,
    "The popup never disappears during creation",
  );
  await until(async () => await popup.getByRole("button", { name: "Thread options" }).isEnabled());
  // Icons have identical centered hit areas at both desktop and small viewport sizes.
  for (const width of [1280, 360]) {
    await page.setViewportSize({ width, height: 800 });
    const options = await popup.getByRole("button", { name: "Thread options" }).boundingBox();
    const x = await close.boundingBox();
    assert.ok(options && x);
    assert.equal(options.height, 28);
    assert.equal(options.width, 28);
    assert.equal(options.y, x.y);
    assert.equal(options.height, x.height);
  }
  await page.getByLabel("Write a reply").fill("A reply");
  await post.click();
  await popup.getByText("A reply", { exact: true }).waitFor();
  assert.equal(await popup.getByText("A reply", { exact: true }).count(), 1);
  await close.click();
  // Failed posting keeps the input available for an intentional retry.
  await newComment.click();
  await page.getByLabel("Write a comment").fill("Retry me");
  failPost = true;
  await post.click();
  await popup.getByRole("alert").waitFor();
  assert.equal(await page.getByLabel("Write a comment").inputValue(), "Retry me");
  failPost = false;
  // A failed read after a successful POST preserves the popup and recovers on refresh.
  failRead = true;
  await post.click();
  await popup.getByRole("alert").filter({ hasText: "Could not load comments" }).waitFor();
  assert.equal(await popup.count(), 1);
  failRead = false;
  await refresh.click();
  await popup.getByText("Retry me", { exact: true }).waitFor();
  await close.click();
  // Delayed completion must not reopen the old thread or clear a newer draft.
  await newComment.click();
  await page.getByLabel("Write a comment").fill("Older submission");
  holdReads();
  const previousPosts = posts;
  await post.click();
  await until(() => posts === previousPosts + 1);
  await close.click();
  await newComment.click();
  await page.getByLabel("Write a comment").fill("Next draft");
  resumeReads();
  await until(async () => await post.isEnabled());
  assert.equal(await page.getByLabel("Write a comment").inputValue(), "Next draft");
  assert.deepEqual(errors, []);
  console.log(
    "Comment posting browser checks passed: continuous popup, concurrent reads, live-refresh race, reply, post failure, read recovery, newer draft and header alignment.",
  );
} finally {
  resumeReads();
  await browser.close();
  server.stop(true);
  await rm(fixture, { recursive: true, force: true });
}
