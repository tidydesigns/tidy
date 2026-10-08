import { spawn } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const web = join(root, "apps/web");
const temporary = await mkdtemp(join(tmpdir(), "tidy-version-history-"));
const container = `tidy-versions-${crypto.randomUUID()}`;
const database = "postgres://tidy_test:tidy_local@127.0.0.1:55441/tidy_versions_test";
const app = "http://localhost:3041";
const secret = "tidy-disposable-acceptance-local-secret-only";
const children = [];
const log = async (name) => {
  const { open } = await import("node:fs/promises");
  return open(join(temporary, `${name}.log`), "w");
};
const run = (command, args, options = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: "inherit", ...options });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`)),
    );
  });
const env = {
  ...process.env,
  DATABASE_URL: database,
  MULTIPLAYER_TEST_DATABASE_URL: database,
  VERSION_TEST_DATABASE_URL: database,
  BETTER_AUTH_URL: app,
  BETTER_AUTH_SECRET: secret,
  BELLA_REALTIME_URL: "http://localhost:8841",
  NEXT_PUBLIC_POSTHOG_HOST: "http://127.0.0.1:9",
  POSTHOG_API_KEY: "",
  POSTHOG_UPLOAD_SOURCEMAPS: "0",
  POSTHOG_HOST: "http://127.0.0.1:9",
  TIDY_AGENTS_ENABLED: "false",
};
const waitFor = async (url) => {
  const deadline = Date.now() + 60_000;
  for (;;) {
    if (children.some((child) => child.exitCode !== null))
      throw new Error("A local test server stopped.");
    try {
      await fetch(url, { signal: AbortSignal.timeout(2000) });
      return;
    } catch {
      /* Starting. */
    }
    if (Date.now() > deadline) throw new Error(`Local test server did not start: ${url}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
};
try {
  await run("docker", [
    "run",
    "-d",
    "--name",
    container,
    "-e",
    "POSTGRES_DB=tidy_versions_test",
    "-e",
    "POSTGRES_USER=tidy_test",
    "-e",
    "POSTGRES_PASSWORD=tidy_local",
    "-p",
    "127.0.0.1:55441:5432",
    "postgres:17",
  ]);
  const ready = Date.now() + 30_000;
  for (;;) {
    try {
      await run(
        "docker",
        [
          "exec",
          container,
          "pg_isready",
          "-h",
          "127.0.0.1",
          "-U",
          "tidy_test",
          "-d",
          "tidy_versions_test",
        ],
        { stdio: "ignore" },
      );
      break;
    } catch (error) {
      if (Date.now() > ready) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  await run("node", ["apps/web/scripts/setup-multiplayer-local.mjs"], { env });
  await run("bun", ["test", "apps/web/lib/realtime/commands.integration.test.mjs"], {
    env: { ...env, BELLA_REALTIME_URL: "" },
  });
  await run("bun", ["test", "apps/web/lib/design/file-versions.integration.test.ts"], {
    env: { ...env, BELLA_REALTIME_URL: "" },
  });
  const vars = join(temporary, "worker.env");
  await writeFile(
    vars,
    `DATABASE_URL=${database}\nBETTER_AUTH_URL=${app}\nBETTER_AUTH_SECRET=${secret}\n`,
  );
  const webLog = await log("web"),
    roomLog = await log("room");
  children.push(
    spawn("bun", ["run", "--cwd", "apps/web", "dev", "--", "--port", "3041"], {
      cwd: root,
      env,
      detached: true,
      stdio: ["ignore", webLog.fd, webLog.fd],
    }),
  );
  children.push(
    spawn(
      "bunx",
      [
        "wrangler",
        "dev",
        "--config",
        "wrangler.realtime.jsonc",
        "--port",
        "8841",
        "--env-file",
        vars,
        "--persist-to",
        join(temporary, "rooms"),
      ],
      { cwd: web, env, detached: true, stdio: ["ignore", roomLog.fd, roomLog.fd] },
    ),
  );
  await Promise.all([waitFor(`${app}/login`), waitFor("http://localhost:8841/")]);
  await run("node", ["apps/web/scripts/test-file-version-history-browser.mjs"], {
    env: { ...env, VERSION_TEST_BASE_URL: app },
  });
  console.log("PASS: durable versions, authenticated two-browser restoration and Postgres checks");
} catch (error) {
  console.error(`Local test server logs: ${temporary}`);
  throw error;
} finally {
  for (const child of children)
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      /* Already stopped. */
    }
  await run("docker", ["rm", "-f", container], { stdio: "ignore" }).catch(() => {});
  // Preserve logs as evidence, including any failure, without preserving database data.
  await rm(join(temporary, "rooms"), { recursive: true, force: true });
}
