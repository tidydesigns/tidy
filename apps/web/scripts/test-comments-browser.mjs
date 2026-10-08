// Real Chromium interactions with mocked comment services; authorization is tested in Postgres.
import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { createRequire } from "node:module";
import { chromium } from "playwright";
import tailwindcss from "@tailwindcss/postcss";
const postcss = createRequire(import.meta.resolve("@tailwindcss/postcss"))("postcss");
const root = resolve(import.meta.dirname, "..");
const fixture = resolve(root, ".artifacts/comments-browser");
await mkdir(fixture, { recursive: true });
await Bun.write(
  `${fixture}/entry.tsx`,
  `
import React, { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { CanvasComments, type CanvasCommentsHandle } from "../../app/files/[uid]/canvas-comments";
import { CanvasViewMenu } from "../../app/files/[uid]/canvas-view-menu";
function Fixture() {
  const viewport = useRef<HTMLDivElement>(null);
  const comments = useRef<CanvasCommentsHandle>(null);
  const [version, setVersion] = useState(0);
  const [percent, setPercent] = useState(10);
  const [showComments, setShowComments] = useState(true);
  const preferences = {centerSelection:false,numberKeys:false,invertZoom:false,rightClickPan:false,pixelGrid:false,snapPixels:true,snapObjects:true,guides:false,deepSelection:true,comments:showComments};
  const viewMenu = <CanvasViewMenu percent={percent} hasSelection={false} preferences={preferences} nudgeStep={10} onNudgeStep={() => {}} onToggle={key => { if (key === "comments") setShowComments(value => !value); }} onZoom={action => setPercent(value => action === "in" ? value + 10 : value - 10)} />;
  return <><button onClick={() => setVersion(value => value + 1)}>Refresh comments</button>
    <button onClick={() => comments.current?.place(100, 100)}>New comment</button>
    <div ref={viewport} data-testid="viewport" className="bg-canvas text-primary-black" style={{position:"relative",width:"100%",maxWidth:1000,height:700}}>
      <div hidden={!showComments}><CanvasComments ref={comments} fileId="file" pageId="page-1" view={{zoom:1,x:0,y:0}} viewport={viewport} liveVersion={version} toolbarControls={viewMenu} /></div>
      {!showComments && <div className="absolute right-4 top-4">{viewMenu}</div>}
    </div></>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);`,
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
function thread(id, authorId, authorName, resolved = false, pageId = "page-1") {
  return {
    id,
    createdBy: authorId,
    resolved,
    pageId,
    x: id === "own" ? 80 : 450,
    y: 100,
    messages: [
      {
        id: `${id}-message`,
        authorId,
        authorName,
        authorImage: null,
        body: `${authorName} feedback`,
        createdAt: "2026-10-02T12:00:00Z",
        reactions: [],
      },
    ],
  };
}
let threads = [
  thread("own", "viewer", "Viewer"),
  thread("other", "owner", "Owner"),
  thread("past", "owner", "Past", true),
  thread("page2", "owner", "Other page", false, "page-2"),
];
let canModerateThreads = false,
  gate = null,
  statusStarted = false,
  failStatus = false;
let statusCalls = 0,
  deleteCalls = 0,
  reactionCalls = 0,
  paginated = false;
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/entry.js") return new Response(Bun.file(`${fixture}/entry.js`));
    if (path === "/styles.css")
      return new Response(stylesheet.css, { headers: { "Content-Type": "text/css" } });
    if (path === "/api/files/file/comments" && request.method === "GET") {
      if (!paginated)
        return Response.json({
          threads,
          viewerId: "viewer",
          reactionsAvailable: true,
          canModerateThreads,
        });
      const query = new URL(request.url).searchParams;
      const selected = threads.filter(
        (thread) =>
          thread.pageId === query.get("pageId") &&
          (!query.get("threadId") || thread.id === query.get("threadId")),
      );
      const flat = selected.flatMap((thread) =>
        thread.messages.map((message) => ({ thread, message })),
      );
      const start = query.get("threadId")
        ? Math.max(0, flat.length - 100)
        : Number(query.get("cursor") ?? 0);
      const rows = flat.slice(start, start + 100),
        result = new Map();
      for (const { thread, message } of rows) {
        const value = result.get(thread.id) ?? { ...thread, messages: [] };
        value.messages.push(message);
        result.set(thread.id, value);
      }
      return Response.json({
        threads: [...result.values()],
        viewerId: "viewer",
        reactionsAvailable: true,
        canModerateThreads,
        nextCursor: start + 100 < flat.length ? String(start + 100) : null,
      });
    }
    if (path === "/api/files/file/comments" && request.method === "POST") {
      const input = await request.json();
      if (input.action === "reply" && paginated) {
        threads = threads.map((thread) =>
          thread.id !== input.threadId
            ? thread
            : {
                ...thread,
                messages: [
                  ...thread.messages,
                  {
                    ...thread.messages[0],
                    id: crypto.randomUUID(),
                    body: input.body,
                    createdAt: new Date().toISOString(),
                  },
                ],
              },
        );
      }
      if (input.action === "resolve") {
        statusCalls++;
        statusStarted = true;
        if (gate) await gate;
        if (failStatus) {
          failStatus = false;
          return Response.json({ error: "Status change failed" });
        }
        threads = threads.map((thread) =>
          thread.id === input.threadId ? { ...thread, resolved: input.resolved } : thread,
        );
      } else if (input.action === "delete") {
        deleteCalls++;
        threads = threads.filter((thread) => thread.id !== input.threadId);
      }
      if (input.action === "react") {
        reactionCalls++;
        threads = threads.map((thread) => ({
          ...thread,
          messages: thread.messages.map((message) =>
            message.id !== input.messageId
              ? message
              : {
                  ...message,
                  reactions: message.reactions.length
                    ? []
                    : [{ emoji: input.emoji, count: 1, reacted: true }],
                },
          ),
        }));
      }
      return Response.json({});
    }
    return new Response(
      `<!doctype html><html><head><link rel="stylesheet" href="/styles.css"><style>
    body {font-family:sans-serif;margin:8px} button{cursor:pointer}
  </style></head><body><div id="root"></div><script type="module" src="/entry.js"></script></body></html>`,
      { headers: { "Content-Type": "text/html" } },
    );
  },
});
let browser, release;
async function until(check) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail("Condition did not become true");
}
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url.href);
  const ownPin = page.getByRole("button", { name: "Open comment by Viewer", exact: true });
  const ownerPin = page.getByRole("button", { name: "Open comment by Owner", exact: true });
  const popup = page.getByRole("region", { name: "Comment thread", exact: true });
  await ownPin.waitFor();
  const commentsButton = page.getByRole("button", { name: "Comments (3)", exact: true });
  const zoomButton = page.getByRole("button", { name: "Zoom 10%", exact: true });
  const list = page.getByRole("region", { name: "Comments", exact: true });
  // Opening the panel must not move either control, including on narrow canvases.
  for (const width of [1280, 360]) {
    await page.setViewportSize({ width, height: 900 });
    const commentsBox = await commentsButton.boundingBox();
    const zoomBox = await zoomButton.boundingBox();
    assert.ok(
      commentsBox.x + commentsBox.width + 8 <= zoomBox.x,
      "Comments and zoom do not overlap",
    );
    assert.equal(commentsBox.y, zoomBox.y);
    assert.equal(commentsBox.height, zoomBox.height);
    assert.equal(
      await page.getByTestId("viewport").evaluate((element) => {
        const box = element.getBoundingClientRect();
        return document.elementFromPoint(box.x + 20, box.y + 20) === element;
      }),
      true,
      "The empty toolbar area remains available for canvas gestures",
    );
    await commentsButton.click();
    assert.deepEqual(
      await commentsButton.boundingBox(),
      commentsBox,
      "Expanding comments leaves the button in place",
    );
    assert.deepEqual(
      await zoomButton.boundingBox(),
      zoomBox,
      "Expanding comments leaves zoom in place",
    );
    const panelBox = await list.boundingBox();
    const canvasBox = await page.getByTestId("viewport").boundingBox();
    assert.ok(panelBox.y >= zoomBox.y + zoomBox.height + 8);
    assert.ok(
      panelBox.x >= canvasBox.x && panelBox.x + panelBox.width <= canvasBox.x + canvasBox.width,
    );
    assert.equal(await list.locator("select").count(), 0, "Status uses the custom dropdown");
    await list.getByRole("button", { name: "Comment status: Open (2)", exact: true }).click();
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await list.getByText("Past feedback", { exact: true }).waitFor();
    await list.getByRole("button", { name: "Comment status: Resolved (1)", exact: true }).click();
    await page.keyboard.press("Escape");
    assert.equal(await list.getByRole("menu").count(), 0, "Escape dismisses the custom dropdown");
    await list.getByRole("button", { name: "Comment status: Resolved (1)", exact: true }).click();
    await page.getByRole("menuitemradio", { name: "Open (2)", exact: true }).click();
    await commentsButton.click();
  }
  await zoomButton.click();
  await page.getByRole("menuitem", { name: "Zoom in", exact: false }).click();
  await page.getByRole("button", { name: "Zoom 20%", exact: true }).click();
  await page.getByRole("menuitem", { name: "Zoom out", exact: false }).click();
  await zoomButton.waitFor();
  await zoomButton.click();
  await page.getByRole("menuitemcheckbox", { name: "Show comments", exact: false }).click();
  await commentsButton.waitFor({ state: "hidden" });
  assert.equal(await zoomButton.count(), 1, "Zoom stays available when comments are hidden");
  await zoomButton.click();
  await page.getByRole("menuitemcheckbox", { name: "Show comments", exact: false }).click();
  await commentsButton.waitFor();
  await page.setViewportSize({ width: 1280, height: 900 });
  assert.equal(
    await page.getByRole("button", { name: "Open comment by Past" }).count(),
    0,
    "Resolved pins stay hidden",
  );
  assert.equal(await page.getByRole("button", { name: "Open comment by Other page" }).count(), 0);
  await ownerPin.click();
  assert.equal(
    await popup.getByRole("button", { name: "Resolve", exact: true }).count(),
    0,
    "Other viewers cannot moderate",
  );
  await popup.getByRole("button", { name: "Add emoji reaction" }).click();
  await popup.getByRole("button", { name: "React with 👍", exact: true }).click();
  const reaction = popup.getByRole("button", { name: "👍 reaction, 1, remove yours", exact: true });
  await reaction.waitFor();
  await until(async () => reactionCalls === 1 && (await reaction.isEnabled()));
  await reaction.click();
  await reaction.waitFor({ state: "hidden" });
  await until(() => reactionCalls === 2);
  await popup.getByRole("button", { name: "Close comments" }).click();
  await ownPin.click();
  await popup.getByRole("button", { name: "Resolve", exact: true }).click();
  await ownPin.waitFor({ state: "hidden" });
  await until(() => statusCalls === 1 && threads.find((thread) => thread.id === "own").resolved);
  await page.getByRole("button", { name: "Comments (3)", exact: true }).click();
  await list.getByRole("button", { name: /^Comment status:/ }).click();
  await page.getByRole("menuitemradio", { name: /^Resolved/ }).click();
  await list.getByRole("button").filter({ hasText: "Viewer feedback" }).click();
  await popup.getByText("Viewer feedback", { exact: true }).waitFor();
  await popup.getByRole("button", { name: "Reopen", exact: true }).click();
  await ownPin.waitFor();
  await ownPin.click();
  await popup.getByRole("button", { name: "Thread options" }).click();
  await popup.getByRole("button", { name: "Delete thread", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Delete thread?", exact: true });
  await dialog.waitFor();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  assert.equal(deleteCalls, 0, "Cancel preserves the thread and replies");
  assert.equal(await ownPin.count(), 1);
  // Owners/editors can moderate someone else's thread; all deletions ask for confirmation.
  canModerateThreads = true;
  await page.getByRole("button", { name: "Refresh comments" }).click();
  await ownerPin.click();
  await popup.getByRole("button", { name: "Resolve", exact: true }).waitFor();
  await popup.getByRole("button", { name: "Thread options" }).click();
  await popup.getByRole("button", { name: "Delete thread", exact: true }).click();
  await dialog.getByRole("button", { name: "Delete thread", exact: true }).click();
  await ownerPin.waitFor({ state: "hidden" });
  await until(() => deleteCalls === 1);
  // A delayed acknowledgment and live refresh cannot resurrect a pin or wipe the next draft.
  gate = new Promise((resolve) => {
    release = resolve;
  });
  statusStarted = false;
  await ownPin.click();
  await popup.getByRole("button", { name: "Resolve", exact: true }).click();
  await until(() => statusStarted);
  await page.getByRole("button", { name: "New comment", exact: true }).click();
  await page.getByLabel("Write a comment").fill("Next comment draft");
  await page.getByRole("button", { name: "Refresh comments" }).click();
  await until(async () => (await ownPin.count()) === 0);
  release();
  gate = null;
  await until(() => threads.find((thread) => thread.id === "own").resolved);
  await page.getByRole("button", { name: "Refresh comments" }).click();
  assert.equal(await page.getByLabel("Write a comment").inputValue(), "Next comment draft");
  await popup.getByRole("button", { name: "Close comments" }).click();
  // Failed mutations roll back the affected thread and surface an error.
  await page.getByRole("button", { name: "Comments (2)", exact: true }).click();
  await list.getByRole("button", { name: /^Comment status:/ }).click();
  await page.getByRole("menuitemradio", { name: /^Resolved/ }).click();
  await list.getByRole("button").filter({ hasText: "Viewer feedback" }).click();
  failStatus = true;
  await popup.getByRole("button", { name: "Reopen", exact: true }).click();
  await popup.getByRole("alert").filter({ hasText: "Status change failed" }).waitFor();
  assert.equal(await ownPin.count(), 0);
  assert.equal(await popup.getByRole("button", { name: "Reopen", exact: true }).count(), 1);
  await popup.getByRole("button", { name: "Close comments" }).click();
  threads = [];
  await page.getByRole("button", { name: "Refresh comments" }).click();
  await page.getByRole("button", { name: /^Comments \(/ }).waitFor({ state: "hidden" });
  assert.equal(await zoomButton.count(), 1, "Zoom stays available when the page has no comments");
  paginated = true;
  const history = thread("own", "viewer", "Viewer");
  history.messages = Array.from({ length: 120 }, (_, index) => ({
    ...history.messages[0],
    id: `message-${index}`,
    body: `Message ${index}`,
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, 0, index)).toISOString(),
  }));
  threads = [history];
  await page.reload();
  await ownPin.waitFor();
  await page.getByRole("button", { name: "Comments (1+)", exact: true }).click();
  await list.getByRole("button", { name: "More comments", exact: true }).click();
  await list
    .getByRole("button", { name: "More comments", exact: true })
    .waitFor({ state: "hidden" });
  await ownPin.click();
  assert.equal(
    await popup.getByText(/^Message \d+$/).count(),
    120,
    "pages merge without duplicated messages",
  );
  threads[0].messages[0].body = "Old message updated";
  await page.getByRole("button", { name: "Refresh comments" }).click();
  await popup.getByText("Old message updated", { exact: true }).waitFor();
  // With only the first page loaded, a new reply still appears via the bounded detail read.
  await page.reload();
  await ownPin.waitFor();
  await ownPin.click();
  await page.getByLabel("Write a reply").fill("Newest reply");
  await popup.getByRole("button", { name: "Post", exact: true }).click();
  await popup.getByText("Newest reply", { exact: true }).waitFor();
  assert.equal(await popup.getByText("Newest reply", { exact: true }).count(), 1);
  assert.deepEqual(errors, []);
  console.log(
    "Comment browser checks passed: responsive toolbar layout, custom dropdown keyboard interaction, zoom, visibility, filtering, viewer reactions, author/moderator controls, confirmation, rollback, draft persistence, paginated history and newest-reply recovery.",
  );
} finally {
  release?.();
  await browser?.close();
  server.stop(true);
  await rm(fixture, { recursive: true, force: true });
}
