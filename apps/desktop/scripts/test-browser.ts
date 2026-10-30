import { bundledComputeWorker } from "./build-worker";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { createRequire } from "node:module";

const root = resolve(import.meta.dirname, "..");
const result = await Bun.build({
  entrypoints: [resolve(root, "scripts/browser-fixture.ts")],
  target: "node",
  define: { TIDY_COMPUTE_WORKER_SOURCE: JSON.stringify(await bundledComputeWorker()) },
  format: "esm",
  external: ["electron"],
  outdir: resolve(root, "out"),
});
if (!result.success) throw new AggregateError(result.logs, "Could not build browser fixture.");
const electron: unknown = createRequire(import.meta.url)("electron");
if (typeof electron !== "string") throw new Error("Electron executable is missing.");
const environment = { ...process.env };
delete environment.ELECTRON_RUN_AS_NODE;
const child = spawn(
  electron,
  [
    ...(process.platform === "linux"
      ? [
          "--ozone-platform=headless",
          "--ozone-override-screen-size=1440,960",
          "--disable-gpu",
          "--blink-settings=primaryPointerType=4,availablePointerTypes=4,primaryHoverType=2,availableHoverTypes=2",
        ]
      : []),
    resolve(root, "out/browser-fixture.js"),
  ],
  { cwd: root, env: environment, stdio: "inherit" },
);
process.once("SIGINT", () => child.kill("SIGINT"));
process.once("SIGTERM", () => child.kill("SIGTERM"));
const timeout = setTimeout(() => {
  console.error("Browser integration test timed out.");
  child.kill("SIGKILL");
}, 180000);
child.once("error", (error) => {
  clearTimeout(timeout);
  console.error(error);
  process.exitCode = 1;
});
child.once("exit", (code) => {
  clearTimeout(timeout);
  process.exitCode = code ?? 1;
});
