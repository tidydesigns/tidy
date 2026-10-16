import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { TraceMap, originalPositionFor } from "@jridgewell/trace-mapping";
import {
  bundleWorker,
  injectWorkerSourceMaps,
  runTool,
  validateWorkerSourceMap,
  workerDeploymentArgs,
} from "./worker-source-maps.mjs";

// Exercise the same final Wrangler bundle and PostHog injection as deployment,
// then capture the actual SDK wire payload inside workerd. No provider calls.
const require = createRequire(import.meta.url);
const wranglerRequire = createRequire(require.resolve("wrangler/package.json"));
const { Miniflare, convertV4MiniflareOptions } = wranglerRequire("miniflare");
const root = await mkdtemp(path.join(tmpdir(), "tidy-worker-source-maps-"));
const directory = path.join(root, "deploy");
const config = path.join(root, "wrangler.jsonc");
const fixture = fileURLToPath(new URL("./fixtures/worker-source-maps.ts", import.meta.url));
const env = {
  ...process.env,
  WRANGLER_SEND_METRICS: "false",
  CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false",
  OPEN_NEXT_DEPLOY: "true",
  POSTHOG_CLI_API_KEY: "phx_synthetic_local_key",
  POSTHOG_CLI_PROJECT_ID: "1",
  POSTHOG_CLI_HOST: "http://127.0.0.1:1",
  POSTHOG_CLI_DRY_RUN: "false",
};
let worker;
try {
  await writeFile(
    path.join(root, "worker.ts"),
    `export { default } from ${JSON.stringify(fixture)};\n`,
  );
  await writeFile(
    config,
    JSON.stringify({
      name: "source-map-fixture",
      main: "worker.ts",
      compatibility_date: "2026-09-26",
      compatibility_flags: ["nodejs_compat"],
    }),
  );
  const entrypoint = await bundleWorker({ config, directory, cwd: root, env });
  await injectWorkerSourceMaps({ directory, env });
  const map = await validateWorkerSourceMap(entrypoint, { injected: true });

  // Prove the final deployment pass doesn't rewrite injected JS or its positions.
  const shipped = path.join(root, "shipped");
  runTool(
    path.join(path.dirname(require.resolve("wrangler/package.json")), "bin/wrangler.js"),
    [
      // OpenNext forwards these arguments to Wrangler, consuming the separator.
      ...workerDeploymentArgs(config, entrypoint).filter((arg) => arg !== "--"),
      "--dry-run",
      "--outdir",
      shipped,
      "--env-file",
      "/dev/null",
    ],
    { cwd: root, env },
  );
  assert.equal(
    await readFile(path.join(shipped, "worker.js"), "utf8"),
    await readFile(entrypoint, "utf8"),
  );

  const events = [];
  worker = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      modulesRoot: directory,
      scriptPath: entrypoint,
      compatibilityDate: "2026-09-26",
      compatibilityFlags: ["nodejs_compat"],
      outboundService: async (request) => {
        assert.equal(new URL(request.url).origin, "https://collector.invalid");
        const bytes = Buffer.from(await request.arrayBuffer());
        const body = JSON.parse(
          (request.headers.get("content-encoding") === "gzip"
            ? gunzipSync(bytes)
            : bytes
          ).toString(),
        );
        events.push(...(body.batch ?? [body]));
        return Response.json({ status: 1 });
      },
    }),
  );
  assert.equal(await (await worker.dispatchFetch("https://fixture.invalid")).text(), "reported");
  assert.equal(events.length, 1, "the Worker must deliver its exception");
  const event = events[0];
  const frames = event.properties.$exception_list[0].stacktrace.frames;
  assert.ok(frames.length > 0, "sanitization must retain stack frames");
  const trace = new TraceMap(map);
  const source = await readFile(fixture, "utf8");
  const throwLine = source.split("\n").findIndex((line) => line.includes("throw new Error")) + 1;
  for (const frame of frames) {
    assert.equal(frame.function, "<redacted>");
    assert.equal(frame.chunk_id, map.chunk_id);
    assert.equal(frame.filename, "worker.js");
  }
  assert.ok(
    frames.some((frame) => {
      const position = originalPositionFor(trace, { line: frame.lineno, column: frame.colno });
      return (
        position.source?.endsWith("fixtures/worker-source-maps.ts") && position.line === throwLine
      );
    }),
    "the captured stack must map to the original TypeScript throw site",
  );
  const payload = JSON.stringify(event);
  for (const sensitive of [
    "private-error-message-with-token",
    "private-cause",
    "sourcesContent",
    root,
    "phx_synthetic_local_key",
  ])
    assert.ok(!payload.includes(sensitive), `outbound exception must exclude ${sensitive}`);
  assert.equal(event.distinct_id, "tidy-server");
  assert.equal(event.properties.$process_person_profile, false);
  console.log(
    "PASS: final Worker bytes, chunk ID, original throw location and private exception filtering survive deployment and workerd capture",
  );
} finally {
  await worker?.dispose();
  await rm(root, { recursive: true, force: true });
}
