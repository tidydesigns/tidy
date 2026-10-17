import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  resolveDeploymentConfig,
  readWorkerBindings,
  assertRuntimeSafety,
} from "../../../scripts/deployment-config.mjs";
import {
  bundleWorker,
  uploadWorkerSourceMaps,
  uploadWorkerSourceMapsEnabled,
  workerDeploymentArgs,
} from "./worker-source-maps.mjs";

const config = await resolveDeploymentConfig(
  path.resolve(import.meta.dirname, ".."),
  "TIDY_DEPLOY_CONFIG",
  { runtime: true },
);
if (!existsSync(config) || path.basename(config) !== "wrangler.deploy.jsonc")
  throw new Error("Deployment requires an existing private wrangler.deploy.jsonc.");
const settings = Bun.JSONC.parse(await Bun.file(config).text());
let origin;
try {
  origin = new URL(settings.vars?.BETTER_AUTH_URL);
} catch {
  throw new Error("Configure a valid HTTPS auth origin before deployment.");
}
if (
  !settings.name ||
  settings.name.endsWith("-example") ||
  origin.protocol !== "https:" ||
  origin.username ||
  origin.password ||
  origin.pathname !== "/" ||
  origin.search ||
  origin.hash ||
  !settings.hyperdrive?.some(
    (binding) => binding.binding === "HYPERDRIVE" && /^[a-f0-9]{32}$/.test(binding.id),
  )
)
  throw new Error(
    "Configure your Worker name, HTTPS auth origin and Hyperdrive binding before deployment.",
  );
const cwd = path.resolve(import.meta.dirname, "..");
const { bindings } = await readWorkerBindings(cwd, settings.name, settings.account_id);
assertRuntimeSafety(settings, bindings);
const directory = path.join(cwd, ".open-next/deploy");
const entrypoint = await bundleWorker({ config, directory, cwd });
if (uploadWorkerSourceMapsEnabled(process.env)) {
  const { production } = await import(
    pathToFileURL(path.join(cwd, ".open-next/cloudflare/next-env.mjs")).href
  );
  await uploadWorkerSourceMaps({
    directory,
    release: production.NEXT_PUBLIC_APP_VERSION,
    env: process.env,
  });
}
const child = Bun.spawn(
  ["bunx", "opennextjs-cloudflare", ...workerDeploymentArgs(config, entrypoint)],
  {
    cwd,
    stdout: "inherit",
    stderr: "inherit",
    env: {
      ...process.env,
      CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE:
        process.env.CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE ??
        "postgres://127.0.0.1:5432/tidy",
    },
  },
);
process.exitCode = await child.exited;
