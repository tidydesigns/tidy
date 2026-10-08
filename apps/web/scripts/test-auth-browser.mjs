import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, mkdir, cp, readdir, rm, open, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { chromium } from "playwright";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const app = join(root, "apps/web"),
  standalone = join(app, ".next/standalone/apps/web");
const directory = await mkdtemp(join(tmpdir(), "tidy-auth-browser-"));
const data = join(directory, "postgres"),
  inbox = join(directory, "inbox.json");
const artifacts = join(root, ".artifacts/auth");
await mkdir(artifacts, { recursive: true });
let started = false,
  server,
  browser,
  client;
function run(command, args, env) {
  const result = spawnSync(command, args, { cwd: root, stdio: "ignore", ...(env ? { env } : {}) });
  if (result.error || result.status !== 0) throw new Error(`${command} failed (${result.status}).`);
}
async function port() {
  const socket = createServer();
  await new Promise((resolve, reject) => {
    socket.once("error", reject);
    socket.listen(0, "127.0.0.1", resolve);
  });
  const value = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  return value;
}
try {
  assert(
    !(await readdir(standalone)).some((name) => name.startsWith(".env")),
    "Remove environment files from the disposable standalone build before running this suite.",
  );
  const databasePort = await port(),
    webPort = await port(),
    base = `http://127.0.0.1:${webPort}`;
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
    "tidy_auth_browser_test",
  ]);
  const database = `postgres://tidy_test@127.0.0.1:${databasePort}/tidy_auth_browser_test`;
  const env = Object.fromEntries(
    ["PATH", "HOME", "TMPDIR", "LANG"].flatMap((key) =>
      process.env[key] ? [[key, process.env[key]]] : [],
    ),
  );
  Object.assign(env, {
    NODE_ENV: "production",
    DATABASE_URL: database,
    BETTER_AUTH_URL: base,
    BETTER_AUTH_SECRET: "disposable-auth-browser-secret-at-least-32-characters",
    NEXT_TELEMETRY_DISABLED: "1",
    POSTHOG_TRACING_ENABLED: "0",
    GOOGLE_CLIENT_ID: "test-google-client",
    GOOGLE_CLIENT_SECRET: "test-google-secret",
    AUTH_GITHUB_CLIENT_ID: "test-github-client",
    AUTH_GITHUB_CLIENT_SECRET: "test-github-secret",
    CLOUDFLARE_ACCOUNT_ID: "auth-browser-test",
    CLOUDFLARE_EMAIL_API_TOKEN: "test-mail-token",
    AUTH_EMAIL_FROM: "Tidy <accounts@example.test>",
    AUTH_BROWSER_TEST_INBOX: inbox,
  });
  run("node", ["apps/web/scripts/setup-multiplayer-local.mjs"], {
    ...env,
    MULTIPLAYER_TEST_DATABASE_URL: database,
  });
  await cp(join(app, "public"), join(standalone, "public"), { recursive: true });
  await cp(join(app, ".next/static"), join(standalone, ".next/static"), { recursive: true });
  const log = await open(join(artifacts, "server.log"), "w");
  server = spawn(
    "node",
    [
      "--import",
      join(app, "scripts/fixtures/auth-browser-mail.mjs"),
      join(standalone, "server.js"),
    ],
    {
      cwd: standalone,
      env: { ...env, PORT: String(webPort), HOSTNAME: "127.0.0.1" },
      stdio: ["ignore", log.fd, log.fd],
    },
  );
  await log.close();
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${base}/login`)).ok) {
        ready = true;
        break;
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert(ready, "Production server did not start. See .artifacts/auth/server.log.");
  client = new pg.Client({ connectionString: database });
  await client.connect();
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  await context.route("**/*", (route) => {
    const target = new URL(route.request().url());
    return target.origin === base ? route.continue() : route.abort();
  });
  const page = await context.newPage(),
    errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${base}/login`);
  assert.equal(
    await page.getByRole("button", { name: "Continue with Google", exact: true }).count(),
    1,
  );
  assert.equal(
    await page.getByRole("button", { name: "Continue with GitHub", exact: true }).count(),
    1,
  );
  await page.screenshot({ path: join(artifacts, "login.png"), fullPage: true });
  // Test the actual button requests while preventing navigation to real providers.
  const socialRequests = [];
  await page.route("**/api/auth/sign-in/social", async (route) => {
    socialRequests.push(route.request().postDataJSON());
    await route.fulfill({
      status: 400,
      contentType: "application/json",
      body: JSON.stringify({ code: "TEST_PROVIDER", message: "Mock provider error" }),
    });
  });
  for (const provider of ["Google", "GitHub"]) {
    await page.getByRole("button", { name: `Continue with ${provider}`, exact: true }).click();
    await page.getByRole("alert").filter({ hasText: "Unable to connect" }).waitFor();
  }
  assert.deepEqual(
    socialRequests.map((request) => request.provider),
    ["google", "github"],
  );
  for (const request of socialRequests) {
    assert.equal(request.callbackURL, "/");
    assert.equal(request.newUserCallbackURL, "/onboarding/organization");
  }
  await page.unroute("**/api/auth/sign-in/social");
  await page.goto(`${base}/sign-up`);
  await page.getByLabel("Name", { exact: true }).fill("Designer");
  await page.getByLabel("Email", { exact: true }).fill("designer@example.test");
  await page.getByLabel("Password", { exact: true }).fill("disposable-browser-password");
  await page.getByLabel("Confirm password", { exact: true }).fill("different-password");
  await page.getByRole("button", { name: "Create account", exact: true }).click();
  await page.getByText("Passwords do not match.").waitFor();
  await page.getByLabel("Confirm password", { exact: true }).fill("disposable-browser-password");
  await page.getByRole("button", { name: "Create account", exact: true }).click();
  await page.getByRole("button", { name: "Resend verification email", exact: true }).waitFor();
  await page.getByRole("heading", { name: "Verify your email.", exact: true }).waitFor();
  assert.equal(await page.getByRole("link", { name: "Back to sign in" }).count(), 1);
  assert.equal(await page.getByRole("link", { name: "Sign in", exact: true }).count(), 0);
  assert.equal((await client.query('select * from "session"')).rowCount, 0);
  await page.screenshot({ path: join(artifacts, "verification-desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: join(artifacts, "verification-mobile.png"), fullPage: true });
  assert(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    "The verification form overflows mobile width.",
  );
  await page.getByRole("button", { name: "Resend verification email", exact: true }).click();
  await page.getByRole("button", { name: "Resend verification email", exact: true }).waitFor();
  const deliveries = JSON.parse(await readFile(inbox, "utf8"));
  assert.equal(deliveries.length, 2);
  const link = deliveries.at(-1).text.match(/https?:\/\/\S+/)[0];
  await page.goto(`${base}/files`);
  await page.waitForURL(`${base}/login**`);
  await page.goto(link);
  await page.waitForURL(`${base}/onboarding/organization`);
  assert.equal(
    (await client.query('select "emailVerified" from "user"')).rows[0].emailVerified,
    true,
  );
  assert((await context.cookies()).some((value) => value.name.includes("session_token")));
  await context.clearCookies();
  await page.goto(`${base}/verify-email?error=TOKEN_EXPIRED&next=https%3A%2F%2Fevil.example`);
  await page
    .getByText("This verification link is invalid or has expired. Request a new link below.")
    .waitFor();
  assert.equal(
    await page.getByRole("link", { name: "Back to sign in" }).getAttribute("href"),
    "/login?next=%2F",
  );
  await page.goto(`${base}/login`);
  await page.getByLabel("Email", { exact: true }).fill("designer@example.test");
  await page.getByLabel("Password", { exact: true }).fill("disposable-browser-password");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("heading", { name: "Create your organisation.", exact: true }).waitFor();
  assert.equal(new URL(page.url()).pathname, "/onboarding/organization");

  // Exercise the actual consent page and client plugin against the production
  // bundle. Only the loopback CLI callback is a browser fixture.
  const resource = `${base}/api/mcp`,
    callback = `${base}/oauth-fixture/callback`;
  await client.query(
    `insert into "oauthClient" ("id","clientId","name","redirectUris","scopes","grantTypes","tokenEndpointAuthMethod","requirePKCE")
    values ('browser-agent','browser-agent','Browser agent',$1,'["mcp:read","mcp:write","offline_access"]','["authorization_code","refresh_token"]','none',true)`,
    [JSON.stringify([callback])],
  );
  await client.query(
    'insert into "oauthClientResource" ("id","clientId","resourceId") values (\'browser-agent-link\',\'browser-agent\',$1)',
    [resource],
  );
  await page.route("**/oauth-fixture/callback*", (route) =>
    route.fulfill({ status: 200, contentType: "text/html", body: "<p>CLI callback received.</p>" }),
  );
  const verifier = "disposable-browser-oauth-pkce-verifier-with-more-than-43-characters";
  const oauthQuery = new URLSearchParams({
    client_id: "browser-agent",
    response_type: "code",
    redirect_uri: callback,
    resource,
    scope: "mcp:read mcp:write offline_access",
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
    state: "browser-consent-state",
  });
  let consentRequest;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/auth/oauth2/consent")
      consentRequest = request.postDataJSON();
  });
  await page.goto(`${base}/api/auth/oauth2/authorize?${oauthQuery}`);
  await page.getByRole("heading", { name: "Connect a coding agent", exact: true }).waitFor();
  await page.getByRole("button", { name: "Allow access", exact: true }).click();
  await page.waitForURL(`${callback}**`);
  assert.equal(typeof consentRequest.tidy_consent, "string");
  assert(consentRequest.tidy_consent.length > 0);
  assert.equal(
    new URLSearchParams(consentRequest.oauth_query).get("state"),
    "browser-consent-state",
  );
  const code = new URL(page.url()).searchParams.get("code");
  assert(code, "Consent did not return an authorization code to the CLI callback.");
  const exchange = await fetch(`${base}/api/auth/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: "browser-agent",
      code,
      code_verifier: verifier,
      redirect_uri: callback,
      resource,
    }),
  });
  assert.equal(exchange.status, 200);
  const tokens = await exchange.json();
  assert.equal(typeof tokens.access_token, "string");
  const replay = await context.request.post(`${base}/api/auth/oauth2/consent`, {
    headers: { origin: base },
    data: consentRequest,
  });
  assert.equal(
    replay.status(),
    400,
    "A consumed displayed approval must not publish another code.",
  );
  const mcp = await fetch(resource, {
    method: "POST",
    headers: {
      authorization: `Bearer ${tokens.access_token}`,
      accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2025-06-18",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });
  assert.equal(mcp.status, 200, "A refused approval replay must preserve the newly issued grant.");
  assert.deepEqual(errors, []);
  console.log(
    "Auth browser checks passed: provider buttons, password mismatch, sign-up, resend, protected access, inbox verification, mobile layout, expired links, verified password sign-in and session-bound MCP consent/callback/token/replay.",
  );
} finally {
  await browser?.close();
  await client?.end();
  if (server) {
    server.kill("SIGTERM");
    await new Promise((resolve) => {
      if (server.exitCode !== null) resolve();
      else server.once("exit", resolve);
    });
  }
  if (started) run("pg_ctl", ["-D", data, "-m", "fast", "-w", "stop"]);
  await rm(directory, { recursive: true, force: true });
}
