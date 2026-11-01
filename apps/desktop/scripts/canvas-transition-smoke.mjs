import { createServer } from "node:http";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join, extname, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";

const timeout = Number(process.env.CANVAS_TRANSITION_TIMEOUT ?? 240_000);
if (!Number.isInteger(timeout) || timeout <= 0 || timeout > 2_147_483_647)
  throw Error(
    "CANVAS_TRANSITION_TIMEOUT must be a positive integer of milliseconds within the timer limit",
  );

const desktop = fileURLToPath(new URL("..", import.meta.url));
const temporary = await mkdtemp(join(tmpdir(), "tidy-canvas-transitions-"));
const mime = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".avif": "image/avif",
  ".woff2": "font/woff2",
};
let releaseEditor = () => {};
let editorReady = Promise.resolve();
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, "http://localhost");
    const path = decodeURIComponent(url.pathname);
    if (path === "/desktop-demo/") {
      releaseEditor();
      editorReady = url.searchParams.has("cold")
        ? new Promise((resolve) => {
            releaseEditor = resolve;
          })
        : Promise.resolve();
    }
    if (path === "/__fixtures/release-editor" && request.method === "POST") {
      releaseEditor();
      response.end("ok");
      return;
    }
    if (/\/file-editor-.*\.js$/.test(path)) await editorReady;
    const demo = path.startsWith("/desktop-demo/");
    const root = resolve(desktop, demo ? "demo-dist" : "../site/public");
    const relative = demo ? path.slice("/desktop-demo/".length) : path.slice(1);
    const file = resolve(root, relative || "index.html");
    if (!file.startsWith(root + sep)) throw Error("Invalid fixture path");
    response.setHeader("Content-Type", mime[extname(file)] ?? "application/octet-stream");
    response.setHeader("Cache-Control", "no-store");
    response.end(await readFile(file));
  } catch {
    response.writeHead(404).end();
  }
});
try {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const build = await Bun.build({
    entrypoints: [join(desktop, "scripts/canvas-transition-electron.mjs")],
    target: "node",
    external: ["electron"],
    outdir: temporary,
    naming: "runner.mjs",
  });
  if (!build.success)
    throw new AggregateError(build.logs, "Could not build canvas transition tests");
  const electron = createRequire(import.meta.url)("electron");
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  const child = spawn(
    electron,
    [join(temporary, "runner.mjs"), `http://127.0.0.1:${port}`, join(temporary, "profile")],
    { env: environment, stdio: "inherit" },
  );
  let escalation;
  let timedOut = false;
  const deadline = setTimeout(() => {
    timedOut = true;
    console.error(`Canvas transition regressions exceeded ${timeout} ms; sending SIGTERM`);
    child.kill("SIGTERM");
    escalation = setTimeout(() => child.kill("SIGKILL"), 5_000);
  }, timeout);
  try {
    await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) =>
        code === 0 && !timedOut
          ? resolve()
          : reject(
              Error(
                `Canvas transition regressions failed (${timedOut ? "timeout" : (signal ?? code)})`,
              ),
            ),
      );
    });
  } finally {
    clearTimeout(deadline);
    clearTimeout(escalation);
  }
} finally {
  releaseEditor();
  await new Promise((resolve) => server.close(resolve));
  await rm(temporary, { recursive: true, force: true });
}
