import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";

const require = createRequire(import.meta.url);
const wrangler = path.join(
  path.dirname(require.resolve("wrangler/package.json")),
  "bin/wrangler.js",
);
const posthog = require.resolve("@posthog/cli/run-posthog-cli.js");

export function runTool(script, args, options) {
  execFileSync("node", [script, ...args], { stdio: "inherit", ...options });
}

export function uploadWorkerSourceMapsEnabled(env) {
  return (
    (env.NEXT_PUBLIC_POSTHOG_ENABLED === "1" || env.POSTHOG_SERVER_ERRORS_ENABLED === "1") &&
    env.POSTHOG_UPLOAD_SOURCEMAPS === "1"
  );
}

// Run Wrangler's final bundling pass before uploading symbols. Deployment must
// consume this output with --no-bundle, including Wrangler's Node polyfills.
export async function bundleWorker({ config, directory, cwd, env = process.env, run = runTool }) {
  await rm(directory, { recursive: true, force: true });
  await run(
    wrangler,
    [
      "deploy",
      "--config",
      config,
      "--dry-run",
      "--outdir",
      directory,
      "--upload-source-maps",
      "--env-file",
      "/dev/null",
    ],
    {
      cwd,
      env: {
        ...env,
        OPEN_NEXT_DEPLOY: "true",
        CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false",
        WRANGLER_SEND_METRICS: "false",
      },
    },
  );
  const entrypoint = path.join(directory, "worker.js");
  await validateWorkerSourceMap(entrypoint);
  await assertNoCredentials(directory, env);
  return entrypoint;
}

export async function validateWorkerSourceMap(entrypoint, { injected = false } = {}) {
  const code = await readFile(entrypoint, "utf8");
  const map = JSON.parse(await readFile(`${entrypoint}.map`, "utf8"));
  if (
    map.version !== 3 ||
    !map.mappings?.length ||
    !map.sources?.length ||
    !map.sourcesContent?.some((source) => source?.length) ||
    !code.includes(`sourceMappingURL=${path.basename(entrypoint)}.map`)
  )
    throw new Error("Final Worker source map is missing code mappings or source content.");
  if (
    injected &&
    (!/^[\da-f-]{36}$/i.test(map.chunk_id ?? "") ||
      !code.includes(`//# chunkId=${map.chunk_id}`) ||
      !code.includes("_posthogChunkIds"))
  )
    throw new Error("Final Worker and source map do not share an injected PostHog chunk ID.");
  return map;
}

// Scan source content as well as executable code before sending artifacts to
// either provider. Build/operator credentials must never enter a source map.
export async function assertNoCredentials(directory, env) {
  const secrets = Object.entries(env)
    .filter(
      ([name, value]) =>
        value &&
        !name.startsWith("NEXT_PUBLIC_") &&
        /SECRET|TOKEN|PASSWORD|PRIVATE_KEY|ENCRYPTION_KEY|DATABASE_URL|API_KEY|CONNECTION_STRING/.test(
          name,
        ),
    )
    .flatMap(([, value]) => [value, JSON.stringify(value).slice(1, -1)]);
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) await assertNoCredentials(file, env);
    else if (entry.isFile() && secrets.length) {
      const bytes = await readFile(file);
      if (secrets.some((secret) => bytes.includes(secret)))
        throw new Error(`Private credential found in deployment artifact: ${file}`);
    }
  }
}

export async function injectWorkerSourceMaps({ directory, release, env, run = runTool }) {
  await run(
    posthog,
    [
      "sourcemap",
      "inject",
      "--directory",
      directory,
      ...(release ? ["--release-name", "tidy-app", "--release-version", release] : []),
    ],
    { cwd: directory, env },
  );
  await validateWorkerSourceMap(path.join(directory, "worker.js"), { injected: true });
}

export async function uploadWorkerSourceMaps({ directory, release, env, run = runTool }) {
  if (!env.POSTHOG_API_KEY || !env.POSTHOG_PROJECT_ID)
    throw new Error("POSTHOG_API_KEY and POSTHOG_PROJECT_ID are required to upload Worker maps.");
  if (!release || !/^[\w.-]{1,100}$/.test(release))
    throw new Error("A valid built app version is required to upload Worker maps.");
  if (["1", "true"].includes(env.POSTHOG_CLI_DRY_RUN))
    throw new Error("POSTHOG_CLI_DRY_RUN cannot be used for a source-mapped deployment.");
  const cliEnv = {
    ...env,
    POSTHOG_CLI_API_KEY: env.POSTHOG_API_KEY,
    POSTHOG_CLI_PROJECT_ID: env.POSTHOG_PROJECT_ID,
    POSTHOG_CLI_HOST: env.POSTHOG_API_HOST ?? "https://eu.posthog.com",
  };
  await assertNoCredentials(directory, cliEnv);
  await injectWorkerSourceMaps({ directory, release, env: cliEnv, run });
  // Retain maps for Cloudflare's upload. This directory is outside public assets.
  // Any failure stops deployment rather than publishing an unresolvable bundle.
  await run(
    posthog,
    [
      "sourcemap",
      "upload",
      "--directory",
      directory,
      "--release-name",
      "tidy-app",
      "--release-version",
      release,
    ],
    { cwd: directory, env: cliEnv },
  );
}

export function workerDeploymentArgs(config, entrypoint) {
  return [
    "deploy",
    entrypoint,
    "--config",
    config,
    "--",
    "--keep-vars",
    "--no-bundle",
    "--upload-source-maps",
  ];
}
