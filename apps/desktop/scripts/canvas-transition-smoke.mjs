import { createServer } from "node:http";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join, extname, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";

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
let delayEditor = false;
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, "http://localhost");
    const path = decodeURIComponent(url.pathname);
    if (path === "/desktop-demo/") delayEditor = url.searchParams.has("cold");
    if (delayEditor && /\/file-editor-.*\.js$/.test(path))
      await new Promise((resolve) => setTimeout(resolve, 3000));
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
  const deadline = setTimeout(() => child.kill("SIGKILL"), 120_000);
  try {
    await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) =>
        code === 0
          ? resolve()
          : reject(Error(`Canvas transition regressions failed (${signal ?? code})`)),
      );
    });
  } finally {
    clearTimeout(deadline);
  }
} finally {
  await new Promise((resolve) => server.close(resolve));
  await rm(temporary, { recursive: true, force: true });
}
