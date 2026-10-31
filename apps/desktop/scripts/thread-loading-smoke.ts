import { spawn } from "node:child_process";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const electron: unknown = createRequire(import.meta.url)("electron");
if (typeof electron !== "string") throw new Error("Could not locate the Electron executable.");
const desktop = fileURLToPath(new URL("..", import.meta.url));
const temporary = await mkdtemp(join(tmpdir(), "tidy-thread-tests-"));
try {
  const assets = join(desktop, "out/renderer/assets");
  const css = (await readdir(assets)).find((name) => /^index-.*\.css$/.test(name));
  if (!css) throw new Error("Build the desktop app before running its renderer tests.");
  const [renderer, runner] = await Promise.all([
    Bun.build({
      entrypoints: [join(desktop, "src/renderer/src/app/fixtures/thread-loading.tsx")],
      target: "browser",
      define: { "process.env.NODE_ENV": '"production"', "import.meta.env.DEV": "false" },
      outdir: join(temporary, "renderer"),
    }),
    Bun.build({
      entrypoints: [join(desktop, "scripts/thread-loading-electron.ts")],
      target: "node",
      external: ["electron"],
      outdir: join(temporary, "runner"),
      naming: "[name].mjs",
    }),
  ]);
  if (!renderer.success || !runner.success)
    throw new AggregateError([...renderer.logs, ...runner.logs], "Could not build renderer tests.");
  const html = join(temporary, "index.html");
  await writeFile(
    html,
    `<!doctype html><html><head><link rel="stylesheet" href="${pathToFileURL(join(assets, css)).href}"><style>html,body,#root{height:800px;width:1100px;margin:0}#root{display:flex;flex-direction:column}.conversation{height:760px}</style></head><body><div id="root"></div><script type="module" src="./renderer/thread-loading.js"></script></body></html>`,
  );
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(
    electron,
    [
      join(temporary, "runner/thread-loading-electron.mjs"),
      html,
      join(desktop, "out/preload/index.cjs"),
      join(temporary, "user-data"),
    ],
    { env, stdio: "inherit" },
  );
  const deadline = setTimeout(() => child.kill("SIGKILL"), 30_000);
  try {
    await new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => {
        if (code === 0) resolve();
        else reject(new Error(`Renderer tests failed (${signal ?? code}).`));
      });
    });
  } finally {
    clearTimeout(deadline);
  }
} finally {
  await rm(temporary, { recursive: true, force: true });
}
