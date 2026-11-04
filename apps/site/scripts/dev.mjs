import worker from "../worker/index.ts";

const localOrigin = `http://localhost:${process.env.PORT || "3001"}`;
const site = new URL(process.env.NEXT_PUBLIC_SITE_URL || localOrigin);
if (site.origin !== localOrigin)
  console.warn(
    `Website consent requests require the browser origin to match NEXT_PUBLIC_SITE_URL (${site.origin}). The default local server origin is ${localOrigin}; align these values when testing analytics.`,
  );

// Next's exported pages stay static. Serve the same Worker handler behind a
// development-only rewrite, on an ephemeral loopback port for parallel worktrees.
const downloads = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: (request) => {
    const url = new URL(request.url);
    url.host = site.host;
    url.protocol = site.protocol;
    return worker.fetch(new Request(url, request), {
      ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) },
      DESKTOP_RELEASE_REPOSITORY: process.env.DESKTOP_RELEASE_REPOSITORY,
      GITHUB_RELEASES_TOKEN: process.env.GITHUB_RELEASES_TOKEN,
      ANALYTICS_APP_ORIGIN: process.env.ANALYTICS_APP_ORIGIN,
    });
  },
});
const child = Bun.spawn(
  ["bunx", "next", "dev", "--port", process.env.PORT || "3001", ...process.argv.slice(2)],
  {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
    env: { ...process.env, TIDY_SITE_DOWNLOAD_ORIGIN: downloads.url.origin },
  },
);
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
