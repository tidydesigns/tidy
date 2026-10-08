// Bun + an isolated browser. Every fixture API/socket request is intercepted.
import assert from "node:assert/strict";
import { buildLoginDocument } from "../lib/design/examples/login";
import { applyDocumentPatch, diffDocument } from "../lib/design/document-patch";
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const base = process.env.EDITOR_TEST_URL || "http://127.0.0.1:3107";
const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    ignoreHTTPSErrors: true,
  });
  const document = buildLoginDocument("00000000-0000-4000-8000-000000000001");
  const paint = {
    id: "test-gradient",
    type: "linear",
    visible: true,
    opacity: 1,
    angle: 90,
    stops: [
      { id: "a", position: 0, color: "#ff0000" },
      { id: "b", position: 1, color: "#0000ff" },
    ],
  };
  let snapshot = {
    revision: 1,
    content: {
      ...document,
      nodes: document.nodes.map((node) =>
        node.id === "desktop-screen"
          ? {
              ...node,
              box: { ...node.box, width: 600, height: 400 },
              style: { ...node.style, paints: [paint] },
            }
          : node,
      ),
    },
  };
  let socket,
    sequence = 0,
    release,
    resolveRequest,
    request;
  const pending = new Promise((resolve) => (resolveRequest = resolve)),
    gate = new Promise((resolve) => (release = resolve));
  await context.routeWebSocket(`${base.replace(/^http/, "ws")}/gradient-room`, (ws) => {
    socket = ws;
    ws.send(JSON.stringify({ type: "ready" }));
  });
  await context.route("**/api/files/preview/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const json = (body) => route.fulfill({ json: body });
    if (path.endsWith("presence-ticket"))
      return json({
        url: `${base.replace(/^http/, "ws")}/gradient-room`,
        expiresAt: Date.now() + 600_000,
        sessionId: "gradient-session",
      });
    if (!path.endsWith("changes")) return json({ comments: [], threads: [] });
    if (route.request().method() === "GET")
      return json({ snapshot, name: "Gradient fixture", sequence });
    request = route.request().postDataJSON();
    resolveRequest();
    await gate;
    const content = applyDocumentPatch(snapshot.content, request.patch, request.conditional),
      patch = diffDocument(snapshot.content, content);
    snapshot = { revision: snapshot.revision + 1, content };
    sequence++;
    return json({ patch, snapshot, sequence });
  });
  const page = await context.newPage(),
    errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${base}/dev/import-preview?edit=1&realtime=1`);
  await page.getByRole("button", { name: "Select Desktop 1440 · /login", exact: true }).click();
  await page.getByRole("button", { name: "Edit gradient", exact: true }).click();
  const endpoint = await page
    .getByRole("button", { name: "Gradient end", exact: true })
    .boundingBox();
  await page.mouse.move(endpoint.x + endpoint.width / 2, endpoint.y + endpoint.height / 2);
  await page.mouse.down();
  await page.mouse.move(endpoint.x + endpoint.width / 2 - 40, endpoint.y + endpoint.height / 2, {
    steps: 5,
  });
  assert.equal(
    await page.locator('[data-node-id="desktop-screen"] > [data-fill-stack]').count(),
    1,
  );
  // A remote color/opacity edit arrives while the local endpoint preview is captured.
  snapshot = {
    revision: snapshot.revision + 1,
    content: {
      ...snapshot.content,
      nodes: snapshot.content.nodes.map((node) =>
        node.id === "desktop-screen"
          ? {
              ...node,
              style: {
                ...node.style,
                paints: [
                  {
                    ...paint,
                    opacity: 0.7,
                    stops: paint.stops.map((stop) =>
                      stop.id === "b" ? { ...stop, color: "#00ff00" } : stop,
                    ),
                  },
                ],
              },
            }
          : node,
      ),
    },
  };
  sequence++;
  socket.send(JSON.stringify({ type: "events", events: [{ sequence, kind: "document" }] }));
  await page.waitForFunction(() => {
    const fill = document.querySelector(
      '[data-node-id="desktop-screen"] > [data-fill-stack] > [data-fill-id]',
    );
    return fill?.style.opacity === "0.7" && fill.style.background.includes("rgb(0, 255, 0)");
  });
  const beforeRelease = await page
    .locator('[data-node-id="desktop-screen"] > [data-fill-stack] > [data-fill-id]')
    .evaluate((element) => element.style.background);
  assert.ok(
    !beforeRelease.includes("100%"),
    "The local endpoint preview survives the incoming color edit.",
  );
  await page.mouse.up();
  await pending;
  await page.getByRole("button", { name: "Select Welcome heading", exact: true }).first().click();
  const acknowledgment = page.waitForResponse(
    (response) => response.url().endsWith("/changes") && response.request().method() === "POST",
  );
  release();
  // Reopen waits for the transport acknowledgment, then reads stored fixture state.
  await acknowledgment;
  const stored = snapshot.content.nodes.find((node) => node.id === "desktop-screen").style
    .paints[0];
  assert.equal(stored.opacity, 0.7);
  assert.equal(stored.stops[1].color, "#00ff00");
  assert.ok(stored.end.x < 1);
  assert.equal(
    await page.getByRole("combobox", { name: "Font family", exact: true }).count(),
    1,
    "Acknowledgment retains the later selection.",
  );
  await page.reload();
  await page.getByRole("button", { name: "Select Desktop 1440 · /login", exact: true }).click();
  assert.equal(
    await page
      .locator('[data-node-id="desktop-screen"] > [data-fill-stack] > [data-fill-id]')
      .evaluate((element) => element.style.background),
    beforeRelease,
  );
  assert.deepEqual(errors, []);
  console.log(
    "PASS: concurrent remote color/opacity preserves captured gradient geometry, commit merges current paint, delayed acknowledgment retains later selection, and fixture reopen retains endpoints; no database writes or page errors",
  );
} finally {
  await browser.close();
}
