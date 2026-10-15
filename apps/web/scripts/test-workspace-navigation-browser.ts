// Run after a production build. All database faults stay in a disposable local fixture.
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHmac } from "node:crypto";
import { cp, mkdir, mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import pg from "pg";
import { chromium, type Browser } from "playwright";
import { CONSENT_VERSION, ESSENTIAL_ONLY } from "../lib/privacy/consent";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const app = join(root, "apps/web");
const directory = await mkdtemp(join(tmpdir(), "tidy-navigation-"));
const artifacts = join(root, ".artifacts/navigation");
const reproduce = process.argv.includes("--reproduce");
assert(
  process.argv.slice(2).every((arg) => arg === "--reproduce"),
  "Unknown argument",
);
await mkdir(artifacts, { recursive: true });
const results: Record<string, unknown>[] = [];
let started = false;
let server: ChildProcess | undefined;
let browser: Browser | undefined;
let client: pg.Client | undefined;

function run(command: string, args: string[], env?: NodeJS.ProcessEnv) {
  const result = spawnSync(command, args, { cwd: root, env, encoding: "utf8" });
  assert.equal(result.status, 0, result.error?.message ?? result.stderr);
}

async function port() {
  const socket = createServer();
  await new Promise<void>((resolve, reject) => {
    socket.once("error", reject);
    socket.listen(0, "127.0.0.1", resolve);
  });
  const address = socket.address();
  assert(address && typeof address !== "string");
  await new Promise<void>((resolve, reject) =>
    socket.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

try {
  const databasePort = await port();
  const webPort = await port();
  const base = `http://127.0.0.1:${webPort}`;
  const data = join(directory, "postgres");
  run("initdb", ["-D", data, "--auth=trust", "--username=tidy_navigation", "--no-instructions"]);
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
  const database = `postgres://tidy_navigation@127.0.0.1:${databasePort}/postgres`;
  const secret = "disposable-navigation-fixture-secret-at-least-32-characters";
  const env: NodeJS.ProcessEnv = {
    ...Object.fromEntries(["PATH", "HOME", "TMPDIR", "LANG"].map((key) => [key, process.env[key]])),
    NODE_ENV: "production",
    AUTH_EMAIL_FROM: "",
    AUTH_GITHUB_CLIENT_ID: "",
    CLOUDFLARE_ACCOUNT_ID: "",
    FEEDBACK_REVIEWER_EMAILS: "",
    GITHUB_APP_ID: "",
    GITHUB_APP_SLUG: "",
    GITHUB_CLIENT_ID: "",
    GOOGLE_CLIENT_ID: "",
    STRIPE_FIRST_MONTH_COUPON_ID: "",
    STRIPE_PRO_PRICE_ID: "",
    DATABASE_URL: database,
    MULTIPLAYER_TEST_DATABASE_URL: database,
    BETTER_AUTH_URL: base,
    BETTER_AUTH_SECRET: secret,
    NEXT_TELEMETRY_DISABLED: "1",
    NEXT_PUBLIC_POSTHOG_ENABLED: "0",
    POSTHOG_SERVER_ERRORS_ENABLED: "0",
    POSTHOG_TRACING_ENABLED: "0",
    TIDY_AGENTS_ENABLED: "false",
    PORT: String(webPort),
    HOSTNAME: "127.0.0.1",
  };
  run("node", ["apps/web/scripts/setup-multiplayer-local.mjs"], env);
  client = new pg.Client({ connectionString: database });
  await client.connect();
  await client.query(`
    insert into "user" (id,name,email,"emailVerified") values ('navigation-user','Navigation','navigation@example.test',true);
    insert into organization (id,name,slug,"createdAt","createdByUserId") values ('navigation-org','Navigation','navigation',now(),'navigation-user');
    insert into member (id,"organizationId","userId",role,"createdAt") values ('navigation-member','navigation-org','navigation-user','owner',now());
    insert into session (id,token,"userId","expiresAt","updatedAt","activeOrganizationId") values ('navigation-session','navigation-token','navigation-user',now()+interval '1 day',now(),'navigation-org');
  `);

  // Never run the copied build with application environment files or inherited credentials.
  const copy = join(directory, "server");
  await cp(join(app, ".next/standalone"), copy, {
    recursive: true,
    filter: (source) => !basename(source).startsWith(".env"),
  });
  const standalone = join(copy, "apps/web");
  await cp(join(app, ".next/static"), join(standalone, ".next/static"), { recursive: true });
  await cp(join(app, "public"), join(standalone, "public"), { recursive: true });
  const log = await open(join(artifacts, "server.log"), "w");
  server = spawn("node", [join(standalone, "server.js")], {
    cwd: standalone,
    env,
    stdio: ["ignore", log.fd, log.fd],
  });
  await log.close();
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      if ((await fetch(`${base}/login`)).ok) {
        ready = true;
        break;
      }
    } catch {
      /* Server is starting. */
    }
    await delay(100);
  }
  assert(ready, "Production server did not start; see .artifacts/navigation/server.log");
  browser = await chromium.launch({ headless: true });
  const signature = createHmac("sha256", secret).update("navigation-token").digest("base64");
  const sessionCookie = encodeURIComponent(`navigation-token.${signature}`);
  const cases = [
    { path: "/mcp", label: "MCP", table: '"oauthConsent"', content: "mcp" },
    { path: "/settings", label: "Settings", table: '"invitation"', content: "settings" },
  ];

  for (const target of cases) {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 960 },
      colorScheme: "dark",
    });
    await context.addCookies([
      { name: "better-auth.session_token", value: sessionCookie, url: base },
      {
        name: "tidy_consent",
        url: base,
        value: encodeURIComponent(
          JSON.stringify({
            version: CONSENT_VERSION,
            at: Date.now(),
            ...ESSENTIAL_ONLY,
          }),
        ),
      },
    ]);
    await context.route("**/*", (route) =>
      new URL(route.request().url()).origin === base ? route.continue() : route.abort(),
    );
    const page = await context.newPage();
    page.setDefaultTimeout(20_000);
    const requests: string[] = [];
    page.on("request", (request) => {
      if (new URL(request.url()).pathname === target.path) requests.push(request.url());
    });
    const content = page.locator(`[data-page-content=${target.content}]`);
    const error = page.getByText("Could not load this page. Please try again.", { exact: true });
    try {
      await client.query("begin");
      await client.query(`lock table ${target.table} in access exclusive mode`);
      await page.goto(`${base}/files`);
      await page.locator("[data-page-content=files]").waitFor();
      const link = page.getByRole("link", { name: target.label, exact: true });
      await link.hover();
      await link.focus();
      // Exceed pg's 10-second query timeout: the unfixed full prefetch caches the error.
      // Hover and focus must not start a prefetch either when prefetch=false.
      await delay(11_000);
      const backgroundRequests = requests.length;
      await client.query("rollback");
      const healthy = await fetch(`${base}${target.path}`, {
        headers: { cookie: `better-auth.session_token=${sessionCookie}` },
      });
      assert((await healthy.text()).includes(`data-page-content="${target.content}"`));
      const beforeClick = requests.length;
      await link.click();
      if (reproduce) {
        await error.waitFor();
        assert(backgroundRequests > 0, "Expected a background prefetch");
        assert.equal(requests.length, beforeClick, "Cached failure should make no fresh request");
      } else {
        await content.waitFor();
        assert.equal(backgroundRequests, 0, `${target.label} was prefetched before navigation`);
        assert(requests.length > beforeClick, "Navigation must request fresh page data");
        assert.equal(await error.isVisible(), false);
      }
      await page.screenshot({
        path: join(artifacts, `${target.content}-${reproduce ? "before" : "after"}.png`),
        fullPage: true,
      });
      results.push({
        path: target.path,
        backgroundRequests,
        freshRequestsOnClick: requests.length - beforeClick,
        cachedError: reproduce,
      });
      if (reproduce) {
        await page.reload();
        await content.waitFor();
      } else {
        // A real failure on an intentional visit must remain visible and recover via retry.
        await page.reload();
        await content.waitFor();
        await page.goto(`${base}/files`);
        await client.query("begin");
        await client.query(`lock table ${target.table} in access exclusive mode`);
        await page.getByRole("link", { name: target.label, exact: true }).click();
        await error.waitFor();
        await client.query("rollback");
        const beforeRetry = requests.length;
        await page.getByRole("button", { name: "Try again", exact: true }).click();
        await content.waitFor();
        assert(requests.length > beforeRetry, "Retry must refetch the failed page");
        await page.getByRole("link", { name: "Files", exact: true }).click();
        await page.locator("[data-page-content=files]").waitFor();
        await page.goBack();
        await content.waitFor();
      }
      console.log(
        `PASS ${target.label}: ${reproduce ? "cached failure reproduced; refresh recovered" : "fresh navigation, refresh, retry and history recovered"}`,
      );
    } finally {
      await client.query("rollback");
      await context.close();
    }
  }
} finally {
  await writeFile(
    join(artifacts, `${reproduce ? "before" : "after"}.json`),
    JSON.stringify(results, null, 2),
  );
  await browser?.close();
  if (server && server.exitCode === null && server.signalCode === null) {
    const child = server;
    const stopped = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    child.kill("SIGTERM");
    await stopped;
  }
  await client?.end();
  if (started) run("pg_ctl", ["-D", join(directory, "postgres"), "-m", "immediate", "-w", "stop"]);
  await rm(directory, { recursive: true, force: true });
}
