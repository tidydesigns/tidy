// Real Chrome extension and cookie transport; disposable profile and fixture server only.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const repo = fileURLToPath(new URL("../../../", import.meta.url));
const profile = await mkdtemp(path.join(tmpdir(), "tidy-extension-auth-"));
const imports = [];
const server = createServer(async (request, response) => {
  if (request.url === "/login") {
    response.setHeader("Set-Cookie", "fixture_session=opaque; HttpOnly; SameSite=Lax; Path=/");
    response.end("Fixture signed in");
    return;
  }
  if (!request.url.startsWith("/api/extension/")) {
    response.setHeader("Content-Type", "text/html");
    response.end("<title>Fixture source</title><h1>Public website design</h1>");
    return;
  }
  response.setHeader("Content-Type", "application/json");
  if (!request.headers.cookie?.includes("fixture_session=opaque")) {
    response.writeHead(401).end(JSON.stringify({ error: "Sign in to Tidy to continue." }));
    return;
  }
  if (request.url === "/api/extension/account") {
    response.end(
      JSON.stringify({
        user: { id: "fixture-user", name: "Fixture" },
        organizations: [{ id: "fixture-org", name: "Fixture", files: [] }],
      }),
    );
    return;
  }
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  imports.push({ headers: request.headers, body: JSON.parse(Buffer.concat(chunks).toString()) });
  response.end(
    JSON.stringify({
      fileId: "00000000-0000-4000-8000-000000000001",
      nodeIds: ["fixture-frame"],
      warnings: [],
    }),
  );
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://localhost:${server.address().port}`;
let context;
try {
  execFileSync("bun", ["run", "--cwd", "apps/extension", "build", "--mode", "development"], {
    cwd: repo,
    env: { ...process.env, WXT_BELLA_URL: origin },
    stdio: "pipe",
  });
  const extension = path.join(repo, "apps/extension/.output/chrome-mv3-dev");
  context = await chromium.launchPersistentContext(profile, {
    headless: true,
    channel: "chromium",
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
  const id = new URL(worker.url()).host;
  const cdp = await context.browser().newBrowserCDPSession();
  const pending = new Map();
  let packetId = 0;
  cdp.on("Target.receivedMessageFromTarget", ({ sessionId, message }) => {
    const packet = JSON.parse(message);
    const key = `${sessionId}:${packet.id}`;
    const request = pending.get(key);
    if (!request) return;
    clearTimeout(request.timer);
    pending.delete(key);
    if (packet.error || packet.result?.exceptionDetails)
      request.reject(new Error(JSON.stringify(packet.error ?? packet.result.exceptionDetails)));
    else request.resolve(packet.result.result.value);
  });
  const openPopup = async () => {
    await worker.evaluate(() => chrome.action.openPopup());
    const targets = await cdp.send("Target.getTargets");
    const target = targets.targetInfos.find(
      (target) => target.url === `chrome-extension://${id}/popup.html`,
    );
    assert.ok(target, "Chrome opened the toolbar popup");
    const { sessionId } = await cdp.send("Target.attachToTarget", { targetId: target.targetId });
    const evaluate = (fn, value) =>
      new Promise((resolve, reject) => {
        const id = ++packetId;
        const key = `${sessionId}:${id}`;
        const timer = setTimeout(() => {
          pending.delete(key);
          reject(new Error("Popup evaluation timed out"));
        }, 10000);
        pending.set(key, { resolve, reject, timer });
        cdp
          .send("Target.sendMessageToTarget", {
            sessionId,
            message: JSON.stringify({
              id,
              method: "Runtime.evaluate",
              params: {
                expression: `(${fn.toString()})(${JSON.stringify(value) ?? "undefined"})`,
                awaitPromise: true,
                returnByValue: true,
              },
            }),
          })
          .catch(reject);
      });
    await evaluate(
      () =>
        new Promise((resolve) => {
          if (document.readyState === "complete") resolve(true);
          else window.addEventListener("load", () => resolve(true), { once: true });
        }),
    );
    return { evaluate, targetId: target.targetId };
  };
  let popup = await openPopup();
  const send = (message) =>
    popup.evaluate((message) => chrome.runtime.sendMessage(message), message);
  assert.match((await send({ type: "bella:account" })).error, /Sign in/);
  await cdp.send("Target.closeTarget", { targetId: popup.targetId });
  const source = await context.newPage();
  await source.goto(`${origin}/login`);
  assert.ok(
    !(await source.evaluate(() => document.cookie)).includes("fixture_session"),
    "Session is HttpOnly",
  );
  popup = await openPopup();
  assert.equal((await send({ type: "bella:account" })).data.user.id, "fixture-user");
  await cdp.send("Target.closeTarget", { targetId: popup.targetId });
  await source.goto(`${origin}/source`);
  await source.bringToFront();
  popup = await openPopup();
  const reply = await send({
    type: "bella:start",
    mode: "page",
    destination: { userId: "fixture-user", organizationId: "fixture-org" },
  });
  assert.ok(reply.data, reply.error);
  const job = await popup.evaluate(async () => (await chrome.storage.session.get("job")).job);
  assert.equal(job.state, "done", job.error);
  assert.equal(imports.length, 1);
  assert.equal(imports[0].headers.origin, `chrome-extension://${id}`);
  assert.equal(imports[0].headers["x-tidy-extension"], "1");
  assert.ok(imports[0].headers.cookie.includes("fixture_session=opaque"));
  assert.ok(
    imports[0].body.capture.document.nodes.some((node) => node.text === "Public website design"),
  );
  assert.ok(!JSON.stringify(imports[0].body).includes("fixture_session"));
  await context.clearCookies();
  assert.match((await send({ type: "bella:account" })).error, /Sign in/);
  console.log(
    "Real-extension cookie authentication, document capture, import transport and sign-out passed. No account writes.",
  );
} finally {
  await context?.close();
  await new Promise((resolve) => server.close(resolve));
}
