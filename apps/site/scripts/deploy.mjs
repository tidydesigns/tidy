import path from "node:path";
import { resolveDeploymentConfig } from "../../../scripts/deployment-config.mjs";
const config = await resolveDeploymentConfig(
  path.resolve(import.meta.dirname, ".."),
  "TIDY_SITE_DEPLOY_CONFIG",
);
const settings = Bun.JSONC.parse(await Bun.file(config).text());
if (!settings.name || settings.name.endsWith("-example"))
  throw new Error("Configure your own site Worker name before deploying.");
const child = Bun.spawn(["bunx", "wrangler", "deploy", "--config", config, "--keep-vars"], {
  stdout: "inherit",
  stderr: "inherit",
});
process.exitCode = await child.exited;
