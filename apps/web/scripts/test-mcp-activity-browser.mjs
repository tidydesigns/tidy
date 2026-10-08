// Start the local Next app and realtime worker first. Never accepts remote hosts.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";
import pg from "pg";
import { verifiedTestAccount } from "./fixtures/verified-test-account.mjs";

const base = process.env.MULTIPLAYER_TEST_BASE_URL ?? "http://localhost:3128";
const connectionString = process.env.MULTIPLAYER_TEST_DATABASE_URL;
if (
  !["localhost", "127.0.0.1"].includes(new URL(base).hostname) ||
  !connectionString ||
  !["localhost", "127.0.0.1"].includes(new URL(connectionString).hostname)
)
  throw new Error("Use a disposable localhost database and local app.");
const client = new pg.Client({ connectionString });
await client.connect();
const lock = new pg.Client({ connectionString });
await lock.connect();
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const fileId = crypto.randomUUID(),
  organization = `org-activity-${fileId}`,
  clientId = `client-activity-${fileId}`;
let locked = false,
  pendingCall;
try {
  const email = "owner@example.com",
    password = "local-test-password-123";
  await verifiedTestAccount(client, { name: "Activity tester", email, password });
  assert.equal(
    (
      await context.request.post(`${base}/api/auth/sign-in/email`, {
        data: { email, password },
        headers: { Origin: base },
      })
    ).status(),
    200,
  );
  const userId = (await client.query('select "id" from "user" where "email"=$1', [email])).rows[0]
    .id;
  await client.query(
    `insert into "organization" ("id","name","slug","createdAt") values ($1,'Activity test',$1,now())`,
    [organization],
  );
  await client.query(
    `insert into "member" ("id","organizationId","userId","role","createdAt") values ($1,$2,$3,'owner',now())`,
    [`member-${fileId}`, organization, userId],
  );
  await client.query(
    `insert into "designFile" ("id","organizationId","name","createdBy") values ($1,$2,'Agent canvas',$3)`,
    [fileId, organization, userId],
  );
  const node = (id, parentId, type, box, extra = {}) => ({
    id,
    parentId,
    type,
    name: id,
    box,
    style: {},
    layout: "absolute",
    visible: true,
    locked: false,
    ...extra,
  });
  const nodes = [
    node(
      "frame",
      null,
      "artboard",
      { x: 100, y: 100, width: 640, height: 480 },
      { style: { fill: "#f3f1ef" } },
    ),
    node(
      "heading",
      "frame",
      "text",
      { x: 40, y: 80, width: 400, height: 70 },
      { text: "Before agent edit", style: { fontSize: 28, color: "#222222" } },
    ),
  ];
  const document = {
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
    JSON.stringify(document),
  ]);
  await client.query(
    `insert into "oauthClient" ("id","clientId","name","redirectUris","tokenEndpointAuthMethod","userId") values ($1,$1,'Local coding agent','[]','none',$2)`,
    [clientId, userId],
  );
  await client.query(
    `insert into "oauthConsent" ("id","clientId","userId","resources","scopes","createdAt","updatedAt") values ($1,$1,$2,$3::jsonb,'["mcp:read","mcp:write"]',now(),now())`,
    [clientId, userId, JSON.stringify([`${base}/api/mcp`])],
  );
  const token = JSON.parse(
    execFileSync(
      "bun",
      [
        "--conditions",
        "react-server",
        "-e",
        `const {auth}=await import('./lib/auth');const ctx=await auth.$context;const signed=await auth.api.signJWT({body:{payload:{sub:${JSON.stringify(userId)},client_id:${JSON.stringify(clientId)},scope:'mcp:read mcp:write',aud:${JSON.stringify(`${base}/api/mcp`)},iss:ctx.baseURL,bella_grant_version:'0',exp:Math.floor(Date.now()/1000)+600}}});console.log(JSON.stringify(signed));process.exit(0);`,
      ],
      {
        cwd: new URL("../", import.meta.url),
        env: { ...process.env, DATABASE_URL: connectionString, BETTER_AUTH_URL: base },
        encoding: "utf8",
      },
    ),
  ).token;
  let requestId = 0;
  const call = async (name, args) => {
    const response = await fetch(`${base}/api/mcp`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: ++requestId,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    });
    const text = await response.text();
    assert.equal(response.status, 200, text);
    const message = JSON.parse(
      text.startsWith("data:") || text.startsWith("event:")
        ? text
            .split("\n")
            .find((line) => line.startsWith("data: "))
            .slice(6)
        : text,
    );
    assert.ok(message.result, JSON.stringify(message));
    return message.result;
  };
  const page = await context.newPage(),
    errors = [],
    messages = [];
  let bridge,
    changes = 0;
  await page.route(/\/(api\/posthog|array|e|i)\//, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "{}" }),
  );
  await page.routeWebSocket(/\/live\?/, (route) => {
    bridge = route;
    route.connectToServer();
  });
  page.on("websocket", (socket) =>
    socket.on("framereceived", ({ payload }) => {
      try {
        messages.push(JSON.parse(String(payload)));
      } catch {}
    }),
  );
  page.on("request", (request) => {
    if (request.url().includes(`/api/files/${fileId}/changes`)) changes++;
  });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    window.activityProfile = {
      CanvasArtwork: 0,
      LayerTree: 0,
      SelectionInspector: 0,
      AgentActivityOverlay: 0,
    };
    window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
      supportsFiber: true,
      renderers: new Map(),
      inject(renderer) {
        this.renderers.set(1, renderer);
        return 1;
      },
      onCommitFiberUnmount() {},
      onCommitFiberRoot(_id, root) {
        const visit = (fiber) => {
          if (!fiber) return;
          const name = fiber.type?.name;
          if (fiber.flags & 1 && name in window.activityProfile) window.activityProfile[name]++;
          visit(fiber.child);
          visit(fiber.sibling);
        };
        visit(root.current);
      },
    };
  });
  await page.goto(`${base}/files/${fileId}`);
  await page.locator('[data-node-id="heading"]').waitFor();
  await page.waitForFunction(() => window.activityProfile.CanvasArtwork > 0);
  await page.waitForTimeout(1000);
  const before = await page.evaluate(() => ({ ...window.activityProfile })),
    initialChanges = changes;
  // Hold a real document lock so this genuinely running tool remains observable.
  await lock.query("begin");
  locked = true;
  await lock.query('select 1 from "designDocument" where "fileId"=$1 for update', [fileId]);
  const pending = (pendingCall = call("patch_document", {
    file_id: fileId,
    node_id: "heading",
    expected_revision: 1,
    changes: { text: "Edited by agent" },
  }));
  await page.locator('[data-agent-activity="editing"]').waitFor();
  await page.locator('[data-agent-target="frame"]').waitFor();
  assert.ok(
    !(
      await call("export_component", {
        file_id: fileId,
        node_id: "frame",
        component_name: "CanvasFrame",
      })
    ).isError,
  );
  await page.locator('[data-agent-activity="editing"]').waitFor();
  await page.locator('[data-agent-activity="editing"] summary').click();
  await page.getByText("heading", { exact: true }).last().waitFor();
  assert.equal(changes, initialChanges, "Activity must not fetch document changes");
  const during = await page.evaluate(() => ({ ...window.activityProfile }));
  for (const name of ["CanvasArtwork", "LayerTree", "SelectionInspector"])
    assert.equal(during[name], before[name], `${name} must not render for activity`);
  assert.ok(during.AgentActivityOverlay > before.AgentActivityOverlay);
  const outline = await page.locator('[data-agent-target="frame"]').boundingBox(),
    frame = await page.locator('[data-node-id="frame"]').boundingBox();
  assert.ok(Math.abs(outline.x - frame.x) < 2 && Math.abs(outline.width - frame.width) < 2);
  const dot = page.locator('[data-agent-activity="editing"] summary span').first();
  assert.notEqual(
    await dot.evaluate((element) => getComputedStyle(element, "::after").animationName),
    "none",
  );
  await page.emulateMedia({ reducedMotion: "reduce" });
  assert.equal(
    await dot.evaluate((element) => getComputedStyle(element, "::after").animationName),
    "none",
  );
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await mkdir(".artifacts/mcp-activity", { recursive: true });
  await page.screenshot({ path: ".artifacts/mcp-activity/editing.png" });
  const snapshotCount = messages.filter((message) => message.type === "activities").length;
  bridge.close({ code: 1012, reason: "Activity reconnect test" });
  for (
    let attempt = 0;
    attempt < 100 &&
    messages.filter((message) => message.type === "activities").length <= snapshotCount;
    attempt++
  )
    await page.waitForTimeout(100);
  assert.ok(
    messages.filter((message) => message.type === "activities").length > snapshotCount,
    "Reconnect must restore the room activity snapshot",
  );
  await page.locator('[data-agent-activity="editing"]').waitFor();
  await lock.query("commit");
  locked = false;
  assert.ok(!(await pending).isError);
  await page.locator('[data-node-id="heading"]').filter({ hasText: "Edited by agent" }).waitFor();
  console.log(
    "PASS: actual MCP edits animate the target, survive concurrent exports/reconnects, skip artwork/panel renders and document refreshes, honor reduced motion, and commit live",
  );
  const created = (
    await call("create_import", {
      organization_id: organization,
      file_id: fileId,
      name: "Checkout import",
    })
  ).structuredContent;
  const imported = node(
    "checkout",
    null,
    "artboard",
    { x: 900, y: 100, width: 400, height: 400 },
    { sourcePath: "src/checkout.tsx?secret=hidden" },
  );
  const chunk = {
    import_id: created.importId,
    chunk_id: "001",
    nodes: [imported],
    source: { project: "storefront", route: "/checkout?secret=hidden" },
  };
  assert.ok(!(await call("put_import_chunk", chunk)).isError);
  assert.ok(!(await call("put_import_chunk", chunk)).isError);
  const staged = page.locator('[data-agent-fallback][data-agent-activity="staged"]');
  await staged.waitFor();
  await staged.locator("summary").click();
  await staged.getByText("1 layer staged · 0 assets", { exact: true }).waitFor();
  await staged.getByText("src/checkout.tsx", { exact: true }).waitFor();
  assert.ok(!(await call("validate_import", { import_id: created.importId })).isError);
  assert.ok(!(await call("commit_import", { import_id: created.importId })).isError);
  await page.locator('[data-node-id="checkout"]').waitFor();
  console.log(
    "PASS: staged import details identify source and counts, retries do not inflate counts, and publication updates the real document",
  );
  const captured = await call("import_web_capture", {
    organization_id: organization,
    file_id: fileId,
    capture: {
      title: "Web capture",
      url: "https://example.com/checkout",
      mode: "page",
      document: {
        ...document,
        nodes: [node("captured", null, "artboard", { x: 0, y: 0, width: 320, height: 200 })],
      },
      assets: [],
    },
  });
  assert.ok(!captured.isError, JSON.stringify(captured));
  assert.equal(captured.structuredContent.sourceRoute, "/checkout");
  const failed = await call("patch_document", {
    file_id: fileId,
    node_id: "heading",
    expected_revision: 1,
    changes: { text: "Must fail" },
  });
  assert.equal(failed.isError, true);
  await page.locator('[data-agent-activity="failed"]').waitFor();
  assert.equal(await page.locator('[data-node-id="heading"]').textContent(), "Edited by agent");
  const discarded = (
    await call("create_import", {
      organization_id: organization,
      file_id: fileId,
      name: "Discarded import",
    })
  ).structuredContent;
  await call("abort_import", { import_id: discarded.importId });
  await page.locator('[data-agent-activity="aborted"]').waitFor();
  const activities = messages.flatMap((message) =>
    message.type === "activity"
      ? [message.activity]
      : message.type === "activities"
        ? message.activities
        : [],
  );
  assert.ok(activities.length >= 10);
  for (const activity of activities) {
    const serialized = JSON.stringify(activity);
    assert.ok(Buffer.byteLength(serialized) <= 2048);
    assert.ok(
      !serialized.includes("secret=") &&
        !serialized.includes(userId) &&
        !serialized.includes("Must fail"),
    );
  }
  const ticket = await (
    await context.request.post(`${base}/api/files/${fileId}/presence-ticket`, {
      headers: { Origin: base },
    })
  ).json();
  assert.equal(
    await page.evaluate(
      (url) =>
        new Promise((resolve) => {
          const socket = new WebSocket(url);
          socket.onopen = () =>
            socket.send(
              JSON.stringify({ type: "activity", activity: { actorName: "Spoofed agent" } }),
            );
          socket.onclose = (event) => resolve(event.code);
        }),
      ticket.url,
    ),
    1008,
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Minimize editor panels", exact: true }).click();
  await page.screenshot({ path: ".artifacts/mcp-activity/narrow.png" });
  await page.setViewportSize({ width: 1440, height: 1000 });
  for (const size of [100, 1000, 5000]) {
    const large = Array.from({ length: size }, (_, index) =>
      node(`large-${index}`, null, "artboard", {
        x: (index % 20) * 500,
        y: Math.floor(index / 20) * 500,
        width: 300,
        height: 300,
      }),
    );
    await client.query('update "designDocument" set "content"=$2::jsonb where "fileId"=$1', [
      fileId,
      JSON.stringify({ ...document, nodes: large }),
    ]);
    await page.reload();
    await page.locator('[data-node-id="large-0"]').waitFor();
    await page.waitForTimeout(1500);
    const baseline = await page.evaluate(() => ({ ...window.activityProfile })),
      baselineChanges = changes;
    for (let index = 0; index < 5; index++)
      await call("get_document", { file_id: fileId, offset: 0, limit: 1 });
    const profile = await page.evaluate(() => ({ ...window.activityProfile }));
    for (const name of ["CanvasArtwork", "LayerTree", "SelectionInspector"])
      assert.equal(
        profile[name],
        baseline[name],
        `${size} nodes: ${name} must skip activity renders`,
      );
    assert.equal(changes, baselineChanges, `${size} nodes: activity must not refresh content`);
    assert.ok((await page.locator("[data-agent-activity]").count()) <= 4);
    console.log(
      `PASS: ${size} nodes, five real MCP reads: zero artwork/panel renders and document refreshes; bounded markers`,
    );
  }
  assert.deepEqual(errors, []);
  console.log(
    "PASS: failed and aborted calls are truthful; activity payloads stay private/bounded and browser activity spoofing is rejected",
  );
} finally {
  if (locked) await lock.query("rollback");
  await pendingCall?.catch(() => {});
  await browser.close();
  await client.query('delete from "oauthClient" where "clientId"=$1', [clientId]);
  await client.query('delete from "organization" where "id"=$1', [organization]);
  await lock.end();
  await client.end();
}
