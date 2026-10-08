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
    const wrangler = (...args) =>
      JSON.parse(
        execFileSync("bunx", ["wrangler", ...args, "--json"], {
          cwd: directory,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        }),
      );
    let token, account;
    try {
      ({ token } = wrangler("auth", "token"));
      account = process.env.CLOUDFLARE_ACCOUNT_ID;
      if (!account) {
        const { accounts } = wrangler("whoami");
        if (accounts?.length !== 1) throw new Error("Choose an account.");
        account = accounts[0].id;
      }
    } catch {
      throw new Error(
        "Cannot read Wrangler credentials/account; supply a private deployment config or CLOUDFLARE_ACCOUNT_ID.",
      );
    }
    if (!token || !/^[a-f0-9]{32}$/.test(account))
      throw new Error("Missing valid Cloudflare deployment credentials/account.");
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${account}/workers/scripts/${encodeURIComponent(config.name)}/settings`,
      { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000) },
    );
    const settings = await response.json();
    if (!response.ok || !settings.success || !Array.isArray(settings.result?.bindings))
      throw new Error(
        "Cannot read existing Worker bindings; supply a private deployment config. No bindings were changed.",
      );
    config = configFromBindings(config, settings.result.bindings);
    config.account_id = account;
  }
  writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
  return file;
}
