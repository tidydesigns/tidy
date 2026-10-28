import path from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolveDeploymentConfig } from "../../../scripts/deployment-config.mjs";
// This wrapper validates one top-level private target. Do not let an ambient
// Wrangler environment select a different target after those safety checks.
if (process.env.CLOUDFLARE_ENV || process.argv.length > 2)
  throw new Error(
    "Named environments and CLI arguments are not supported by the site deploy script. Unset CLOUDFLARE_ENV and use TIDY_SITE_DEPLOY_CONFIG with the intended target at the top level.",
  );
const config = await resolveDeploymentConfig(
  path.resolve(import.meta.dirname, ".."),
  "TIDY_SITE_DEPLOY_CONFIG",
);
const settings = Bun.JSONC.parse(await Bun.file(config).text());
if (!settings.name || settings.name.endsWith("-example"))
  throw new Error("Configure your own site Worker name before deploying.");
if (settings.workers_dev !== false || settings.preview_urls !== false)
  throw new Error("Set workers_dev and preview_urls to false in the private deployment config.");
// Existing private configs may still describe an assets-only site. Prepare the
// runtime entrypoint without editing the operator's config or changing its target.
const site = path.resolve(import.meta.dirname, "..");
const temporary = await mkdtemp(path.join(tmpdir(), "tidy-site-deploy-"));
const cancellation = new AbortController();
const onInterrupt = () => cancellation.abort("SIGINT");
const onTerminate = () => cancellation.abort("SIGTERM");
process.on("SIGINT", onInterrupt);
process.on("SIGTERM", onTerminate);
try {
  const prepared = path.join(temporary, "wrangler.deploy.jsonc");
  await writeFile(
    prepared,
    JSON.stringify({
      ...settings,
      secrets: {
        ...settings.secrets,
        required: [...new Set([...(settings.secrets?.required ?? []), "GITHUB_RELEASES_TOKEN"])],
      },
      main: path.join(site, "worker/index.ts"),
      assets: {
        ...settings.assets,
        directory: settings.assets?.directory
          ? path.resolve(path.dirname(config), settings.assets.directory)
          : path.join(site, "out"),
        binding: "ASSETS",
        run_worker_first: ["/download/mac", "/download/mac/"],
      },
    }),
    { mode: 0o600 },
  );
  // Assets-only Workers cannot accept runtime secrets before their first script
  // deployment. Upload the build secret with the new Worker version instead.
  const { GITHUB_RELEASES_TOKEN: releaseToken, ...deploymentEnv } = process.env;
  const secretArgs = [];
  if (releaseToken) {
    const secrets = path.join(temporary, "secrets.json");
    await writeFile(secrets, JSON.stringify({ GITHUB_RELEASES_TOKEN: releaseToken }), {
      mode: 0o600,
    });
    secretArgs.push("--secrets-file", secrets);
  }
  // An explicit empty environment also overrides selectors loaded by Wrangler
  // from dotenv files after this process has validated its environment.
  // Keep the value attached so subprocess forwarding cannot drop an empty arg.
  const child = Bun.spawn(
    ["bunx", "wrangler", "deploy", "--config", prepared, "--env=", "--keep-vars", ...secretArgs],
    { stdout: "inherit", stderr: "inherit", env: deploymentEnv, signal: cancellation.signal },
  );
  const exitCode = await child.exited;
  process.exitCode = cancellation.signal.aborted
    ? cancellation.signal.reason === "SIGINT"
      ? 130
      : 143
    : exitCode;
} finally {
  try {
    await rm(temporary, { recursive: true, force: true });
  } finally {
    process.off("SIGINT", onInterrupt);
    process.off("SIGTERM", onTerminate);
  }
}
