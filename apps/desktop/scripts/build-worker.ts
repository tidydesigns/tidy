import { resolve } from "node:path";
import { bundleLicenseBanner } from "../../../scripts/bundle-licenses";

export async function bundledComputeWorker() {
  const result = await Bun.build({
    entrypoints: [resolve(import.meta.dirname, "../src/main/cloud/cloud-compute-worker.ts")],
    target: "node",
    tsconfig: resolve(import.meta.dirname, "../tsconfig.node.json"),
    format: "cjs",
    metafile: true,
  });
  if (!result.success) throw new AggregateError(result.logs, "Backend worker build failed.");
  const output = result.outputs[0];
  if (!output) throw new Error("Backend worker output is missing.");
  const source =
    (await bundleLicenseBanner(result)) +
    'import { createRequire } from "node:module"; const require = createRequire(process.execPath); const module = { exports: {} }; const exports = module.exports;\n' +
    (await output.text());
  return "data:text/javascript;base64," + Buffer.from(source).toString("base64");
}
