import path from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolveDeploymentConfig } from "../../../scripts/deployment-config.mjs";
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
  const child = Bun.spawn(["bunx", "wrangler", "deploy", "--config", prepared, "--keep-vars"], {
    stdout: "inherit",
    stderr: "inherit",
  });
  process.exitCode = await child.exited;
} finally {
  await rm(temporary, { recursive: true, force: true });
}
