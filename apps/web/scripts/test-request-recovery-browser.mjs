// Disposable local browser test: no app secrets, remote accounts or database.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { chromium } from "playwright";
const directory = await mkdtemp(join(tmpdir(), "tidy-request-recovery-"));
const built = spawnSync(
  "bun",
  ["build", "scripts/fixtures/request-recovery.tsx", "--target=browser", `--outdir=${directory}`],
  { cwd: new URL("..", import.meta.url), encoding: "utf8" },
);
assert.equal(built.status, 0, built.stderr);
let presence = 0;
const operations = [];
let revision = 1;
let blockReads = false;
let expireEdits = false;
let recoverySnapshot;
let failRecovery = false;
const revisions = [];
const server = createServer(async (request, response) => {
  const path = new URL(request.url, "http://localhost").pathname;
  if (path === "/fixture.js") {
    response.setHeader("content-type", "application/javascript");
    response.end(await readFile(join(directory, "request-recovery.js")));
    return;
  }
  if (path.endsWith("/presence-ticket")) {
    presence++;
    response.setHeader("content-type", "application/json");
    if (presence === 1) {
      response.writeHead(503).end('{"error":"temporarily_unavailable"}');
      return;
    }
    response.end(
      JSON.stringify({
        url: "ws://localhost/fixture",
        expiresAt: Date.now() + 300000,
        sessionId: "fixture",
      }),
    );
    return;
  }
  if (path.endsWith("/changes")) {
    if (request.method === "POST") {
      let bytes = "";
      for await (const chunk of request) bytes += chunk;
      const input = JSON.parse(bytes);
      operations.push(input.operationId);
      revisions.push(input.baseRevision);
      if (expireEdits) {
        response
          .writeHead(410, { "content-type": "application/json" })
          .end(JSON.stringify({ error: "Retry window expired", code: "EDIT_EXPIRED" }));
        return;
      }
      if (operations.length === 1) {
        response.writeHead(503).end('{"error":"temporarily_unavailable"}');
        return;
      }
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          patch: input.patch,
          baseRevision: input.baseRevision,
          revision: ++revision,
          sequence: revision,
        }),
      );
      return;
    }
    if (blockReads) return;
    if (failRecovery) {
      response.writeHead(503).end("{}");
      return;
    }
    if (recoverySnapshot) {
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          name: "Fixture",
          snapshot: recoverySnapshot,
          canEdit: true,
          sequence: recoverySnapshot.revision,
        }),
      );
      return;
    }
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({
        name: "Fixture",
        revision: 1,
        baseRevision: 1,
        patches: [],
        canEdit: true,
        sequence: 1,
      }),
    );
    return;
  }
  response.setHeader("content-type", "text/html");
  response.end(
    '<html><body><div id="root"></div><script src="/fixture.js"></script></body></html>',
  );
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    window.rejections = [];
    addEventListener("unhandledrejection", (event) =>
      window.rejections.push(event.reason?.name ?? String(event.reason)),
    );
  });
  await page.goto("http://127.0.0.1:" + server.address().port);
  await page.locator("#connection").filter({ hasText: "live" }).waitFor();
  assert.equal(presence, 2, "a transient presence 503 must reconnect");
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.locator("#result").filter({ hasText: "committed" }).waitFor();
  assert.equal(operations.length, 2);
  assert.equal(operations[0], operations[1], "retry must preserve the deduplication ID");
  assert.equal(await page.locator("#revision").textContent(), "2");
  assert.equal(revisions[0], revisions[1], "retry must also preserve the original base revision");
  // A lost acknowledgement may outlive retention. Reconcile without resubmitting.
  const content = await page.evaluate(() => window.recoveryFixtureDocument);
  content.nodes[0].name = "Already saved remotely";
  recoverySnapshot = { revision: 5, content };
  expireEdits = true;
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.locator("#result").filter({ hasText: "rejected" }).waitFor();
  assert.equal(await page.locator("#revision").textContent(), "5");
  assert.equal(await page.locator("#name").textContent(), "Already saved remotely");
  await page.waitForTimeout(700);
  assert.equal(operations.length, 3, "expired edit must not be retagged or retried");
  failRecovery = true;
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.locator("#result").filter({ hasText: "rejected" }).waitFor();
  await page.waitForTimeout(700);
  assert.equal(operations.length, 4, "a failed snapshot refresh must not replay an expired edit");
  assert.equal(await page.locator("#revision").textContent(), "5");
  failRecovery = false;
  // A new room's in-flight synchronization must be canceled safely on leaving.
  blockReads = true;
  await page.reload();
  await page.locator("#connection").filter({ hasText: "live" }).waitFor();
  await page.getByRole("button", { name: "Leave", exact: true }).click();
  await page.waitForTimeout(100);
  assert.deepEqual(errors, []);
  assert.deepEqual(await page.evaluate(() => window.rejections), []);
  console.log(
    "PASS: presence 503 recovers; edit 503 retries with one operation ID; expired edits recover snapshots without replay, including refresh failure; leaving cancels pending synchronization without unhandled rejections",
  );
} finally {
  await browser.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await rm(directory, { recursive: true, force: true });
}
