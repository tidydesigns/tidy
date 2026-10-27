import { bundledComputeWorker } from "./build-worker";
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { createRequire } from "node:module";

const root = resolve(import.meta.dirname, "..");
const output = resolve(root, "out/remote-fixture.js");
await mkdir(resolve(root, "out"), { recursive: true });
const result = await Bun.build({
  entrypoints: [resolve(root, "scripts/remote-fixture.ts")],
  target: "node",
  define: { TIDY_COMPUTE_WORKER_SOURCE: JSON.stringify(await bundledComputeWorker()) },
  format: "esm",
  external: ["electron"],
  outdir: resolve(root, "out"),
});
if (!result.success) throw new AggregateError(result.logs, "Could not build remote fixture.");
const electron: unknown = createRequire(import.meta.url)("electron");
if (typeof electron !== "string") throw new Error("Electron executable is missing.");
const environment = { ...process.env };
delete environment.ELECTRON_RUN_AS_NODE;
const child = spawn(
  electron,
  [
    ...(process.platform === "linux"
      ? ["--ozone-platform=headless", "--ozone-override-screen-size=1200,800", "--disable-gpu"]
      : []),
    output,
  ],
  { cwd: root, env: environment, stdio: "inherit" },
);
process.once("SIGINT", () => child.kill("SIGINT"));
process.once("SIGTERM", () => child.kill("SIGTERM"));
const timeout = setTimeout(() => {
  console.error("Remote integration test timed out.");
  child.kill("SIGKILL");
}, 90_000);
child.once("error", (error) => {
  clearTimeout(timeout);
  console.error(error);
  process.exitCode = 1;
});
child.once("exit", (code) => {
  clearTimeout(timeout);
  process.exitCode = code ?? 1;
});
