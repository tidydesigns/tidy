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
const fixture = resolve(
  root,
  process.argv.includes("--preview")
    ? ".artifacts/comment-posting-preview"
    : ".artifacts/comment-posting-browser",
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
    <div ref={viewport} style={{position:"relative",width:900,height:700}}>
      <React.Profiler id="comments" onRender={(_id, _phase, duration) => {
        const stats = window as unknown as {commentRenderMs?:number[]};
        (stats.commentRenderMs ??= []).push(duration);
      }}><CanvasComments ref={comments} fileId="file" view={{zoom:1,x:0,y:0}} viewport={viewport} liveVersion={version} notificationRoot={null}/></React.Profiler>
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
const preview = process.argv.includes("--preview");
let posts = 0;
let reads = 0;
let failPost = false;
let legacyResponses = false;
let dropAcknowledgement = false;
let readGate: Promise<void> | null = null;
let postGate: Promise<void> | null = null;
let releaseReads: (() => void) | undefined;
let releasePosts: (() => void) | undefined;
function holdReads() {
  readGate = new Promise<void>((resolve) => {
    releaseReads = resolve;
  });
}
function resumeReads() {
  readGate = null;
  releaseReads?.();
}
function holdPosts() {
  postGate = new Promise<void>((resolve) => {
    releasePosts = resolve;
  });
}
function resumePosts() {
  postGate = null;
  releasePosts?.();
}
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: preview ? 4388 : 0,
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
      const input = (await request.json()) as CommentMutation;
      posts++;
      if (postGate) await postGate;
      if (preview) await Bun.sleep(1500);
      if (failPost) return Response.json({ error: "Post failed" }, { status: 500 });
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
          return Response.json(legacyResponses ? { id: thread.id } : { id: thread.id, message });
        }
        const thread = threads.find((thread) => thread.id === input.threadId);
        if (!thread) return Response.json({ error: "Thread not found" }, { status: 409 });
        const existing = thread.messages.find((item) => item.id === message.id);
        if (!existing) thread.messages.push(message);
        if (dropAcknowledgement)
          return Response.json({ error: "Acknowledgement lost" }, { status: 500 });
        return Response.json(legacyResponses ? {} : { message: existing ?? message });
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
  console.log(`Comment preview with 1.5s POST delay: ${server.url.href}`);
  await new Promise(() => {});
}
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  async function until(check: () => boolean | Promise<boolean>) {
    for (let i = 0; i < 100; i++) {
      if (await check()) return;
      await Bun.sleep(20);
    }
    assert.fail("Condition did not become true");
  }
  await Promise.all([
    page.waitForResponse((response) => response.url().includes("/comments?") && response.ok()),
    page.goto(server.url.href),
  ]);
  const popup = page.getByRole("region", { name: "Comment thread", exact: true });
  const newComment = page.getByRole("button", { name: "New comment", exact: true });
  const refresh = page.getByRole("button", { name: "Refresh comments", exact: true });
  const post = popup.getByRole("button", { name: "Post", exact: true });
  const close = popup.getByRole("button", { name: "Close comments" });
  const reply = page.getByLabel("Write a reply");
  const pin = page.getByRole("button", { name: "Open comment by Viewer", exact: true });
  await newComment.click();
  await page.getByLabel("Write a comment").fill("First comment");
  holdPosts();
  const initialReads = reads;
  const visibleMs = await page.evaluate(async () => {
    const start = performance.now();
    const button = [...document.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Post",
    )!;
    button.click();
    await new Promise(requestAnimationFrame);
    if (
      !document
        .querySelector('[aria-label="Comment thread"]')
        ?.textContent?.includes("First comment")
    )
      throw new Error("Comment did not appear on the next animation frame");
    return performance.now() - start;
  });
  await popup.getByText("First comment", { exact: true }).waitFor();
  assert.equal(await reply.inputValue(), "");
  await reply.fill("Quick reply one");
  await post.click();
  await reply.fill("Quick reply two");
  await post.click();
  assert.equal(
    await popup.getByRole("status").count(),
    3,
    "All sends appear before any POST is released",
  );
  assert.equal(
    posts,
    1,
    "Replies to a new thread wait for its creation, without blocking the composer",
  );
  assert.equal(reads, initialReads, "No post-send GET is needed");
  resumePosts();
  await until(async () => posts === 3 && (await popup.getByRole("status").count()) === 0);
  assert.deepEqual(
    threads[0].messages.map((message) => message.body),
    ["First comment", "Quick reply one", "Quick reply two"],
  );
  assert.equal(reads, initialReads, "Receipts confirm sends without reloading comments");

  // A stale live read must not erase an optimistic reply or duplicate it after acknowledgement.
  holdReads();
  holdPosts();
  const beforeReads = reads;
  await refresh.click();
  await until(() => reads >= beforeReads + 2);
  await reply.fill("Reply during stale refresh");
  await post.click();
  resumeReads();
  await until(
    async () =>
      (await popup.getByText("Reply during stale refresh", { exact: true }).count()) === 1,
  );
  assert.equal(await popup.getByRole("status").count(), 1);
  resumePosts();
  await until(async () => (await popup.getByRole("status").count()) === 0);
  await refresh.click();
  await until(() => reads >= beforeReads + 4);
  assert.equal(await popup.getByText("Reply during stale refresh", { exact: true }).count(), 1);

  // A failed send remains visible and never overwrites text typed after posting.
  holdPosts();
  failPost = true;
  await reply.fill("Failed reply");
  await post.click();
  await reply.fill("My next draft");
  resumePosts();
  await popup.getByRole("alert").filter({ hasText: "Post failed" }).waitFor();
  assert.equal(await reply.inputValue(), "My next draft");
  failPost = false;
  const beforeRetry = posts;
  await popup.getByRole("button", { name: "Retry", exact: true }).click();
  await until(
    async () => posts === beforeRetry + 1 && (await popup.getByRole("alert").count()) === 0,
  );
  assert.equal(await reply.inputValue(), "My next draft");
  assert.equal(threads[0].messages.filter((message) => message.body === "Failed reply").length, 1);

  // Explicit retries reuse IDs even when the server committed but the acknowledgement failed.
  dropAcknowledgement = true;
  await reply.fill("Lost acknowledgement");
  await post.click();
  await popup.getByRole("alert").filter({ hasText: "Acknowledgement lost" }).waitFor();
  dropAcknowledgement = false;
  await popup.getByRole("button", { name: "Retry", exact: true }).click();
  await until(async () => (await popup.getByRole("alert").count()) === 0);
  assert.equal(
    threads[0].messages.filter((message) => message.body === "Lost acknowledgement").length,
    1,
  );

  // Legacy acknowledgements still use a bounded detail read without duplicating local replies.
  legacyResponses = true;
  await reply.fill("Legacy reply");
  await post.click();
  await until(
    async () => reads > initialReads + 4 && (await popup.getByRole("status").count()) === 0,
  );
  await until(async () => (await popup.getByText("Legacy reply", { exact: true }).count()) === 1);
  assert.equal(await popup.getByText("Legacy reply", { exact: true }).count(), 1);
  legacyResponses = false;

  // Long threads scroll to the user's own new reply; typing does not keep rerendering their history.
  const first = threads[0].messages[0];
  threads[0].messages.push(
    ...Array.from({ length: 120 }, (_, index) => ({
      ...first,
      id: crypto.randomUUID(),
      body: `History ${index}`,
      createdAt: new Date(Date.now() + index).toISOString(),
    })),
  );
  await refresh.click();
  await popup.getByText("History 119", { exact: true }).waitFor();
  await page.evaluate(() => {
    (window as unknown as { commentRenderMs: number[] }).commentRenderMs = [];
  });
  await reply.pressSequentially("Typing a reply in a long thread");
  const typingRenderMs = await page.evaluate(() =>
    Math.max(...(window as unknown as { commentRenderMs: number[] }).commentRenderMs),
  );
  assert.ok(typingRenderMs < 100, `Long-thread typing render took ${typingRenderMs}ms`);
  const messageList = popup.locator("div.min-h-0.space-y-3");
  await messageList.evaluate((element) => {
    element.scrollTop = 0;
  });
  holdPosts();
  await reply.fill("Newest visible reply");
  await post.click();
  assert.equal(
    await messageList.evaluate(
      (element) => element.scrollHeight - element.scrollTop - element.clientHeight < 2,
    ),
    true,
  );
  await close.click();
  await newComment.click();
  await page.getByLabel("Write a comment").fill("Next comment draft");
  resumePosts();
  await until(() => threads[0].messages.some((message) => message.body === "Newest visible reply"));
  assert.equal(await page.getByLabel("Write a comment").inputValue(), "Next comment draft");
  await close.click();
  await pin.click();
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
  assert.deepEqual(errors, []);
  console.log(
    `Comment performance checks passed. First visible frame: ${visibleMs.toFixed(1)}ms with POST held; slowest typing render with 120 history messages: ${typingRenderMs.toFixed(1)}ms; no post-send GETs. Burst replies, stale reads, failures, retry deduplication, long-thread scrolling, next-draft preservation and header alignment passed.`,
  );
} finally {
  resumeReads();
  resumePosts();
  await browser.close();
  server.stop(true);
  await rm(fixture, { recursive: true, force: true });
}
