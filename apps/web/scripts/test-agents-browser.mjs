// Owns a disposable database and local production server. Never loads the linked
// application's environment file or connects to an OpenAI account.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, mkdir, cp, readdir, rm, open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { chromium } from "playwright";
import { verifiedTestAccount } from "./fixtures/verified-test-account.mjs";

const root = fileURLToPath(new URL("../../../", import.meta.url)),
  app = join(root, "apps/web");
const temporary = await mkdtemp(join(tmpdir(), "tidy-agents-browser-"));
const data = join(temporary, "postgres"),
  standalone = join(app, ".next/standalone/apps/web");
const artifact = join(root, ".artifacts/agents");
await mkdir(artifact, { recursive: true });
let started = false,
  server,
  browser,
  client;
const command = (name, args, options = {}) => {
  const result = spawnSync(name, args, { cwd: root, stdio: "ignore", ...options });
  if (result.status !== 0) throw new Error(`${name} failed (${result.status})`);
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
    webPort = await port(),
    base = `http://127.0.0.1:${webPort}`;
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
    "tidy_agents_browser",
  ]);
  const database = `postgres://tidy_test@127.0.0.1:${databasePort}/tidy_agents_browser`;
  const env = Object.fromEntries(
    ["PATH", "HOME", "TMPDIR", "LANG"].flatMap((key) =>
      process.env[key] ? [[key, process.env[key]]] : [],
    ),
  );
  const secret = "browser-fixture-runner-secret-at-least-32-characters";
  Object.assign(env, {
    NODE_ENV: "production",
    DATABASE_URL: database,
    NEXT_TELEMETRY_DISABLED: "1",
    BETTER_AUTH_URL: base,
    BETTER_AUTH_SECRET: "local-browser-auth-secret-at-least-32-characters",
    TIDY_AGENTS_ENABLED: "true",
    AGENT_MODEL: "test-model",
    AGENT_RUNNER_SECRET: secret,
    AGENT_RUNNER_URL: "http://127.0.0.1:1",
  });
  command("node", ["apps/web/scripts/setup-multiplayer-local.mjs"], {
    env: { ...env, MULTIPLAYER_TEST_DATABASE_URL: database },
  });
  assert(
    !(await readdir(standalone)).some((name) => name.startsWith(".env")),
    "Build the standalone app without environment files before this test.",
  );
  await cp(join(app, "public"), join(standalone, "public"), { recursive: true });
  await cp(join(app, ".next/static"), join(standalone, ".next/static"), { recursive: true });
  const log = await open(join(artifact, "server.log"), "w");
  server = spawn("node", [join(standalone, "server.js")], {
    cwd: standalone,
    env: { ...env, PORT: String(webPort), HOSTNAME: "127.0.0.1" },
    stdio: ["ignore", log.fd, log.fd],
  });
  await log.close();
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try {
      const response = await fetch(`${base}/login`);
      if (response.ok) {
        ready = true;
        break;
      }
    } catch {}
    await sleep(100);
  }
  assert(ready, "Local production server did not start. See .artifacts/agents/server.log.");
  client = new pg.Client({ connectionString: database });
  await client.connect();
  browser = await chromium.launch({ headless: true });
  const contexts = await Promise.all([
    browser.newContext({ viewport: { width: 1440, height: 960 } }),
    browser.newContext({ viewport: { width: 1440, height: 960 } }),
  ]);
  const users = [];
  for (const [index, context] of contexts.entries()) {
    const email = ["owner@example.com", "outsider@example.com"][index];
    const id = await verifiedTestAccount(client, {
      name: index ? "Teammate" : "Owner",
      email,
      password: "local-fixture-password-123",
    });
    users.push(id);
    const response = await context.request.post(`${base}/api/auth/sign-in/email`, {
      headers: { Origin: base },
      data: { email, password: "local-fixture-password-123" },
    });
    assert.equal(response.status(), 200, `Fixture sign-in failed (${response.status()}).`);
  }
  const org = crypto.randomUUID(),
    file = crypto.randomUUID();
  await client.query(
    `insert into "organization" ("id","name","slug","createdAt","createdByUserId") values ($1,'Design team',$1,now(),$2)`,
    [org, users[0]],
  );
  await client.query(
    `insert into "billingPlanPrice" ("priceId") values ('price_agent_fixture');insert into "organization_billing" ("organizationId","stripeStatus","stripePriceId") values ('${org}','active','price_agent_fixture')`,
  );
  for (const [index, id] of users.entries()) {
    await client.query(
      `insert into "member" ("id","organizationId","userId","role","createdAt") values ($1,$2,$3,$4,now())`,
      [crypto.randomUUID(), org, id, index ? "editor" : "owner"],
    );
    await client.query(
      `insert into "agentConnection" ("id","userId","provider","subject","clientId","accountLabel","status") values ($1,$2,'codex','','codex-managed','Test account','connected')`,
      [crypto.randomUUID(), id],
    );
  }
  await client.query(
    `insert into "designFile" ("id","organizationId","name","createdBy") values ($1,$2,'Landing page',$3)`,
    [file, org, users[0]],
  );
  const [owner, teammate] = await Promise.all(contexts.map((context) => context.newPage()));
  const errors = [];
  for (const page of [owner, teammate]) page.on("pageerror", (error) => errors.push(error.message));
  await Promise.all([owner.goto(`${base}/threads`), teammate.goto(`${base}/threads`)]);
  await owner
    .getByRole("textbox", { name: "Describe the design work" })
    .fill("Improve our landing page");
  const sending = owner.waitForResponse(
    (response) =>
      response.url().endsWith("/api/agents/threads") && response.request().method() === "POST",
  );
  await owner.getByRole("button", { name: "Send", exact: true }).click();
  const sent = await sending;
  assert.equal(sent.status(), 201, JSON.stringify(await sent.json()));
  await owner.getByRole("button", { name: "Stop", exact: true }).waitFor();
  await teammate.getByRole("button", { name: /Improve our landing page/ }).click();
  await teammate.getByText("Owner is directing this run.").waitFor();
  assert.equal(await teammate.getByRole("button", { name: "Stop", exact: true }).count(), 0);
  const run = (
    await client.query(
      `select r."id",r."threadId",w."id" as "agentId" from "agentRun" r join "agentWorker" w on w."runId"=r."id"`,
    )
  ).rows[0];
  const internal = async (value) => {
    const response = await fetch(`${base}/api/internal/agents/runner`, {
      method: "POST",
      headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
      body: JSON.stringify(value),
    });
    assert.equal(response.status, 200);
    return response.json();
  };
  const claimed = (await internal({ action: "claim", runnerId: crypto.randomUUID() })).run;
  await internal({
    action: "message",
    runId: run.id,
    generation: claimed.generation,
    agentId: run.agentId,
    id: crypto.randomUUID(),
    kind: "assistant",
    content: "I am working on the landing page.",
  });
  await teammate.getByText("I am working on the landing page.", { exact: true }).waitFor();
  await owner.getByRole("button", { name: "Stop", exact: true }).click();
  await teammate.getByRole("textbox", { name: "Describe the design work" }).waitFor();
  assert.equal(
    (await client.query(`select "status" from "agentRun" where "id"=$1`, [run.id])).rows[0].status,
    "cancelled",
  );
  await owner.screenshot({ path: join(artifact, "threads-desktop.png") });
  await owner.goto(`${base}/files/${file}`);
  await owner.getByRole("button", { name: "Threads", exact: true }).click();
  await owner
    .getByRole("textbox", { name: "Describe the design work" })
    .fill("Draft from the canvas");
  await owner.getByRole("button", { name: "Close threads", exact: true }).click();
  await owner.getByRole("button", { name: "Threads", exact: true }).click();
  assert.equal(
    await owner.getByRole("textbox", { name: "Describe the design work" }).inputValue(),
    "Draft from the canvas",
  );
  await owner.setViewportSize({ width: 390, height: 844 });
  await owner.screenshot({ path: join(artifact, "threads-mobile.png") });
  assert(await owner.getByRole("button", { name: "Send", exact: true }).isVisible());
  assert.equal(
    await owner.evaluate(() => document.documentElement.scrollWidth > window.innerWidth),
    false,
  );
  await owner.goto(`${base}/settings?tab=agents`);
  await owner.getByRole("heading", { name: "Codex", exact: true }).waitFor();
  assert.equal(await owner.getByRole("button", { name: "Disconnect", exact: true }).count(), 1);
  assert.deepEqual(errors, []);
  console.log(
    "PASS: shared thread visibility, owner controls, live output, stopping, canvas entry, drafts, mobile layout, and personal connection settings.",
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
  if (started) command("pg_ctl", ["-D", data, "-m", "fast", "-w", "stop"]);
  await rm(temporary, { recursive: true, force: true });
}
