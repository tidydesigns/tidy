import { bundledComputeWorker } from "./build-worker";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { bundleLicenseBanner } from "../../../scripts/bundle-licenses";
import { execFileSync } from "node:child_process";

// Source ordering stays stable when an older checkout is rebuilt on another machine.
let sourceTimestamp = 0;
try {
  const value = Number(
    execFileSync("git", ["show", "-s", "--format=%ct", "HEAD"], {
      cwd: import.meta.dirname,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim(),
  );
  if (Number.isSafeInteger(value) && value > 0) sourceTimestamp = value;
} catch {
  // Unversioned source builds can connect, but cannot replace a versioned backend.
}
const releaseTimestamp = process.env.TIDY_HOST_SOURCE_TIMESTAMP;
if (releaseTimestamp !== undefined) {
  const value = Number(releaseTimestamp);
  if (!/^[1-9]\d*$/.test(releaseTimestamp) || !Number.isSafeInteger(value))
    throw new Error(
      "TIDY_HOST_SOURCE_TIMESTAMP must be the source revision's positive Unix timestamp.",
    );
  sourceTimestamp = value;
}

const result = await Bun.build({
  entrypoints: [resolve(import.meta.dirname, "host.ts")],
  target: "node",
  define: {
    TIDY_COMPUTE_WORKER_SOURCE: JSON.stringify(await bundledComputeWorker()),
    TIDY_HOST_SOURCE_TIMESTAMP: String(sourceTimestamp),
  },
  format: "esm",
  metafile: true,
});
if (!result.success) throw new AggregateError(result.logs, "Backend build failed.");
const banner = await bundleLicenseBanner(result);
const directory = resolve(import.meta.dirname, "../out/host");
await mkdir(directory, { recursive: true });
await writeFile(resolve(directory, "tidy-host.js"), banner + (await result.outputs[0].text()));
