import { bundledComputeWorker } from "./build-worker";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { bundleLicenseBanner } from "../../../scripts/bundle-licenses";

const result = await Bun.build({
  entrypoints: [resolve(import.meta.dirname, "host.ts")],
  target: "node",
  external: ["@lydell/node-pty"],
  define: { TIDY_COMPUTE_WORKER_SOURCE: JSON.stringify(await bundledComputeWorker()) },
  format: "esm",
  metafile: true,
});
if (!result.success) throw new AggregateError(result.logs, "Backend build failed.");
const banner = await bundleLicenseBanner(result);
const directory = resolve(import.meta.dirname, "../out/host");
await mkdir(directory, { recursive: true });
await writeFile(resolve(directory, "tidy-host.js"), banner + (await result.outputs[0].text()));
