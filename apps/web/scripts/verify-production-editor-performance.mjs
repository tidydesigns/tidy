// Authenticated production-build benchmark using disposable local fixtures.
import assert from "node:assert/strict";
import { chromium } from "playwright";
import pg from "pg";
const base = process.env.MULTIPLAYER_TEST_BASE_URL || "http://localhost:3107";
const url = process.env.MULTIPLAYER_TEST_DATABASE_URL;
if (
  !["localhost", "127.0.0.1"].includes(new URL(base).hostname) ||
  !url ||
  !["localhost", "127.0.0.1"].includes(new URL(url).hostname)
)
  throw new Error("Use a disposable localhost database and local production app.");
const client = new pg.Client({ connectionString: url });
await client.connect();
const browser = await chromium.launch({ headless: true });
const organization = `production-perf-${crypto.randomUUID()}`;
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const signedIn = await context.request.post(`${base}/api/auth/sign-in/email`, {
    data: { email: "owner@example.com", password: "local-test-password-123" },
    headers: { Origin: base },
  });
  assert.equal(signedIn.status(), 200, "Initialize local users with the multiplayer suite first.");
  const user = (
    await client.query('select "id" from "user" where "email"=$1', ["owner@example.com"])
  ).rows[0].id;
  await client.query(
    'insert into "organization" ("id","name","slug","createdAt") values ($1,$1,$1,now())',
    [organization],
  );
  await client.query(
    'insert into "member" ("id","organizationId","userId","role","createdAt") values ($1,$1,$2,\'owner\',now())',
    [organization, user],
  );
  for (const count of [100, 1000, 5000]) {
    const fileId = `${organization}-${count}`;
    const nodes = Array.from({ length: count }, (_, i) => {
      const root = i % 100 === 0,
        text = !root && i % 3 === 0,
        frame = Math.floor(i / 100);
      return {
        id: `node-${i}`,
        name: `Layer ${i}`,
        type: root ? "artboard" : text ? "text" : "container",
        parentId: root ? null : `node-${frame * 100}`,
        box: root
          ? { x: frame * 900, y: 0, width: 800, height: 700 }
          : { x: (i % 8) * 90 + 20, y: Math.floor((i % 100) / 8) * 45 + 20, width: 80, height: 32 },
        visible: true,
        locked: false,
        layout: "absolute",
        style: text
          ? { fontFamily: "system-ui", fontSize: 12, color: "#222222" }
          : { fill: root ? "#f3f1ef" : "#dc8eb1" },
        ...(text ? { text: `Text ${i}` } : {}),
      };
    });
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
    await client.query(
      'insert into "designFile" ("id","organizationId","name","createdBy") values ($1,$2,$3,$4)',
      [fileId, organization, `${count} layers`, user],
    );
    await client.query('insert into "designDocument" ("fileId","content") values ($1,$2::jsonb)', [
      fileId,
      JSON.stringify(content),
    ]);
    const page = await context.newPage(),
      errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const cdp = await context.newCDPSession(page);
    await cdp.send("Emulation.setCPUThrottlingRate", {
      rate: Number(process.env.EDITOR_CPU_THROTTLE || 4),
    });
    const started = performance.now(),
      response = await page.goto(`${base}/files/${fileId}`);
    assert.equal(response.status(), 200);
    const canvas = page.getByLabel("Design canvas", { exact: true });
    await canvas.waitFor();
    await canvas.focus();
    await page.keyboard.press("Shift+0");
    await page.getByRole("button", { name: "Select Layer 0", exact: true }).click();
    await page.getByRole("textbox", { name: "Layer name", exact: true }).waitFor();
    const readyMs = Math.round(performance.now() - started);
    const rows = await page
      .getByRole("tree", { name: "Layers", exact: true })
      .getByRole("treeitem")
      .count();
    const mounted = await page.locator("[data-node-id]").count();
    assert.ok(mounted <= 300);
    assert.ok(rows <= 100);
    const frames = await page.evaluate(async () => {
      const canvas = document.querySelector('[aria-label="Design canvas"]'),
        times = [];
      for (let i = 0; i < 30; i++) {
        const start = performance.now();
        canvas.dispatchEvent(
          new WheelEvent("wheel", { deltaX: 2, deltaY: 1, bubbles: true, cancelable: true }),
        );
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        times.push(performance.now() - start);
      }
      return times.sort((a, b) => a - b);
    });
    assert.deepEqual(errors, []);
    console.log(
      JSON.stringify({
        nodes: count,
        cpuThrottle: Number(process.env.EDITOR_CPU_THROTTLE || 4),
        firstSelectionMs: readyMs,
        mountedNodes: mounted,
        layerRows: rows,
        panTwoFramesP95Ms: Math.round(frames[Math.ceil(frames.length * 0.95) - 1]),
        htmlBytes: Buffer.byteLength(await response.text()),
      }),
    );
    await page.close();
  }
} finally {
  await browser.close();
  await client.query('delete from "organization" where "id"=$1', [organization]);
  await client.end();
}
