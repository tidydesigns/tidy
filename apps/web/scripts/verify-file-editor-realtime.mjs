// Run with Bun: uses the real patch model and intercepted HTTP/WebSocket transport.
// All preview requests are intercepted; this never writes to a database.
import assert from "node:assert/strict";
import { buildLoginDocument } from "../lib/design/examples/login";
import { applyDocumentPatch, diffDocument } from "../lib/design/document-patch";
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const baseUrl = process.env.EDITOR_TEST_URL || "http://127.0.0.1:3107";
const command = process.platform === "darwin" ? "Meta" : "Control";
const browser = await chromium.launch({ headless: true, args: ["--no-proxy-server"] });
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  let snapshot = {
      revision: 1,
      content: buildLoginDocument("00000000-0000-4000-8000-000000000001"),
    },
    sequence = 0,
    socket;
  const operations = new Map(),
    versions = new Map(),
    requests = [],
    waiters = new Map(),
    errors = [];
  const recordVersions = (patch, version) =>
    patch.forEach((change) =>
      versions.set(JSON.stringify([change.collection, change.id, change.path]), version),
    );
  const waitRequest = (index) =>
    requests[index]
      ? Promise.resolve(requests[index])
      : new Promise((resolve) => waiters.set(index, resolve));
  await context.routeWebSocket(`${baseUrl.replace(/^http/, "ws")}/mock-file-room`, (ws) => {
    socket = ws;
    ws.send(JSON.stringify({ type: "ready" }));
  });
  await context.route("**/api/files/preview/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const json = (body, status = 200) =>
      route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (path.endsWith("presence-ticket"))
      return json({
        url: `${baseUrl.replace(/^http/, "ws")}/mock-file-room`,
        expiresAt: Date.now() + 600_000,
        sessionId: "test-session",
      });
    if (!path.endsWith("changes")) return json({ comments: [], threads: [] });
    if (route.request().method() === "GET")
      return json({ snapshot, name: "Network fixture", sequence });
    const input = route.request().postDataJSON();
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const request = { input, release, drop: false };
    const index = requests.push(request) - 1;
    waiters.get(index)?.(request);
    waiters.delete(index);
    await gate;
    try {
      let result = operations.get(input.operationId);
      if (!result) {
        if (input.conditional) {
          const allowed = input.allowedSequences ?? [];
          assert.ok(
            allowed.every((version) =>
              [...operations.values()].some(
                (operation) => operation.sequence === version && operation.patch.length,
              ),
            ),
          );
          for (const change of input.patch) {
            if (
              change.path[0] === "$order" ||
              change.path[0] === "instanceOverrides" ||
              (change.collection === "document" &&
                ["editedNodeIds", "deletedSourceKeys"].includes(change.path[0]))
            )
              continue;
            for (const [key, version] of versions) {
              const [collection, id, path] = JSON.parse(key);
              if (
                collection === change.collection &&
                id === change.id &&
                path
                  .slice(0, Math.min(path.length, change.path.length))
                  .every((part, index) => change.path[index] === part) &&
                version > input.expectedSequence &&
                !allowed.includes(version)
              )
                throw new Error("This edit changed elsewhere and cannot be undone.");
            }
          }
        }
        const content = applyDocumentPatch(snapshot.content, input.patch, input.conditional);
        const patch = diffDocument(snapshot.content, content);
        snapshot = { revision: snapshot.revision + 1, content };
        result = { patch, snapshot, sequence: ++sequence };
        operations.set(input.operationId, result);
        recordVersions(patch, sequence);
      }
      if (request.drop) return route.abort("failed");
      return json(result);
    } catch (cause) {
      return json({ error: cause.message }, 409);
    }
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${baseUrl}/dev/import-preview?edit=1&realtime=1`);
  await page.getByRole("tree", { name: "Layers" }).waitFor();
  const canvas = page.getByLabel("Design canvas", { exact: true });
  const email = page.locator('[data-node-id="desktop-email-input"]'),
    password = page.locator('[data-node-id="desktop-password-input"]');
  const radius = () => page.getByRole("spinbutton", { name: "Radius", exact: true });
  const expectRadius = async (node, value) => {
    await page.waitForFunction(
      ({ id, value }) =>
        document.querySelector(`[data-node-id="${id}"]`).style.borderTopLeftRadius === `${value}px`,
      { id: await node.getAttribute("data-node-id"), value },
    );
  };
  await page.getByRole("button", { name: "Select Email input", exact: true }).first().click();
  await radius().fill("16");
  await radius().press("Enter");
  await waitRequest(0);
  await canvas.focus();
  await page.keyboard.press(`${command}+z`);
  await expectRadius(email, 8);
  await page.keyboard.press(`${command}+Shift+z`);
  await expectRadius(email, 16);
  await radius().fill("24");
  await radius().press("Enter");
  await page.getByRole("button", { name: "Select Password input", exact: true }).first().click();
  for (let i = 0; i < 4; i++) (await waitRequest(i)).release();
  await expectRadius(email, 24);
  assert.equal(
    await page.getByRole("textbox", { name: "Layer name", exact: true }).inputValue(),
    "Password input",
  );
  assert.deepEqual(
    requests.slice(0, 4).map((r) => r.input.expectedSequence),
    [undefined, 1, 2, undefined],
  );

  await radius().fill("20");
  await radius().press("Enter");
  const lost = await waitRequest(4);
  await canvas.focus();
  await page.keyboard.press(`${command}+z`);
  await expectRadius(password, 8);
  lost.drop = true;
  lost.release();
  const retry = await waitRequest(5);
  assert.equal(retry.input.operationId, lost.input.operationId);
  retry.release();
  const undo = await waitRequest(6);
  assert.equal(undo.input.expectedSequence, 5);
  undo.release();
  await expectRadius(password, 8);
  // Reopening synchronizes from the stored server fixture through the room's GET path.
  await page.reload();
  await page.waitForFunction(
    () =>
      document.querySelector('[data-node-id="desktop-email-input"]')?.style.borderTopLeftRadius ===
      "24px",
  );
  await page.getByRole("button", { name: "Select Password input", exact: true }).first().click();
  await radius().fill("18");
  await radius().press("Enter");
  (await waitRequest(7)).release();
  await page.waitForFunction(
    () =>
      document.querySelector('[data-node-id="desktop-password-input"]')?.style
        .borderTopLeftRadius === "18px",
  );
  const beforeRemote = snapshot.content;
  snapshot = {
    revision: snapshot.revision + 1,
    content: {
      ...snapshot.content,
      nodes: snapshot.content.nodes.map((node) =>
        node.id === "desktop-password-input"
          ? { ...node, style: { ...node.style, radius: 30 } }
          : node,
      ),
    },
  };
  sequence++;
  recordVersions(diffDocument(beforeRemote, snapshot.content), sequence);
  socket.send(JSON.stringify({ type: "events", events: [{ sequence, kind: "document" }] }));
  await expectRadius(password, 30);
  await canvas.focus();
  await page.keyboard.press(`${command}+z`);
  await expectRadius(password, 8);
  (await waitRequest(8)).release();
  await expectRadius(password, 30);
  await page.getByRole("alert").filter({ hasText: "changed elsewhere" }).waitFor();
  await page.reload();
  await expectRadius(email, 24);
  await page.getByRole("button", { name: "Select Email input", exact: true }).first().click();
  await radius().fill("32");
  await radius().press("Enter");
  await waitRequest(9);
  await radius().fill("40");
  await radius().press("Enter");
  await canvas.focus();
  await page.keyboard.press(`${command}+z`);
  await expectRadius(email, 32);
  await page.keyboard.press(`${command}+z`);
  await expectRadius(email, 24);
  for (let i = 9; i < 13; i++) (await waitRequest(i)).release();
  await page.waitForFunction(
    () =>
      document.querySelector('[data-node-id="desktop-email-input"]')?.style.borderTopLeftRadius ===
      "24px",
  );
  assert.deepEqual(requests[12].input.allowedSequences, [11]);
  await canvas.focus();
  await page.keyboard.press(`${command}+Shift+z`);
  await expectRadius(email, 32);
  await page.keyboard.press(`${command}+Shift+z`);
  await expectRadius(email, 40);
  for (let i = 13; i < 15; i++) (await waitRequest(i)).release();
  assert.deepEqual(requests[14].input.allowedSequences, [13]);
  assert.deepEqual(errors, []);
  console.log(
    "PASS: immediate pending undo/redo, consecutive same-property undo/redo, canonical version chaining, later edits and selection preservation, idempotent lost-ack retry, reopen synchronization, and conflicting remote undo rollback; no page errors",
  );
  await context.close();
} finally {
  await browser.close();
}
