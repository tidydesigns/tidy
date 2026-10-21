import { spawnSync } from "node:child_process";

// Run Miniflare under Node: Bun's replacement for Undici ignores dispatchers.
// Keep Bun's bundler and the fixture's fault-injection plugins in a build-only
// subprocess. It exits here, before any Worker or test requests are started.
export async function buildWorkerFixture(options) {
  if (process.env.TIDY_WORKER_BUILD_ONLY === "1") {
    const build = await Bun.build({
      ...options,
      plugins: [
        ...(options.plugins ?? []),
        {
          // Next removes this compile-time marker in server bundles. These
          // standalone server fixtures must give it the same empty runtime.
          name: "server-only-marker",
          setup(builder) {
            builder.onResolve({ filter: /^server-only$/ }, () => ({
              path: "server-only",
              namespace: "server-only-marker",
            }));
            builder.onLoad({ filter: /.*/, namespace: "server-only-marker" }, () => ({
              contents: "",
              loader: "js",
            }));
          },
        },
      ],
    });
    if (!build.success) throw new AggregateError(build.logs, "Worker fixture build failed");
    const script = await build.outputs[0].text();
    await new Promise((resolve) => process.stdout.write(script, resolve));
    process.exit(0);
  }
  if (process.versions.bun) throw new Error("Run Worker tests with node, not bun.");
  const result = spawnSync("bun", [process.argv[1]], {
    env: { ...process.env, TIDY_WORKER_BUILD_ONLY: "1" },
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    timeout: 30_000,
  });
  if (result.error || result.status !== 0) {
    throw result.error ?? new Error(`Worker fixture build failed: ${result.stderr}`);
  }
  return { success: true, outputs: [{ text: async () => result.stdout }] };
}
