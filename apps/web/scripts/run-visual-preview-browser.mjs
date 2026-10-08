import { spawn } from "node:child_process";
import { mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const temporary = await mkdtemp(join(tmpdir(), "tidy-visual-preview-"));
const container = `tidy-visual-preview-${crypto.randomUUID()}`;
const database = "postgres://tidy_test:tidy_local@127.0.0.1:55443/tidy_visual_preview_test";
const app = "http://localhost:3043";
const env = {
  ...process.env,
  DATABASE_URL: database,
  MULTIPLAYER_TEST_DATABASE_URL: database,
  VISUAL_PREVIEW_TEST_BASE_URL: app,
  VISUAL_PREVIEW_TEST_ARTIFACT_DIR: temporary,
  BETTER_AUTH_URL: app,
  BETTER_AUTH_SECRET: "tidy-disposable-visual-preview-secret-only",
  BELLA_REALTIME_URL: "",
  POSTHOG_API_KEY: "",
  POSTHOG_UPLOAD_SOURCEMAPS: "0",
  NEXT_PUBLIC_POSTHOG_HOST: "http://127.0.0.1:9",
  POSTHOG_HOST: "http://127.0.0.1:9",
  TIDY_AGENTS_ENABLED: "false",
};
const run = (command, args, options = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: "inherit", ...options });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`)),
    );
  });
let server;
try {
  await run("docker", [
    "run",
    "-d",
    "--name",
    container,
    "-e",
    "POSTGRES_DB=tidy_visual_preview_test",
    "-e",
    "POSTGRES_USER=tidy_test",
    "-e",
    "POSTGRES_PASSWORD=tidy_local",
    "-p",
    "127.0.0.1:55443:5432",
    "postgres:17",
  ]);
  const deadline = Date.now() + 30_000;
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
          "tidy_visual_preview_test",
        ],
        { stdio: "ignore" },
      );
      break;
    } catch (error) {
      if (Date.now() > deadline) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  await run("node", ["apps/web/scripts/setup-multiplayer-local.mjs"], { env });
  const log = await open(join(temporary, "web.log"), "w");
  server = spawn("bun", ["run", "--cwd", "apps/web", "dev", "--", "--port", "3043"], {
    cwd: root,
    env,
    detached: true,
    stdio: ["ignore", log.fd, log.fd],
  });
  const ready = Date.now() + 60_000;
  for (;;) {
    if (server.exitCode !== null) throw new Error("Local server stopped.");
    try {
      await fetch(`${app}/login`, { signal: AbortSignal.timeout(2000) });
      break;
    } catch (error) {
      if (Date.now() > ready) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  await run("node", ["apps/web/scripts/test-visual-preview-browser.mjs"], { env });
  if (env.T3_HTML_RENDER_SOURCE && env.T3_HTML_RENDER_BROWSER)
    await run(
      "node",
      [
        "apps/web/scripts/test-t3-html-compatibility.mjs",
        join(temporary, "preview.html"),
        temporary,
      ],
      { env },
    );
  console.log("PASS: authenticated MCP visual export and isolated browser acceptance");
} catch (error) {
  console.error(`Local acceptance logs: ${temporary}`);
  throw error;
} finally {
  if (server?.pid)
    try {
      process.kill(-server.pid, "SIGTERM");
    } catch {
      /* Already stopped. */
    }
  await run("docker", ["rm", "-f", container], { stdio: "ignore" }).catch(() => {});
  if (process.env.KEEP_VISUAL_PREVIEW_TEST_ARTIFACTS !== "1")
    await rm(temporary, { recursive: true, force: true });
}
