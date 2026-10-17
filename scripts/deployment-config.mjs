import { chmodSync, existsSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";

// Reuse the existing Worker's resources without storing production bindings in Git.
export function configFromBindings(template, bindings) {
  const config = structuredClone(template);
  config.vars = {};
  config.r2_buckets = [];
  config.hyperdrive = [];
  config.services = [];
  config.durable_objects = { bindings: [] };
  delete config.images;
  for (const binding of bindings) {
    const { name, type } = binding;
    switch (type) {
      case "plain_text":
        config.vars[name] = binding.text;
        break;
      case "json":
        config.vars[name] =
          typeof binding.json === "string" ? JSON.parse(binding.json) : binding.json;
        break;
      case "secret_text":
      case "assets":
      case "version_metadata":
        // Wrangler preserves secrets; assets and version metadata come from the build template.
        break;
      case "r2_bucket":
        config.r2_buckets.push({
          binding: name,
          bucket_name: binding.bucket_name,
          ...(binding.jurisdiction ? { jurisdiction: binding.jurisdiction } : {}),
        });
        break;
      case "hyperdrive":
        config.hyperdrive.push({ binding: name, id: binding.id });
        break;
      case "service":
        config.services.push({
          binding: name,
          service: binding.service,
          ...(binding.environment ? { environment: binding.environment } : {}),
          ...(binding.entrypoint ? { entrypoint: binding.entrypoint } : {}),
        });
        break;
      case "durable_object_namespace":
        if (!binding.class_name) throw new Error(`Missing Durable Object class for ${name}.`);
        config.durable_objects.bindings.push({
          name,
          class_name: binding.class_name,
          ...(binding.script_name ? { script_name: binding.script_name } : {}),
          ...(binding.environment ? { environment: binding.environment } : {}),
        });
        break;
      case "images":
        config.images = { binding: name };
        break;
      default:
        throw new Error(`Supply a private deployment config for unsupported binding type ${type}.`);
    }
  }
  const required = [
    ["HYPERDRIVE", "hyperdrive"],
    ["IMAGES", "images"],
    ["WORKER_SELF_REFERENCE", "service"],
    [template.assets.binding, "assets"],
    [template.version_metadata.binding, "version_metadata"],
    ...template.r2_buckets.map((binding) => [binding.binding, "r2_bucket"]),
    ...template.durable_objects.bindings.map((binding) => [
      binding.name,
      "durable_object_namespace",
    ]),
  ];
  for (const [name, type] of required) {
    if (!bindings.some((binding) => binding.name === name && binding.type === type))
      throw new Error(`The existing Worker is missing required binding ${name}.`);
  }
  for (const expected of template.durable_objects.bindings) {
    const actual = config.durable_objects.bindings.find(
      (binding) => binding.name === expected.name,
    );
    if (actual.class_name !== expected.class_name || actual.script_name || actual.environment)
      throw new Error(
        `The existing Durable Object ${expected.name} must match the local exported class.`,
      );
  }
  if (
    !config.services.some(
      (binding) => binding.binding === "WORKER_SELF_REFERENCE" && binding.service === config.name,
    )
  )
    throw new Error("The self-reference binding must target the configured Worker.");
  return config;
}

export function deploymentAuthHeaders(credentials) {
  if (typeof credentials?.token === "string" && credentials.token)
    return { Authorization: `Bearer ${credentials.token}` };
  if (credentials?.type === "api_key" && credentials.key && credentials.email)
    return { "X-Auth-Key": credentials.key, "X-Auth-Email": credentials.email };
  throw new Error("Missing valid Cloudflare deployment credentials.");
}

/** Read-only preflight, including when the operator supplies a private config. */
export async function readWorkerBindings(directory, name, configuredAccount) {
  const wrangler = (...args) =>
    JSON.parse(
      execFileSync("bunx", ["wrangler", ...args, "--json"], {
        cwd: directory,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );
  let headers, account;
  try {
    headers = deploymentAuthHeaders(wrangler("auth", "token"));
    account = configuredAccount ?? process.env.CLOUDFLARE_ACCOUNT_ID;
    if (!account) {
      const { accounts } = wrangler("whoami");
      if (accounts?.length !== 1) throw new Error("Choose an account.");
      account = accounts[0].id;
    }
  } catch {
    throw new Error("Cannot read deployment credentials/account for the read-only preflight.");
  }
  if (!/^[a-f0-9]{32}$/.test(account))
    throw new Error("Missing valid Cloudflare deployment credentials/account.");
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${account}/workers/scripts/${encodeURIComponent(name)}/settings`,
    {
      headers,
      signal: AbortSignal.timeout(30_000),
    },
  );
  const settings = await response.json();
  if (!response.ok || !settings.success || !Array.isArray(settings.result?.bindings))
    throw new Error("Cannot read existing Worker bindings. No bindings were changed.");
  return { account, bindings: settings.result.bindings };
}

export function assertRuntimeSafety(config, bindings) {
  if (config.workers_dev !== false || config.preview_urls !== false)
    throw new Error(
      "Set workers_dev and preview_urls to false in the private deployment config; use the configured custom hostname.",
    );
  const cpu = config.limits?.cpu_ms;
  if (!Number.isSafeInteger(cpu) || cpu <= 0 || cpu > 30_000)
    throw new Error(
      "Configure an explicit CPU limit of at most 30000 ms; profile the default 10000 ms against your largest supported requests.",
    );
  if (
    !bindings.some(
      (binding) => binding.name === "BETTER_AUTH_SECRET" && binding.type === "secret_text",
    )
  )
    throw new Error("Provision the required Worker secret BETTER_AUTH_SECRET before deployment.");
  if (
    !bindings.some(
      (binding) => binding.name === "PRIVACY_CLEANUP_SECRET" && binding.type === "secret_text",
    )
  )
    console.warn(
      "Scheduled privacy cleanup requires PRIVACY_CLEANUP_SECRET; deployment can continue without enabling it.",
    );
}

export async function resolveDeploymentConfig(directory, variable, { runtime = false } = {}) {
  const configured = process.env[variable];
  const file = path.resolve(directory, configured ?? "wrangler.deploy.jsonc");
  if (path.basename(file) !== "wrangler.deploy.jsonc")
    throw new Error(`${variable} must point to a private wrangler.deploy.jsonc.`);
  if (configured && existsSync(file)) return file;
  if (process.env.WORKERS_CI !== "1" || file !== path.join(directory, "wrangler.deploy.jsonc"))
    throw new Error(
      `Set ${variable} to your private wrangler.deploy.jsonc. See README.md#self-hosting.`,
    );

  let config = Bun.JSONC.parse(await Bun.file(path.join(directory, "wrangler.jsonc")).text());
  if (runtime) {
    const { account, bindings } = await readWorkerBindings(directory, config.name);
    config = configFromBindings(config, bindings);
    assertRuntimeSafety(config, bindings);
    config.account_id = account;
  }
  writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
  return file;
}
