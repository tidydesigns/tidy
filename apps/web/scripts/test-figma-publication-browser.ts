import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { cp, mkdir, mkdtemp, open, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { chromium, type Browser } from "playwright";
import { verifiedTestAccount } from "./fixtures/verified-test-account.mjs";

// Owns a disposable loopback database; never consumes the application's env file.
const root = fileURLToPath(new URL("../../../", import.meta.url));
const app = join(root, "apps/web"),
  standalone = join(app, ".next/standalone/apps/web");
const directory = await mkdtemp(join(tmpdir(), "tidy-figma-publication-"));
const data = join(directory, "postgres");
const artifacts = process.env.FIGMA_TEST_ARTIFACTS ?? "/tmp/tidy-figma-publication-browser";
await mkdir(artifacts, { recursive: true });
let started = false,
  server: ChildProcess | undefined,
  browser: Browser | undefined,
  client: pg.Client | undefined;
function run(command: string, args: string[], env?: NodeJS.ProcessEnv) {
  const result = spawnSync(command, args, { cwd: root, stdio: "ignore", ...(env ? { env } : {}) });
  if (result.error || result.status !== 0) throw new Error(`${command} failed (${result.status}).`);
}
async function port() {
  const socket = createServer();
  await new Promise<void>((resolve, reject) => {
    socket.once("error", reject);
    socket.listen(0, "127.0.0.1", resolve);
  });
  const value = (socket.address() as { port: number }).port;
  await new Promise<void>((resolve) => socket.close(() => resolve()));
  return value;
}
try {
  assert(
    !(await readdir(standalone)).some((name) => name.startsWith(".env")),
    "Remove traced environment files from the disposable standalone build first.",
  );
  const databasePort = await port(),
    webPort = await port(),
    base = `http://localhost:${webPort}`;
  run("initdb", ["-D", data, "--auth=trust", "--username=tidy_test", "--no-instructions"]);
  run("pg_ctl", [
    "-D",
    data,
    "-l",
    join(directory, "postgres.log"),
    "-o",
    `-h 127.0.0.1 -p ${databasePort} -k ${directory}`,
    "-w",
    "start",
  ]);
  started = true;
  run("createdb", [
    "-h",
    "127.0.0.1",
    "-p",
    String(databasePort),
    "-U",
    "tidy_test",
    "tidy_figma_browser_test",
  ]);
  const database = `postgres://tidy_test@127.0.0.1:${databasePort}/tidy_figma_browser_test`;
  const env = Object.fromEntries(
    ["PATH", "HOME", "TMPDIR", "LANG", "LD_LIBRARY_PATH"].flatMap((key) =>
      process.env[key] ? [[key, process.env[key]]] : [],
    ),
  ) as NodeJS.ProcessEnv;
  Object.assign(env, {
    NODE_ENV: "production",
    DATABASE_URL: database,
    BETTER_AUTH_URL: base,
    BETTER_AUTH_SECRET: "disposable-figma-browser-secret-at-least-32-characters",
    NEXT_TELEMETRY_DISABLED: "1",
    POSTHOG_TRACING_ENABLED: "0",
  });
  run("node", ["apps/web/scripts/setup-multiplayer-local.mjs"], {
    ...env,
    MULTIPLAYER_TEST_DATABASE_URL: database,
  });
  client = new pg.Client({ connectionString: database });
  await client.connect();
  const password = "disposable-figma-fixture-password";
  const owner = await verifiedTestAccount(client, {
    name: "Importer",
    email: "importer@example.test",
    password,
  });
  await client.query(
    `insert into "organization" ("id","name","slug","createdAt","createdByUserId") values ('figma-fixture','Figma fixture','figma-fixture',now(),$1)`,
    [owner],
  );
  await client.query(
    `insert into "member" ("id","organizationId","userId","role","createdAt") values ('fixture-owner','figma-fixture',$1,'owner',now())`,
    [owner],
  );
  await cp(join(app, "public"), join(standalone, "public"), { recursive: true });
  await cp(join(app, ".next/static"), join(standalone, ".next/static"), { recursive: true });
  const log = await open(join(artifacts, "server.log"), "w");
  server = spawn("node", [join(standalone, "server.js")], {
    cwd: standalone,
    env: { ...env, PORT: String(webPort), HOSTNAME: "localhost" },
    stdio: ["ignore", log.fd, log.fd],
  });
  await log.close();
  let ready = false;
  for (let attempt = 0; attempt < 120; attempt++) {
    try {
      if ((await fetch(`${base}/login`)).ok) {
        ready = true;
        break;
      }
    } catch {
      /* Starting. */
    }
    if (server.exitCode !== null) throw new Error("Fixture server exited. Inspect its local log.");
    await delay(250);
  }
  assert(ready, "Fixture server starts");
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1600, height: 1050 },
    permissions: ["clipboard-read", "clipboard-write"],
  });
  const page = await context.newPage(),
    errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("response", async (response) => {
    if (
      response.request().method() === "POST" &&
      response.url().endsWith("/changes") &&
      response.status() >= 400
    )
      console.log(
        JSON.stringify({
          editStatus: response.status(),
          error: (await response.text()).slice(0, 300),
        }),
      );
  });
  await page.route("**/__analytics/**", (route) =>
    route.fulfill({ contentType: "application/json", body: "{}" }),
  );
  // Build-time analytics use a local fixture hostname; intercept that origin too.
  await page.route("http://127.0.0.1:3058/**", (route) =>
    route.fulfill({ contentType: "application/json", body: "{}" }),
  );
  await page.goto(`${base}/login`);
  const login = await page.evaluate(async (password) => {
    const response = await fetch("/api/auth/sign-in/email", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "importer@example.test", password }),
    });
    return { status: response.status, body: await response.text() };
  }, password);
  assert.equal(login.status, 200, login.body);
  const active = await page.evaluate(async () => {
    const response = await fetch("/api/auth/organization/set-active", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ organizationId: "figma-fixture" }),
    });
    return { status: response.status, body: await response.text() };
  });
  assert.equal(active.status, 200, active.body);
  await page.goto(`${base}/files`);
  await page.getByRole("button", { name: "Import Figma", exact: true }).waitFor();
  await page.waitForFunction(() => {
    const input = document.querySelector('[aria-label="Import Figma file"]');
    return input && Object.keys(input).some((key) => key.startsWith("__reactProps"));
  });
  const path =
    process.env.FIGMA_TEST_FILE ??
    fileURLToPath(new URL("./fixtures/figma/circle.fig", import.meta.url));
  const responsePromise = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/figma/import") && response.request().method() === "POST",
    { timeout: 120_000 },
  );
  const start = performance.now();
  await page.getByLabel("Import Figma file").setInputFiles({
    name: "Design System.fig",
    mimeType: "application/octet-stream",
    buffer: await readFile(path),
  });
  if (process.env.FIGMA_TEST_FILE)
    await page
      .getByRole("dialog", { name: "Choose Figma pages" })
      .getByRole("button", { name: "Import pages", exact: true })
      .click();
  const response = await responsePromise;
  assert.equal(response.status(), 200, await response.text());
  const { fileId } = (await response.json()) as { fileId: string };
  await page.waitForURL(`${base}/files/${fileId}`);
  await page.locator("[data-node-id]").first().waitFor({ timeout: 60_000 });
  const record = (
    await client.query('select "content" from "designDocument" where "fileId"=$1', [fileId])
  ).rows[0].content;
  assert.equal(record.pages.length, process.env.FIGMA_TEST_FILE ? 3 : 1);
  assert(record.nodes.length > (process.env.FIGMA_TEST_FILE ? 5000 : 1));
  const expected = record.nodes.length;
  const importToCanvasMs = Math.round(performance.now() - start);
  const reloadStart = performance.now();
  await page.reload();
  await page.locator("[data-node-id]").first().waitFor();
  const saved = (
    await client.query('select "content" from "designDocument" where "fileId"=$1', [fileId])
  ).rows[0].content;
  assert.equal(saved.nodes.length, expected, "Reload retains imported native layers");
  await page.screenshot({ path: join(artifacts, "published.png") });
  console.log(
    JSON.stringify({
      importToCanvasMs,
      reloadMs: Math.round(performance.now() - reloadStart),
      pages: record.pages.length,
      nodes: expected,
    }),
  );
  if (process.env.FIGMA_TEST_FILE) {
    const fitCount = await page.locator("[data-node-id]").count();
    await page.getByRole("button", { name: /^Zoom \d+%$/ }).click();
    await page.getByRole("menuitem", { name: "Zoom to 100%", exact: false }).click();
    await page.waitForFunction(
      (before) => document.querySelectorAll("[data-node-id]").length < before,
      fitCount,
    );
    const mounted = await page.locator("[data-node-id]").count();
    const canvas = page.locator(".bg-canvas > div > .absolute.left-0.top-0");
    const before = await canvas.getAttribute("style");
    await page.evaluate(() => {
      const intervals: number[] = [];
      let last = performance.now(),
        frame = 0;
      const tick = (time: number) => {
        intervals.push(time - last);
        last = time;
        frame = requestAnimationFrame(tick);
      };
      frame = requestAnimationFrame(tick);
      (window as Window & { stopFigmaFrames?: () => number[] }).stopFigmaFrames = () => {
        cancelAnimationFrame(frame);
        return intervals.slice(1);
      };
    });
    await page.getByRole("button", { name: /^Hand/ }).click();
    await page.mouse.move(1000, 500);
    await page.mouse.down();
    for (let i = 0; i < 30; i++) {
      await page.mouse.move(1000 - i * 6, 500 - i * 2);
      await delay(16);
    }
    await page.mouse.up();
    assert.notEqual(await canvas.getAttribute("style"), before, "Measured action pans the canvas");
    const frames = await page.evaluate(() =>
      (window as Window & { stopFigmaFrames?: () => number[] }).stopFigmaFrames!(),
    );
    frames.sort((a, b) => a - b);
    console.log(
      JSON.stringify({
        fitMounted: fitCount,
        mounted,
        panSamples: frames.length,
        panP95Ms: frames[Math.floor(frames.length * 0.95)],
      }),
    );
  }
  const html = await readFile(
    new URL("./fixtures/figma/group.clipboard.html", import.meta.url),
    "utf8",
  );
  await page.waitForFunction(() => {
    const node = document.querySelector("[data-node-id]");
    return node && Object.keys(node).some((key) => key.startsWith("__reactProps"));
  });
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  await page.evaluate(async (html) => {
    await navigator.clipboard.write([
      new ClipboardItem({ "text/html": new Blob([html], { type: "text/html" }) }),
    ]);
  }, html);
  await page.keyboard.press("Control+v");
  async function persistedCount(expectedCount: number) {
    for (let attempt = 0; attempt < 120; attempt++) {
      const saved = (
        await client!.query(
          'select jsonb_array_length("content"->\'nodes\') as count from "designDocument" where "fileId"=$1',
          [fileId],
        )
      ).rows[0];
      if (saved.count === expectedCount) return;
      await delay(100);
    }
    await page.screenshot({ path: join(artifacts, "paste-failed.png") });
    console.log(
      JSON.stringify({
        errors,
        alerts: await page.getByRole("alert").allTextContents(),
        active: await page.evaluate(() => document.activeElement?.tagName),
      }),
    );
    throw new Error(`Pasted layers did not persist (${expectedCount} expected).`);
  }
  await persistedCount(expected + 4);
  await page.keyboard.press("Control+z");
  await persistedCount(expected);
  await page.keyboard.press("Control+Shift+z");
  await persistedCount(expected + 4);
  await page.reload();
  await page.locator("[data-node-id]").first().waitFor();
  await persistedCount(expected + 4);
  console.log(
    "PASS: native Figma paste, undo and redo persist through the authenticated editor and reload",
  );
  const outsider = await browser.newContext();
  const denied = await outsider.request.post(`${base}/api/figma/import`, {
    headers: { Origin: base },
    data: { name: "Denied", document: record, assets: [] },
  });
  assert.equal(denied.status(), 401);
  const originDenied = await context.request.post(`${base}/api/figma/import`, {
    headers: { Origin: "https://foreign.example.test" },
    data: {},
  });
  assert.equal(originDenied.status(), 403);
  assert.deepEqual(errors, []);
  console.log(
    "PASS: authenticated production-browser import, publication, navigation, reload and access checks",
  );
} finally {
  await browser?.close();
  server?.kill("SIGTERM");
  if (server && server.exitCode === null)
    await new Promise<void>((resolve) => {
      server!.once("exit", () => resolve());
      setTimeout(resolve, 5000);
    });
  await client?.end();
  if (started) run("pg_ctl", ["-D", data, "-m", "immediate", "-w", "stop"]);
  await rm(directory, { recursive: true, force: true });
}
