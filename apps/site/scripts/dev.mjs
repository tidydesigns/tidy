import worker from "../worker/index.ts";

// Next's exported pages stay static. Serve the same Worker handler behind a
// development-only rewrite, on an ephemeral loopback port for parallel worktrees.
const downloads = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: (request) =>
    worker.fetch(request, {
      ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) },
      DESKTOP_RELEASE_REPOSITORY: process.env.DESKTOP_RELEASE_REPOSITORY,
      GITHUB_RELEASES_TOKEN: process.env.GITHUB_RELEASES_TOKEN,
    }),
});
const child = Bun.spawn(["bunx", "next", "dev", "--port", "3001", ...process.argv.slice(2)], {
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
  env: { ...process.env, TIDY_SITE_DOWNLOAD_ORIGIN: downloads.url.origin },
});
const stop = () => {
  child.kill();
  downloads.stop(true);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
try {
  process.exitCode = await child.exited;
} finally {
  downloads.stop(true);
}
