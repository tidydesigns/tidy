// Production Next router regression test against an owned disposable Postgres
// cluster. Runtime environment files and production credentials are excluded.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { mkdtemp, mkdir, cp, rm, open, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { chromium } from "playwright";
import { verifiedTestAccount } from "./fixtures/verified-test-account.mjs";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const app = join(root, "apps/web");
const temporary = await mkdtemp(join(tmpdir(), "tidy-navigation-browser-"));
const data = join(temporary, "postgres");
const artifact = join(root, ".artifacts/navigation");
await mkdir(artifact, { recursive: true });
let started = false,
  server,
  flagServer,
  browser,
  client,
  blocker,
  release;
const command = (name, args, options = {}) => {
  const result = spawnSync(name, args, { cwd: root, stdio: "ignore", ...options });
  assert.equal(result.status, 0, `${name} failed (${result.status}).`);
};
const port = async () => {
  const socket = createServer();
  await new Promise((resolve, reject) => {
    socket.once("error", reject);
    socket.listen(0, "127.0.0.1", resolve);
  });
  const value = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  return value;
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
try {
  const databasePort = await port(),
    webPort = await port();
  const base = `http://127.0.0.1:${webPort}`;
  const testVault = process.env.NAVIGATION_VAULT === "1";
  let flagHost = "";
  if (testVault) {
    const flagPort = Number(process.env.NAVIGATION_VAULT_PORT);
    assert(
      Number.isInteger(flagPort) && flagPort > 0 && flagPort < 65536,
      "Build with a loopback PostHog host and set its port in NAVIGATION_VAULT_PORT for the Vault fixture.",
    );
    flagHost = `http://127.0.0.1:${flagPort}`;
    flagServer = createHttpServer((request, response) => {
      request.resume();
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify(
          request.url.startsWith("/flags") ? { featureFlags: { vault: true } } : { status: 1 },
        ),
      );
    });
    await new Promise((resolve) => flagServer.listen(flagPort, "127.0.0.1", resolve));
  }
  command("initdb", ["-D", data, "--auth=trust", "--username=tidy_test", "--no-instructions"]);
  command("pg_ctl", [
    "-D",
    data,
    "-l",
    join(temporary, "postgres.log"),
    "-o",
    `-h 127.0.0.1 -p ${databasePort} -k ${temporary}`,
    "-w",
    "start",
  ]);
  started = true;
  command("createdb", [
    "-h",
    "127.0.0.1",
    "-p",
    String(databasePort),
    "-U",
    "tidy_test",
    "tidy_navigation_browser",
  ]);
  const database = `postgres://tidy_test@127.0.0.1:${databasePort}/tidy_navigation_browser`;
  const env = Object.fromEntries(
    ["PATH", "HOME", "TMPDIR", "LANG"].flatMap((key) =>
      process.env[key] ? [[key, process.env[key]]] : [],
    ),
  );
  Object.assign(env, {
    NODE_ENV: "production",
    DATABASE_URL: database,
    NEXT_TELEMETRY_DISABLED: "1",
    BETTER_AUTH_URL: base,
    BETTER_AUTH_SECRET: "local-navigation-auth-secret-at-least-32-characters",
    NEXT_PUBLIC_POSTHOG_KEY: testVault ? "local-vault-test-key" : "",
    NEXT_PUBLIC_POSTHOG_HOST: flagHost,
    TIDY_AGENTS_ENABLED: "true",
  });
  command("node", ["apps/web/scripts/setup-multiplayer-local.mjs"], {
    env: { ...env, MULTIPLAYER_TEST_DATABASE_URL: database },
  });
  // Standalone output can include .env.local from a normal developer build.
  // Copy the generated runtime to a clean directory, excluding every env file.
  const runtime = join(temporary, "runtime");
  await cp(join(app, ".next/standalone"), runtime, {
    recursive: true,
    filter: (path) => !basename(path).startsWith(".env"),
  });
  const standalone = join(runtime, "apps/web");
  await cp(join(app, "public"), join(standalone, "public"), { recursive: true });
  await cp(join(app, ".next/static"), join(standalone, ".next/static"), { recursive: true });
  const isolation = join(temporary, "isolate-network.mjs");
  await writeFile(
    isolation,
    `
    const allowed = new Set(${JSON.stringify([base, ...(flagHost ? [flagHost] : [])])});
    const fetchFixture = globalThis.fetch;
    globalThis.fetch = (input, init) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      if (!allowed.has(url.origin)) return Promise.reject(new Error("External fixture network request blocked."));
      return fetchFixture(input, init);
    };
  `,
  );
  const log = await open(join(artifact, "server.log"), "w");
  server = spawn("node", ["--import", isolation, join(standalone, "server.js")], {
    cwd: standalone,
    env: { ...env, PORT: String(webPort), HOSTNAME: "127.0.0.1" },
    stdio: ["ignore", log.fd, log.fd],
  });
  await log.close();
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${base}/login`)).ok) {
        ready = true;
        break;
      }
    } catch {
      /* startup */
    }
    await sleep(100);
  }
  assert(ready, "Local production server did not start. See .artifacts/navigation/server.log.");
  client = new pg.Client({ connectionString: database });
  await client.connect();
  await client.query('update "billingDeployment" set "selfHosted"=true');
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  // Built client analytics may contain public deployment configuration. Browser
  // fixtures never send data outside this local application.
  await context.route(
    (url) => url.origin !== base,
    (route) => route.abort(),
  );
  const password = "local-fixture-password-123",
    email = "owner@example.com";
  const user = await verifiedTestAccount(client, { name: "Owner", email, password });
  const signin = await context.request.post(`${base}/api/auth/sign-in/email`, {
    headers: { Origin: base },
    data: { email, password },
  });
  assert.equal(signin.status(), 200, "Verified fixture sign-in failed.");
  const firstOrg = crypto.randomUUID(),
    secondOrg = crypto.randomUUID(),
    folder = crypto.randomUUID(),
    streamingFolder = crypto.randomUUID(),
    file = crypto.randomUUID();
  for (const [id, name] of [
    [firstOrg, "First workspace"],
    [secondOrg, "Second workspace"],
  ]) {
    await client.query(
      'insert into "organization" ("id","name","slug","createdAt","createdByUserId") values ($1,$2,$1,now(),$3)',
      [id, name, user],
    );
    await client.query(
      'insert into "member" ("id","organizationId","userId","role","createdAt") values ($1,$2,$3,\'owner\',now())',
      [crypto.randomUUID(), id, user],
    );
  }
  await client.query(
    'insert into "designFolder" ("id","organizationId","name","createdBy") values ($1,$2,\'Fixture folder\',$3)',
    [folder, firstOrg, user],
  );
  await client.query(
    'insert into "designFolder" ("id","organizationId","name","createdBy") values ($1,$2,\'Streaming folder\',$3)',
    [streamingFolder, firstOrg, user],
  );
  await client.query(
    'insert into "designFile" ("id","organizationId","name","createdBy","folderId") values ($1,$2,\'Fixture file\',$3,$4)',
    [file, firstOrg, user, folder],
  );
  const active = await context.request.post(`${base}/api/auth/organization/set-active`, {
    headers: { Origin: base },
    data: { organizationId: firstOrg },
  });
  assert.equal(active.status(), 200);
  const page = await context.newPage();
  const errors = [],
    documents = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    if (request.isNavigationRequest() && request.frame() === page.mainFrame())
      documents.push(request.url());
  });
  await page.goto(`${base}/files`);
  await page.getByRole("heading", { name: "Files", exact: true }).waitFor();
  await page.evaluate(() => {
    window.__navigationDocument = "original";
    document.querySelector("aside").dataset.navigationIdentity = "persistent";
  });
  const initialDocuments = documents.length;
  const sameDocument = async () => {
    assert.equal(
      await page.evaluate(() => window.__navigationDocument),
      "original",
      "Navigation reloaded the document.",
    );
    assert.equal(
      documents.length,
      initialDocuments,
      "Internal navigation issued a document request.",
    );
  };
  const persistentSidebar = async () => {
    await sameDocument();
    assert.equal(
      await page.locator("aside").getAttribute("data-navigation-identity"),
      "persistent",
      "The sidebar remounted.",
    );
  };
  const navigate = async (label, path) => {
    await page
      .getByRole("navigation", { name: "Workspace" })
      .getByRole("link", { name: label, exact: true })
      .click();
    await page.waitForURL(`${base}${path}`);
    await page
      .getByRole("navigation", { name: "Workspace" })
      .locator('[aria-current="page"]')
      .filter({ hasText: label })
      .waitFor();
    await persistentSidebar();
  };
  await navigate("Archive", "/files?view=archive");
  await page.getByRole("heading", { name: "Archive", exact: true }).waitFor();
  // Archived documents remain viewable without opening live editing endpoints or
  // mutating a legacy file just to display it. Run in another tab to preserve the
  // navigation identity/history checks below.
  const archivedPage = await context.newPage();
  archivedPage.on("pageerror", (error) => errors.push(error.message));
  for (const converted of [false, true]) {
    const archivedFile = crypto.randomUUID();
    const nodeId = crypto.randomUUID();
    await client.query(
      `insert into "designFile" ("id", "organizationId", "name", "createdBy") values ($1,$2,'Archived fixture',$3)`,
      [archivedFile, firstOrg, user],
    );
    await client.query(
      `insert into "designRectangle" ("id", "fileId", "x", "y", "width", "height") values ($1,$2,20,20,160,120)`,
      [nodeId, archivedFile],
    );
    if (converted) {
      await archivedPage.goto(`${base}/files/${archivedFile}`);
      await archivedPage.locator(`[data-node-id="${nodeId}"]`).waitFor();
    }
    await client.query(`update "designFile" set "archivedAt" = now() where "id" = $1`, [
      archivedFile,
    ]);
    const before = await client.query(
      `select "revision", "content" from "designDocument" where "fileId" = $1`,
      [archivedFile],
    );
    const archiveRequests = [];
    const recordArchiveRequest = (request) => {
      if (new URL(request.url()).pathname.startsWith(`/api/files/${archivedFile}/`))
        archiveRequests.push(request.url());
    };
    archivedPage.on("request", recordArchiveRequest);
    await archivedPage.goto(`${base}/files/${archivedFile}`);
    await archivedPage.getByText("Archived · Read only", { exact: true }).waitFor();
    await archivedPage.locator(`[data-node-id="${nodeId}"]`).waitFor();
    assert.equal(
      await archivedPage.getByRole("button", { name: "Rectangle tool", exact: true }).count(),
      0,
    );
    assert.equal(
      await archivedPage.getByRole("button", { name: "Comment tool", exact: true }).count(),
      0,
    );
    assert.equal(
      await archivedPage.getByRole("link", { name: "Back to files" }).getAttribute("href"),
      "/files?view=archive",
    );
    await archivedPage.keyboard.press("r");
    await archivedPage.keyboard.press("c");
    await sleep(200);
    assert.deepEqual(
      archiveRequests,
      [],
      "Archived snapshots must not connect to live file endpoints.",
    );
    archivedPage.off("request", recordArchiveRequest);
    const denied = await context.request.post(`${base}/api/files/${archivedFile}/changes`, {
      // NextURL normalizes numeric loopback hosts to localhost for route handlers.
      headers: { Origin: base.replace("127.0.0.1", "localhost") },
      data: { operationId: crypto.randomUUID(), patch: [] },
    });
    assert.equal(denied.status(), 404, "Archived files must reject edits even for owners.");
    const after = await client.query(
      `select "revision", "content" from "designDocument" where "fileId" = $1`,
      [archivedFile],
    );
    assert.deepEqual(
      after.rows,
      before.rows,
      "Viewing an archive must not change the stored document.",
    );
    // Archives must retain the same full intent prefetch as active files.
    const warmArchive = await context.newPage();
    warmArchive.on("pageerror", (error) => errors.push(error.message));
    await warmArchive.mouse.move(0, 0);
    await warmArchive.goto(`${base}/files?view=archive`);
    await warmArchive.locator('[data-page-content="files"]').waitFor();
    await warmArchive.evaluate(() => {
      window.__archiveDocument = true;
    });
    const prepared = warmArchive.waitForResponse((response) => {
      const url = new URL(response.url());
      return (
        url.pathname === `/files/${archivedFile}` &&
        url.searchParams.has("_rsc") &&
        !response.request().headers()["next-router-prefetch"]
      );
    });
    const archiveLink = warmArchive.getByRole("link", {
      name: "Open Archived fixture",
      exact: true,
    });
    await archiveLink.hover();
    await prepared;
    await sleep(200);
    await warmArchive.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
    const clickRequests = [];
    warmArchive.on("request", (request) => {
      const url = new URL(request.url());
      if (url.pathname === `/files/${archivedFile}` && url.searchParams.has("_rsc"))
        clickRequests.push(request.url());
    });
    const clickStarted = performance.now();
    await archiveLink.click();
    await warmArchive.getByText("Archived · Read only", { exact: true }).waitFor();
    await warmArchive.locator(`[data-node-id="${nodeId}"]`).waitFor();
    assert.deepEqual(clickRequests, [], "Prepared archived file issued a server render on click.");
    assert.equal(
      await warmArchive.evaluate(() => window.__archiveDocument),
      true,
      "Archive navigation reloaded the window.",
    );
    assert.equal(await warmArchive.locator('[data-page-skeleton="editor"]').count(), 0);
    console.log(
      `PASS archived ${converted ? "current" : "legacy"} warm navigation: ${Math.round(performance.now() - clickStarted)}ms, zero click-time RSC requests`,
    );
    await warmArchive.close();
    // A separately authenticated non-member cannot load archived artwork.
    const outsider = await browser.newContext();
    await outsider.route(
      (url) => url.origin !== base,
      (route) => route.abort(),
    );
    const outsiderEmail = `archive-outsider-${archivedFile}@example.com`;
    await verifiedTestAccount(client, { name: "Outsider", email: outsiderEmail, password });
    const outsiderSignIn = await outsider.request.post(`${base}/api/auth/sign-in/email`, {
      headers: { Origin: base },
      data: { email: outsiderEmail, password },
    });
    assert.equal(outsiderSignIn.status(), 200);
    const outsiderPage = await outsider.newPage();
    await outsiderPage.goto(`${base}/files/${archivedFile}`);
    await outsiderPage.getByRole("heading", { name: "404" }).waitFor();
    assert.equal(await outsiderPage.locator(`[data-node-id="${nodeId}"]`).count(), 0);
    await outsider.close();
    // Restoring returns the same document to normal editing.
    await client.query(`update "designFile" set "archivedAt" = null where "id" = $1`, [
      archivedFile,
    ]);
    await archivedPage.goto(`${base}/files/${archivedFile}`);
    await archivedPage.getByRole("button", { name: "Rectangle tool", exact: true }).waitFor();
    await archivedPage.locator(`[data-node-id="${nodeId}"]`).waitFor();
  }
  await archivedPage.close();
  console.log(
    "PASS archived legacy/current documents, read-only access, membership and restored editing",
  );
  await page.goBack();
  await page.getByRole("heading", { name: "Files", exact: true }).waitFor();
  await persistentSidebar();
  await navigate("Settings", "/settings");
  await page.getByRole("heading", { name: "Settings", exact: true }).waitFor();
  await page.getByRole("tab", { name: "Profile", exact: true }).click();
  await page.waitForURL(`${base}/settings`);
  const tabRequests = [];
  const recordTabRequest = (request) => {
    if (new URL(request.url()).searchParams.has("_rsc")) tabRequests.push(request.url());
  };
  page.on("request", recordTabRequest);
  await page.getByLabel("New password", { exact: true }).fill("Retained password draft");
  await page.getByRole("tab", { name: "Members", exact: true }).click();
  await page.goBack();
  assert.equal(
    await page.getByRole("tab", { name: "Profile", exact: true }).getAttribute("aria-selected"),
    "true",
  );
  assert.equal(
    await page.getByLabel("New password", { exact: true }).inputValue(),
    "Retained password draft",
    "Settings discarded the hidden panel's state.",
  );
  assert.equal(tabRequests.length, 0, "Settings tabs requested a server render.");
  page.off("request", recordTabRequest);
  await page.getByRole("tab", { name: "Members", exact: true }).click();
  await page.getByRole("tab", { name: "Profile", exact: true }).click();
  assert.equal(
    await page.getByLabel("New password", { exact: true }).inputValue(),
    "Retained password draft",
  );
  await page.getByRole("tab", { name: "Profile", exact: true }).press("ArrowRight");
  await page.getByRole("heading", { name: "File editor", exact: true }).waitFor();
  console.log(
    "PASS: instant Settings tabs preserve draft input and keyboard navigation without RSC requests.",
  );
  await persistentSidebar();
  await navigate("MCP", "/mcp");
  await page.getByRole("heading", { name: "MCP", exact: true }).waitFor();
  await navigate("Threads", "/threads");
  await page.getByRole("link", { name: "Connect Codex to start a thread" }).waitFor();
  await page.getByRole("link", { name: "Connect Codex to start a thread" }).click();
  await page.waitForURL(`${base}/settings?tab=agents`);
  assert.equal(
    await page.getByRole("tab", { name: "Agents", exact: true }).getAttribute("aria-selected"),
    "true",
  );
  await navigate("Files", "/files");
  console.log("PASS: sidebar persistence, client links and history.");
  if (process.env.NAVIGATION_PERFORMANCE) {
    const timings = [],
      requests = [];
    page.on("request", (request) => {
      if (new URL(request.url()).searchParams.has("_rsc")) requests.push(request.url());
    });
    await page.route(
      (url) => url.searchParams.has("_rsc"),
      async (route) => {
        const response = await route.fetch();
        await sleep(200);
        await route.fulfill({ response });
      },
    );
    for (const [label, path, ready] of [
      ["Settings", "/settings", page.getByRole("heading", { name: "Settings", exact: true })],
      ["MCP", "/mcp", page.getByRole("heading", { name: "MCP", exact: true })],
      ["Threads", "/threads", page.getByRole("link", { name: "Connect Codex to start a thread" })],
      [
        "Archive",
        "/files?view=archive",
        page.getByRole("heading", { name: "Archive", exact: true }),
      ],
      ["Files", "/files", page.getByRole("heading", { name: "Files", exact: true })],
    ]) {
      const started = performance.now(),
        before = requests.length;
      await navigate(label, path);
      await ready.waitFor();
      timings.push({
        route: label,
        readyMs: Math.round(performance.now() - started),
        rscRequests: requests.length - before,
      });
    }
    await page.unrouteAll({ behavior: "wait" });
    await writeFile(
      join(artifact, `${process.env.NAVIGATION_PERFORMANCE}-timings.json`),
      JSON.stringify({ injectedResponseDelayMs: 200, timings }, null, 2),
    );
    console.log(`${process.env.NAVIGATION_PERFORMANCE} navigation: ` + JSON.stringify(timings));
    if (process.env.NAVIGATION_PERFORMANCE !== "baseline") {
      assert(
        timings.every((timing) => timing.rscRequests === 0),
        "Warmed sidebar navigation still waited for the server.",
      );
    }
  }
  // Fresh documents cannot reuse the other page's router cache. Hold a page's
  // database read and compare its fallback to the loaded content at both sizes.
  const boundsOf = (locator) =>
    locator.evaluate((element) => {
      const { x, y, width, height } = element.getBoundingClientRect();
      return { x, y, width, height };
    });
  const coldPage = await context.newPage();
  coldPage.on("pageerror", (error) => errors.push(error.message));
  for (const [path, name, table] of [
    ["/files", "files", "designFolder"],
    ["/files?view=archive", "files", "designFolder"],
    ["/settings", "settings", "invitation"],
    ["/settings?tab=profile", "settings", "invitation"],
    ["/settings?tab=preferences", "settings", "invitation"],
    ["/settings?tab=organization", "settings", "invitation"],
    ["/settings?tab=settings", "settings", "invitation"],
    ["/settings?tab=connectors", "settings", "invitation"],
    ["/settings?tab=agents", "settings", "invitation"],
    ["/mcp", "mcp", "oauthConsent"],
    ["/threads", "threads", "agentThread"],
    ...(testVault ? [["/vault", "vault", "vaultLogin"]] : []),
  ]) {
    blocker = new pg.Client({ connectionString: database });
    await blocker.connect();
    await blocker.query(`begin; lock table "${table}" in access exclusive mode`);
    await coldPage.goto(`${base}${path}`, { waitUntil: "commit" });
    const skeleton = coldPage.locator(`[data-page-skeleton="${name}"]`).filter({ visible: true });
    await skeleton.waitFor();
    const geometry = [];
    const slug = path.replace(/[^a-z0-9]+/gi, "-");
    for (const viewport of [
      { width: 1440, height: 960 },
      { width: 390, height: 844 },
    ]) {
      await coldPage.setViewportSize(viewport);
      geometry.push({
        viewport,
        bounds: await boundsOf(skeleton),
        panel:
          name === "settings"
            ? await boundsOf(
                coldPage.locator("[data-settings-panel-skeleton]").filter({ visible: true }),
              )
            : null,
      });
      assert(
        await coldPage.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
        `${path} loading overflows mobile.`,
      );
      await coldPage.screenshot({ path: join(artifact, `${slug}-loading-${viewport.width}.png`) });
    }
    await blocker.query("rollback");
    await blocker.end();
    blocker = null;
    const content = coldPage.locator(`[data-page-content="${name}"]`);
    await content.waitFor();
    for (const { viewport, bounds, panel } of geometry) {
      await coldPage.setViewportSize(viewport);
      const loaded = await boundsOf(content);
      assert.equal(bounds.x, loaded.x, `${path} loading has a different left edge.`);
      assert.equal(bounds.y, loaded.y, `${path} loading has a different top edge.`);
      assert.equal(bounds.width, loaded.width, `${path} loading is narrower than its content.`);
      if (panel) {
        const loadedPanel = await boundsOf(coldPage.getByRole("tabpanel"));
        assert.equal(
          panel.y,
          loadedPanel.y,
          `${path} loading places its panel at a different height.`,
        );
        assert.equal(
          panel.width,
          loadedPanel.width,
          `${path} loading has a different panel width.`,
        );
      }
      await coldPage.screenshot({ path: join(artifact, `${slug}-loaded-${viewport.width}.png`) });
    }
  }
  await coldPage.close();
  console.log(
    `PASS: cold Files, Archive, Settings tabs, MCP, Threads${testVault ? " and Vault" : ""} fallbacks match page geometry on desktop and mobile.`,
  );

  // Hold the destination response entirely: the clicked link must acknowledge
  // pending navigation even before the browser receives a streaming fallback.
  let intercepted;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const requested = new Promise((resolve) => {
    intercepted = resolve;
  });
  const folderUrl = `${base}/files?folder=${folder}`;
  await page.route(
    (url) =>
      url.pathname === "/files" &&
      url.searchParams.get("folder") === folder &&
      url.searchParams.has("_rsc"),
    async (route) => {
      const response = await route.fetch();
      intercepted();
      await held;
      await route.fulfill({ response });
    },
  );
  await page.getByRole("link", { name: /Fixture folder/ }).click();
  await Promise.race([
    requested,
    sleep(15000).then(() => {
      throw new Error("Folder RSC request was not intercepted.");
    }),
  ]);
  await page.getByRole("status", { name: "Opening page" }).waitFor();
  await persistentSidebar();
  assert(await page.getByRole("navigation", { name: "Workspace" }).isVisible());
  release();
  await page.getByRole("heading", { name: "Fixture folder", exact: true }).waitFor();
  await page.unrouteAll({ behavior: "wait" });
  assert.equal(page.url(), folderUrl);
  await page
    .getByRole("navigation", { name: "Workspace" })
    .getByRole("link", { name: "Files", exact: true })
    .click();
  await page.getByRole("heading", { name: "Files", exact: true }).waitFor();
  blocker = new pg.Client({ connectionString: database });
  await blocker.connect();
  await blocker.query('begin; lock table "designFolder" in access exclusive mode');
  await page.getByRole("link", { name: /Streaming folder/ }).click();
  await page.getByRole("status", { name: "Loading files", exact: true }).waitFor();
  await persistentSidebar();
  const folderSkeletonBounds = await page.locator('[data-page-skeleton="files"]').boundingBox();
  await page.screenshot({ path: join(artifact, "folder-loading.png") });
  await blocker.query("rollback");
  await blocker.end();
  blocker = null;
  await page.getByRole("heading", { name: "Streaming folder", exact: true }).waitFor();
  const folderContentBounds = await page.locator('[data-page-content="files"]').boundingBox();
  assert.equal(folderSkeletonBounds.x, folderContentBounds.x);
  assert.equal(
    folderSkeletonBounds.width,
    folderContentBounds.width,
    "Folder loading was narrower than its content.",
  );
  await page
    .getByRole("navigation", { name: "Workspace" })
    .getByRole("link", { name: "Files", exact: true })
    .click();
  await page.getByRole("heading", { name: "Files", exact: true }).waitFor();
  await page.getByRole("link", { name: /Fixture folder/ }).click();
  await page.getByRole("heading", { name: "Fixture folder", exact: true }).waitFor();

  console.log("PASS: pending feedback and query streaming during a blocked database read.");
  // File entry uses its own editor-shaped fallback, even while its data read is
  // blocked. The root/workspace grid skeleton must not appear in the editor.
  const loadingPage = await context.newPage();
  loadingPage.on("pageerror", (error) => errors.push(error.message));
  blocker = new pg.Client({ connectionString: database });
  await blocker.connect();
  await blocker.query('begin; lock table "designFile" in access exclusive mode');
  await loadingPage.goto(`${base}/files/${file}`, { waitUntil: "commit" });
  await loadingPage.evaluate(() => {
    window.__coldFileDocument = "same";
  });
  await loadingPage.getByRole("status", { name: "Loading file", exact: true }).waitFor();
  assert.equal(
    await loadingPage.getByRole("status", { name: "Loading page", exact: true }).count(),
    0,
    "File navigation used the generic page skeleton.",
  );
  assert.equal(
    await loadingPage.getByRole("navigation", { name: "Workspace" }).count(),
    0,
    "The file skeleton retained the workspace sidebar.",
  );
  assert.equal(await loadingPage.evaluate(() => window.__coldFileDocument), "same");
  const editorLoadingCanvas = await loadingPage
    .locator('[data-page-skeleton="editor"]')
    .evaluate((element) => getComputedStyle(element).backgroundColor);
  assert.notEqual(
    editorLoadingCanvas,
    "rgb(255, 255, 255)",
    "Editor loading still flashes a white canvas.",
  );
  await loadingPage.screenshot({ path: join(artifact, "file-loading.png") });
  await loadingPage.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await loadingPage.screenshot({ path: join(artifact, "file-loading-dark.png") });
  await loadingPage.emulateMedia({ colorScheme: "light", reducedMotion: "no-preference" });
  await loadingPage.setViewportSize({ width: 390, height: 844 });
  assert(
    await loadingPage.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    "The file skeleton overflows mobile width.",
  );
  await loadingPage.screenshot({ path: join(artifact, "file-loading-mobile.png") });
  await loadingPage.setViewportSize({ width: 1440, height: 960 });
  await blocker.query("rollback");
  await blocker.end();
  blocker = null;
  await loadingPage.getByRole("link", { name: "Back to files", exact: true }).waitFor();
  assert.equal(
    await loadingPage.evaluate(() => window.__coldFileDocument),
    "same",
    "Cold file entry reloaded the document.",
  );
  await loadingPage.close();
  await page.getByRole("link", { name: "Open Fixture file", exact: true }).click();
  await page.getByRole("link", { name: "Back to files", exact: true }).waitFor();
  assert.equal(
    await page.getByRole("navigation", { name: "Workspace" }).count(),
    0,
    "The editor inherited the workspace sidebar.",
  );
  await sameDocument();
  await page.getByRole("link", { name: "Back to files", exact: true }).click();
  await page.getByRole("heading", { name: "Fixture folder", exact: true }).waitFor();
  await sameDocument();
  await page.getByRole("button", { name: "+ New file", exact: true }).click();
  await page.getByRole("link", { name: "Back to files", exact: true }).waitFor();
  await sameDocument();
  await page.getByRole("link", { name: "Back to files", exact: true }).click();
  await page.getByRole("heading", { name: "Fixture folder", exact: true }).waitFor();
  blocker = new pg.Client({ connectionString: database });
  await blocker.connect();
  await blocker.query('begin; lock table "agentThread" in access exclusive mode');
  const editorPage = await context.newPage();
  editorPage.on("pageerror", (error) => errors.push(error.message));
  await editorPage.goto(`${base}/files/${file}`, { waitUntil: "commit" });
  await editorPage.getByRole("link", { name: "Back to files", exact: true }).waitFor();
  assert.equal(
    await editorPage.locator('[data-page-skeleton="editor"]').count(),
    0,
    "Optional agents block the canvas.",
  );
  const canvasColor = await editorPage
    .getByLabel("Design canvas", { exact: true })
    .evaluate((element) => getComputedStyle(element).backgroundColor);
  assert.equal(canvasColor, editorLoadingCanvas, "Loading and loaded editor canvas colors differ.");
  await editorPage.getByRole("button", { name: "Rectangle tool", exact: true }).click();
  await blocker.query("rollback");
  await blocker.end();
  blocker = null;
  await editorPage.getByRole("button", { name: "Threads", exact: true }).waitFor();
  assert.equal(
    await editorPage
      .getByRole("button", { name: "Rectangle tool", exact: true })
      .getAttribute("aria-pressed"),
    "true",
    "Late agents reset the selected editor tool.",
  );
  await editorPage.close();
  console.log(
    "PASS: editor boundaries, file creation and usable canvas while optional agents are blocked.",
  );
  const warmPage = await context.newPage();
  warmPage.on("pageerror", (error) => errors.push(error.message));
  await warmPage.mouse.move(0, 0);
  await warmPage.goto(`${base}/files?folder=${folder}`);
  await warmPage.locator('[data-page-content="files"]').waitFor();
  const warmedResponse = warmPage.waitForResponse((response) => {
    const url = new URL(response.url());
    return (
      url.pathname === `/files/${file}` &&
      url.searchParams.has("_rsc") &&
      !response.request().headers()["next-router-prefetch"]
    );
  });
  await warmPage.getByRole("link", { name: "Open Fixture file", exact: true }).hover();
  await warmedResponse;
  // A real hover has a short preparation window before its following click.
  // The streamed response can remain open for optional agent/review props.
  await sleep(200);
  await warmPage.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
  const fileNavigationRequests = [];
  warmPage.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname === `/files/${file}` && url.searchParams.has("_rsc"))
      fileNavigationRequests.push(request.url());
  });
  await warmPage.getByRole("link", { name: "Open Fixture file", exact: true }).click();
  await warmPage.getByRole("link", { name: "Back to files", exact: true }).waitFor();
  assert.equal(
    fileNavigationRequests.length,
    0,
    "Intent-prefetched file still requested a server render on click.",
  );
  await warmPage.close();
  console.log("PASS: file hover prepares the full editor; clicking needs no RSC request.");

  // Prime visited/prefetched settings in the first organization, then switch.
  await page
    .getByRole("navigation", { name: "Workspace" })
    .getByRole("link", { name: "Settings", exact: true })
    .click();
  await page.getByRole("heading", { name: "Settings", exact: true }).waitFor();
  await page.getByRole("button", { name: "Switch organization, First workspace" }).click();
  await page.getByRole("button", { name: "Organization: First workspace", exact: true }).click();
  await page.getByRole("menuitemradio", { name: "Second workspace", exact: true }).click();
  await page.waitForURL(`${base}/files`);
  await page.getByRole("button", { name: "Switch organization, Second workspace" }).waitFor();
  assert.equal(
    await page.getByRole("link", { name: /Fixture folder/ }).count(),
    0,
    "The previous workspace's files survived switching.",
  );
  await page
    .getByRole("navigation", { name: "Workspace" })
    .getByRole("link", { name: "Settings", exact: true })
    .click();
  await page.getByRole("heading", { name: "Settings", exact: true }).waitFor();
  await sameDocument();
  await page.getByRole("tab", { name: "Organization", exact: true }).click();
  assert.equal(
    await page.getByLabel("Organization name", { exact: true }).inputValue(),
    "Second workspace",
  );
  console.log("PASS: organization switching invalidates cached page and sidebar data.");
  await page.getByRole("button", { name: "Switch organization, Second workspace" }).click();
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await page.waitForURL(`${base}/login`);
  await page.getByRole("button", { name: "Sign in", exact: true }).waitFor();
  await sameDocument();
  await page.goBack();
  await page.waitForURL(`${base}/login`);
  await page.getByRole("button", { name: "Sign in", exact: true }).waitFor();
  assert.equal(
    await page.getByRole("navigation", { name: "Workspace" }).count(),
    0,
    "Back restored protected workspace UI after sign-out.",
  );
  await sameDocument();
  await page.getByRole("link", { name: "Forgot password?" }).click();
  await page.waitForURL(`${base}/forgot-password`);
  await page.getByRole("link", { name: "Back to sign in" }).click();
  await page.getByRole("textbox", { name: "Email", exact: true }).fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL(`${base}/files`);
  // A new authentication session has no active organization. It resolves the
  // default membership rather than retaining the signed-out session's selection.
  await page.getByRole("button", { name: "Switch organization, First workspace" }).waitFor();
  await page.getByRole("link", { name: /Fixture folder/ }).waitFor();
  await sameDocument();
  await page.screenshot({ path: join(artifact, "workspace.png") });
  assert.deepEqual(errors, [], "Browser errors occurred.");
  console.log(
    "PASS: sidebar persistence, client links, history, streaming under delay, editor boundaries, creation, organization cache invalidation, sign-out and sign-in.",
  );
} finally {
  release?.();
  if (blocker) {
    await blocker.query("rollback");
    await blocker.end();
  }
  await browser?.close();
  await client?.end();
  if (server) {
    server.kill("SIGTERM");
    await new Promise((resolve) => {
      if (server.exitCode !== null || server.signalCode !== null) resolve();
      else server.once("exit", resolve);
    });
  }
  if (flagServer) await new Promise((resolve) => flagServer.close(resolve));
  if (started) command("pg_ctl", ["-D", data, "-m", "fast", "-w", "stop"]);
  await rm(temporary, { recursive: true, force: true });
}
