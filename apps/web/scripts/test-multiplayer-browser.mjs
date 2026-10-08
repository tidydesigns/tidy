// Run with the local Next and room Workers already running. Fixtures and browser
// sessions are isolated from production; host checks deliberately fail closed.
import assert from "node:assert/strict";
import { readFile, mkdir } from "node:fs/promises";
import { chromium } from "playwright";
import pg from "pg";
import { verifiedTestAccount } from "./fixtures/verified-test-account.mjs";
import { localAcceptanceProxy } from "./fixtures/local-acceptance-proxy.mjs";
const base = process.env.MULTIPLAYER_TEST_BASE_URL ?? "http://localhost:3000";
const connectionString = process.env.MULTIPLAYER_TEST_DATABASE_URL;
if (
  !["localhost", "127.0.0.1"].includes(new URL(base).hostname) ||
  !connectionString ||
  !["localhost", "127.0.0.1"].includes(new URL(connectionString).hostname)
)
  throw new Error(
    "Use a disposable localhost database and local app for multiplayer browser tests.",
  );
const client = new pg.Client({ connectionString });
await client.connect();
const proxy = process.env.MULTIPLAYER_TEST_PROXY_TARGET
  ? await localAcceptanceProxy(base, process.env.MULTIPLAYER_TEST_PROXY_TARGET)
  : null;
const browser = await chromium.launch({ headless: true });
const contexts = await Promise.all([
  browser.newContext({ viewport: { width: 1440, height: 1000 } }),
  browser.newContext({ viewport: { width: 1440, height: 1000 } }),
]);
const errors = [];
for (const context of contexts) {
  context.setDefaultTimeout(20_000);
  context.setDefaultNavigationTimeout(60_000);
}
const fileId = `multiplayer-e2e-${crypto.randomUUID()}`;
const organization = `org-${fileId}`;
const password = "local-test-password-123";
const snapshot = async (context = contexts[0]) => {
  const response = await context.request.get(`${base}/api/files/${fileId}/changes`);
  assert.equal(response.status(), 200);
  return response.json();
};
const requestRevisions = new Map();
const post = async (context, body) => {
  if (!requestRevisions.has(body.operationId))
    requestRevisions.set(body.operationId, (await snapshot(context)).snapshot.revision);
  return context.request.post(`${base}/api/files/${fileId}/changes`, {
    data: { ...body, baseRevision: requestRevisions.get(body.operationId) },
    headers: { Origin: base },
  });
};
const patch = (id, path, before, after) => [
  {
    collection: "nodes",
    id,
    path,
    before: { exists: true, value: before },
    after: { exists: true, value: after },
  },
];
try {
  await client.query(
    await readFile(
      new URL("../../../migrations/20260928-file-multiplayer.sql", import.meta.url),
      "utf8",
    ),
  );
  await client.query(
    await readFile(
      new URL("../../../migrations/20261003-editor-change-deltas.sql", import.meta.url),
      "utf8",
    ),
  );
  await client.query(
    await readFile(
      new URL("../../../migrations/20261006-document-history-bounds.sql", import.meta.url),
      "utf8",
    ),
  );
  for (const [i, user] of [
    { name: "Echo", email: "owner@example.com" },
    { name: "Drift", email: "outsider@example.com" },
  ].entries()) {
    await verifiedTestAccount(client, { ...user, password });
    const response = await contexts[i].request.post(`${base}/api/auth/sign-in/email`, {
      data: { email: user.email, password },
      headers: { Origin: base },
    });
    assert.equal(response.status(), 200);
    // Other local suites reuse these accounts; keep the fixture's avatar labels deterministic.
    const renamed = await contexts[i].request.post(`${base}/api/auth/update-user`, {
      data: { name: user.name },
      headers: { Origin: base },
    });
    assert.equal(renamed.status(), 200);
  }
  const users = (
    await client.query(
      `select "id", "name" from "user" where "email" = any($1::text[]) order by "name"`,
      [["owner@example.com", "outsider@example.com"]],
    )
  ).rows;
  await client.query(
    `insert into "organization" ("id","name","slug","createdAt","createdByUserId") values ($1,'Multiplayer test',$1,now(),$2)`,
    [organization, users[0].id],
  );
  // Collaboration fixtures use Pro; hosted Free intentionally includes one editor.
  await client.query(
    `insert into "billingPlanPrice" ("priceId") values ('price_multiplayer_fixture') on conflict do nothing`,
  );
  await client.query(
    `insert into "organization_billing" ("organizationId","stripeStatus","stripePriceId") values ($1,'active','price_multiplayer_fixture')`,
    [organization],
  );
  for (const user of users)
    await client.query(
      `insert into "member" ("id","organizationId","userId","role","createdAt") values ($1,$2,$3,'owner',now())`,
      [`member-${organization}-${user.id}`, organization, user.id],
    );
  await client.query(
    `insert into "designFile" ("id","organizationId","name","createdBy") values ($1,$2,'Live canvas',$3)`,
    [fileId, organization, users[0].id],
  );
  const nodes = [
    {
      id: "frame",
      parentId: null,
      name: "Frame",
      type: "artboard",
      box: { x: 100, y: 100, width: 640, height: 480 },
      style: { fill: "#f3f1ef" },
      visible: true,
      locked: false,
      layout: "absolute",
    },
    {
      id: "rectangle",
      parentId: "frame",
      name: "Rectangle",
      type: "container",
      box: { x: 60, y: 60, width: 160, height: 100 },
      style: { fill: "#dc8eb1", radius: 8 },
      visible: true,
      locked: false,
      layout: "absolute",
    },
    {
      id: "text",
      parentId: "frame",
      name: "Heading",
      type: "text",
      text: "Working together",
      box: { x: 60, y: 220, width: 360, height: 80 },
      style: { color: "#222222", fontSize: 28, fontWeight: 600 },
      visible: true,
      locked: false,
      layout: "absolute",
    },
  ];
  const content = {
    schemaVersion: 1,
    legacyConverted: true,
    pages: [{ id: "page-1", name: "Page 1" }],
    nodes,
    tokens: {},
    warnings: [],
    editedNodeIds: [],
    deletedSourceKeys: [],
  };
  await client.query(`insert into "designDocument" ("fileId","content") values ($1,$2::jsonb)`, [
    fileId,
    JSON.stringify(content),
  ]);
  const thumbnail = `${base}/api/files/${fileId}/thumbnail`;
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6ZQAAAABJRU5ErkJggg==",
    "base64",
  );
  const updated = (
    await client.query('select "updatedAt" from "designFile" where "id"=$1', [fileId])
  ).rows[0].updatedAt;
  const version = `png-v2:1:${updated.toISOString()}`;
  const uploadThumbnail = (version, origin = base) =>
    contexts[0].request.post(`${thumbnail}?version=${encodeURIComponent(version)}`, {
      data: png,
      headers: { Origin: origin, "Content-Type": "image/png" },
    });
  assert.equal((await uploadThumbnail("stale")).status(), 409);
  assert.equal((await uploadThumbnail(version, "https://untrusted.example")).status(), 403);
  assert.equal((await uploadThumbnail(version)).status(), 204);
  const cachedThumbnail = await contexts[0].request.get(thumbnail);
  assert.equal(cachedThumbnail.status(), 200);
  assert.deepEqual(await cachedThumbnail.body(), png);
  assert.equal(
    (
      await contexts[0].request.get(thumbnail, {
        headers: { "If-None-Match": cachedThumbnail.headers().etag },
      })
    ).status(),
    304,
  );
  const anonymous = await browser.newContext();
  assert.equal((await anonymous.request.get(thumbnail)).status(), 401);
  await anonymous.close();
  console.log(
    "PASS: thumbnail publication validates version/origin and delivery requires current authentication",
  );
  const [a, b] = await Promise.all(contexts.map((context) => context.newPage()));
  let bridge;
  await b.routeWebSocket(/\/live\?/, (route) => {
    bridge = route;
    route.connectToServer();
  });
  for (const page of [a, b]) page.on("pageerror", (error) => errors.push(error.message));
  await Promise.all([a.goto(`${base}/files/${fileId}`), b.goto(`${base}/files/${fileId}`)]);
  await Promise.all(
    [a, b].map((page) =>
      page.getByRole("button", { name: "Expand editor panels", exact: true }).click(),
    ),
  );
  // The inspector (and its collaboration header) appears with an actionable selection.
  await Promise.all(
    [a, b].map((page) => page.getByRole("button", { name: "Select Frame", exact: true }).click()),
  );
  await a.getByLabel(/^Drift, (in this file|away)$/).waitFor();
  await b.getByLabel(/^Echo, (in this file|away)$/).waitFor();
  console.log("PASS: authenticated users automatically join and see collaborator avatars");
  await b.getByRole("button", { name: "Zoom 100%", exact: true }).click();
  await b.getByRole("menuitem", { name: "Zoom out" }).click();
  const boxB = await b.locator('[data-node-id="rectangle"]').boundingBox();
  const boxA = await a.locator('[data-node-id="rectangle"]').boundingBox();
  const originA = await a.getByLabel("Design canvas", { exact: true }).boundingBox();
  await b.mouse.move(boxB.x + 24, boxB.y + 24);
  const cursor = a.locator('[data-collaborator-cursor="Drift"]');
  await cursor.waitFor();
  await a.waitForFunction(
    ({ expectedX, expectedY }) => {
      const cursor = document.querySelector('[data-collaborator-cursor="Drift"]');
      const xy = cursor?.style.transform.match(/translate\(([-\d.]+)px, ([-\d.]+)px\)/);
      return (
        xy && Math.abs(Number(xy[1]) - expectedX) < 2 && Math.abs(Number(xy[2]) - expectedY) < 2
      );
    },
    { expectedX: boxA.x - originA.x + 30, expectedY: boxA.y - originA.y + 30 },
  );
  console.log("PASS: world-coordinate cursors align with different zoom levels");
  const noPointerWrites = (await snapshot()).sequence;
  await b.mouse.move(boxB.x + 60, boxB.y + 30, { steps: 20 });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal((await snapshot()).sequence, noPointerWrites);
  console.log("PASS: pointer traffic generates no Postgres document events");
  await b.getByRole("button", { name: "Zoom 80%", exact: true }).click();
  await b.getByRole("menuitem", { name: "Zoom to 100%" }).click();
  const cancelBox = await b.locator('[data-node-id="rectangle"]').boundingBox();
  await b.mouse.move(cancelBox.x + 40, cancelBox.y + 40);
  await b.mouse.down();
  await b.mouse.move(cancelBox.x + 80, cancelBox.y + 65, { steps: 4 });
  await a.locator("[data-remote-preview]").waitFor();
  await b.keyboard.press("Escape");
  await b.mouse.up();
  await a.locator("[data-remote-preview]").waitFor({ state: "detached" });
  await b.waitForFunction(
    () => document.querySelector('[data-node-id="rectangle"]')?.style.left === "60px",
  );
  assert.equal((await snapshot()).sequence, noPointerWrites);
  console.log("PASS: canceled gestures restore shared state and clear previews without a write");
  const rectangle = b.locator('[data-node-id="rectangle"]'),
    box = await rectangle.boundingBox();
  await b.mouse.move(box.x + 40, box.y + 40);
  await b.mouse.down();
  await b.mouse.move(box.x + 120, box.y + 70, { steps: 4 });
  await a.locator("[data-remote-preview]").waitFor();
  assert.equal(
    await a.locator('[data-node-id="rectangle"]').evaluate((el) => el.style.visibility),
    "hidden",
  );
  const dragStart = performance.now();
  await b.mouse.up();
  await a.waitForFunction(
    () => document.querySelector('[data-node-id="rectangle"]')?.style.left === "140px",
  );
  console.log(
    `PASS: live drag preview and commit (${Math.round(performance.now() - dragStart)} ms locally)`,
  );
  const unrelated = await post(contexts[0], {
    operationId: crypto.randomUUID(),
    patch: patch("rectangle", ["style", "fill"], "#dc8eb1", "#a9d8cb"),
  });
  assert.equal(unrelated.status(), 200);
  await b.waitForFunction(
    () =>
      document.querySelector('[data-node-id="rectangle"]')?.style.backgroundColor ===
      "rgb(169, 216, 203)",
  );
  await b.getByLabel("Design canvas", { exact: true }).focus();
  await b.keyboard.press("Control+z");
  await a.waitForFunction(
    () => document.querySelector('[data-node-id="rectangle"]')?.style.left === "60px",
  );
  assert.equal(
    (await snapshot()).snapshot.content.nodes.find((node) => node.id === "rectangle").style.fill,
    "#a9d8cb",
  );
  await b.keyboard.press("Control+Shift+z");
  await a.waitForFunction(
    () => document.querySelector('[data-node-id="rectangle"]')?.style.left === "140px",
  );
  console.log("PASS: browser undo and redo preserve another collaborator's edit");
  await b.getByLabel("Design canvas", { exact: true }).click({ position: { x: 20, y: 850 } });
  await b.locator('[data-node-id="text"]').dblclick();
  await b.getByRole("textbox", { name: "Edit Heading" }).fill("Live typing preview");
  await a.locator("[data-remote-preview]").filter({ hasText: "Live typing preview" }).waitFor();
  await b.getByRole("textbox", { name: "Edit Heading" }).blur();
  await a.locator('[data-node-id="text"]').filter({ hasText: "Live typing preview" }).waitFor();
  console.log("PASS: live text drafts and committed text arrive without polling");
  // A remote update to another property must neither replace a focused input
  // nor undo the next interaction when an earlier acknowledgment arrives.
  await b.locator('[data-node-id="rectangle"]').click();
  const field = b.getByRole("textbox", { name: "Layer name", exact: true });
  await field.fill("My unfinished layer name");
  const remote = await post(contexts[0], {
    operationId: crypto.randomUUID(),
    patch: patch("rectangle", ["box", "width"], 160, 190),
  });
  assert.equal(remote.status(), 200);
  await b.waitForFunction(
    () => document.querySelector('[data-node-id="rectangle"]')?.style.width === "190px",
  );
  assert.equal(await field.inputValue(), "My unfinished layer name");
  await field.press("Enter");
  await a.getByRole("button", { name: "Select My unfinished layer name", exact: true }).waitFor();
  console.log("PASS: incoming edits preserve a focused input draft");
  const concurrent = await Promise.all([
    post(contexts[0], {
      operationId: crypto.randomUUID(),
      patch: patch("rectangle", ["box", "x"], 140, 170),
    }),
    post(contexts[1], {
      operationId: crypto.randomUUID(),
      patch: patch("text", ["text"], "Live typing preview", "Independent edit"),
    }),
  ]);
  for (const response of concurrent) assert.equal(response.status(), 200);
  const both = await snapshot();
  assert.equal(both.snapshot.content.nodes.find((node) => node.id === "rectangle").box.x, 170);
  assert.equal(
    both.snapshot.content.nodes.find((node) => node.id === "text").text,
    "Independent edit",
  );
  await a.locator('[data-node-id="text"]').filter({ hasText: "Independent edit" }).waitFor();
  console.log("PASS: independent concurrent edits survive and render in both sessions");
  if (proxy) {
    const { authenticatedEditorAcceptance } =
      await import("./fixtures/authenticated-editor-acceptance.mjs");
    await authenticatedEditorAcceptance({
      base,
      fileId,
      organization,
      users,
      contexts,
      a,
      b,
      client,
      proxy,
      snapshot,
      post,
      patch,
    });
  }
  await b.getByRole("button", { name: "Comment tool", exact: true }).click();
  await b.getByLabel("Design canvas", { exact: true }).click({ position: { x: 80, y: 150 } });
  await b.getByRole("textbox", { name: "Write a comment" }).fill("A live comment");
  await b.getByRole("button", { name: "Post", exact: true }).click();
  await a.getByRole("button", { name: "Open comment by Drift" }).waitFor();
  await a.getByRole("button", { name: "Open comment by Drift" }).click();
  await a.getByText("A live comment", { exact: true }).waitFor();
  await a.getByRole("button", { name: "Add emoji reaction" }).click();
  await a.getByRole("button", { name: "React with 👍", exact: true }).click();
  await b.getByRole("button", { name: "👍 reaction, 1, add yours", exact: true }).waitFor();
  await a.getByRole("button", { name: "👍 reaction, 1, remove yours", exact: true }).waitFor();
  console.log("PASS: comments and reactions update live with viewer-specific state");
  await b.getByRole("button", { name: "Thread options", exact: true }).click();
  await b.getByRole("button", { name: "Delete thread", exact: true }).click();
  await b
    .getByRole("dialog", { name: "Delete thread?", exact: true })
    .getByRole("button", { name: "Delete thread", exact: true })
    .click();
  await a.getByRole("button", { name: "Open comment by Drift" }).waitFor({ state: "detached" });
  await b.getByRole("button", { name: "Select tool", exact: true }).click();
  await a.getByRole("button", { name: "Live canvas", exact: true }).click();
  await a.getByRole("textbox", { name: "File name", exact: true }).fill("Live renamed canvas");
  await a.getByRole("textbox", { name: "File name", exact: true }).press("Enter");
  await b.getByRole("button", { name: "Live renamed canvas", exact: true }).waitFor();
  console.log("PASS: renames and comment deletion are pushed immediately");
  // Simulate commit followed by a process failure before room publication. The
  // room alarm must eventually deliver the durable outbox event without a poll.
  await client.query(
    `update "designDocument" set "content"=jsonb_set("content" #- '{nodes,2,richText}','{nodes,2,text}',to_jsonb('Recovered outbox event'::text)),"revision"="revision"+1 where "fileId"=$1`,
    [fileId],
  );
  await a
    .locator('[data-node-id="text"]')
    .filter({ hasText: "Recovered outbox event" })
    .waitFor({ timeout: 20_000 });
  console.log("PASS: room recovery delivers a commit whose immediate relay was lost");
  await client.query(
    `update "designDocument" set "content"=jsonb_set("content" #- '{nodes,2,richText}','{nodes,2,text}',to_jsonb('Caught up after reconnect'::text)),"revision"="revision"+1 where "fileId"=$1`,
    [fileId],
  );
  bridge.close({ code: 1012, reason: "Integration reconnect" });
  await b
    .locator('[data-node-id="text"]')
    .filter({ hasText: "Caught up after reconnect" })
    .waitFor();
  await a.getByLabel(/^Drift, (in this file|away)$/).waitFor();
  console.log("PASS: automatic reconnect recovers missed document changes");
  await b.bringToFront();
  await b.mouse.move(650, 400);
  await a.locator('[data-collaborator-cursor="Drift"]').waitFor();
  await mkdir(".artifacts/multiplayer", { recursive: true });
  await a.screenshot({ path: ".artifacts/multiplayer/two-users.png", fullPage: true });
  const unauthenticated = await browser.newContext();
  assert.equal(
    (
      await unauthenticated.request.post(`${base}/api/files/${fileId}/presence-ticket`, {
        headers: { Origin: base },
      })
    ).status(),
    401,
  );
  assert.equal(
    (
      await contexts[0].request.post(`${base}/api/files/${fileId}/presence-ticket`, {
        headers: { Origin: "https://untrusted.example" },
      })
    ).status(),
    403,
  );
  console.log("PASS: presence tickets reject unauthenticated and cross-origin requests");
  const spoof = await contexts[0].request.post(`${base}/api/files/${fileId}/presence-ticket`, {
    headers: { Origin: base },
  });
  const spoofTicket = await spoof.json();
  const closeCode = await a.evaluate(
    (url) =>
      new Promise((resolve) => {
        const socket = new WebSocket(url);
        socket.onopen = () =>
          socket.send(
            JSON.stringify({
              type: "presence",
              presence: {
                pageId: "page-1",
                cursor: null,
                selectedIds: [],
                action: null,
                away: false,
                preview: null,
                userId: "spoofed-actor",
              },
            }),
          );
        socket.onclose = (event) => resolve(event.code);
      }),
    spoofTicket.url,
  );
  assert.equal(closeCode, 1008);
  console.log("PASS: the live room rejects client-supplied actor identity");
  const drift = users.find((user) => user.name === "Drift");
  await client.query(`delete from "member" where "organizationId"=$1 and "userId"=$2`, [
    organization,
    drift.id,
  ]);
  const wake = await post(contexts[0], {
    operationId: crypto.randomUUID(),
    patch: patch("rectangle", ["box", "width"], 190, 200),
  });
  assert.equal(wake.status(), 200);
  await a.getByLabel(/^Drift, (in this file|away)$/).waitFor({ state: "detached" });
  await b.getByRole("status").filter({ hasText: "Live unavailable" }).waitFor();
  assert.equal(
    (await contexts[1].request.get(`${base}/api/files/${fileId}/changes`)).status(),
    404,
  );
  assert.equal(
    (
      await contexts[1].request.get(thumbnail, {
        headers: { "If-None-Match": cachedThumbnail.headers().etag },
      })
    ).status(),
    404,
  );
  console.log("PASS: revoked membership closes the socket and blocks further file access");
  await b.close();
  await a.getByLabel(/^Drift, (in this file|away)$/).waitFor({ state: "detached" });
  console.log("PASS: disconnected collaborators disappear");
  assert.deepEqual(errors, []);
  console.log("PASS: no browser runtime errors");
} catch (error) {
  console.error("Browser errors:", errors);
  for (const context of contexts)
    for (const page of context.pages())
      console.error(
        "Failed page:",
        page.url(),
        (await page.locator("body").innerText()).slice(0, 1500),
      );
  throw error;
} finally {
  await browser.close();
  await client.query(`delete from "organization" where "id"=$1`, [organization]);
  await client.end();
  await proxy?.close();
}
