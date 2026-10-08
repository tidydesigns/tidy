import { describe, expect, test } from "bun:test";
import {
  configFromBindings,
  resolveDeploymentConfig,
} from "../../../scripts/deployment-config.mjs";
import { mkdtempSync, writeFileSync, readFileSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const template = {
  name: "fixture-app",
  vars: { BETTER_AUTH_URL: "http://localhost:3000" },
  r2_buckets: [
    { binding: "DESIGN_OBJECTS", bucket_name: "example" },
    { binding: "FEEDBACK_IMAGES", bucket_name: "example" },
  ],
  hyperdrive: [],
  services: [{ binding: "WORKER_SELF_REFERENCE", service: "example" }],
  images: { binding: "IMAGES" },
  assets: { binding: "ASSETS", directory: ".open-next/assets" },
  version_metadata: { binding: "CF_VERSION_METADATA" },
  durable_objects: {
    bindings: [
      { name: "FILE_ROOMS", class_name: "FileRoom" },
      { name: "AUTH_GUARD", class_name: "AuthGuard" },
    ],
  },
  migrations: [{ tag: "existing-v1", new_sqlite_classes: ["FileRoom", "AuthGuard"] }],
};
const bindings = [
  { name: "BETTER_AUTH_URL", type: "plain_text", text: "https://app.example.test" },
  { name: "BETTER_AUTH_SECRET", type: "secret_text", text: "must-not-be-copied" },
  { name: "DESIGN_OBJECTS", type: "r2_bucket", bucket_name: "fixture-design" },
  {
    name: "FEEDBACK_IMAGES",
    type: "r2_bucket",
    bucket_name: "fixture-feedback",
    jurisdiction: "eu",
  },
  { name: "HYPERDRIVE", type: "hyperdrive", id: "a".repeat(32) },
  {
    name: "WORKER_SELF_REFERENCE",
    type: "service",
    service: "fixture-app",
    environment: "production",
  },
  { name: "IMAGES", type: "images" },
  {
    name: "FILE_ROOMS",
    type: "durable_object_namespace",
    class_name: "FileRoom",
    namespace_id: "existing-file-namespace",
  },
  {
    name: "AUTH_GUARD",
    type: "durable_object_namespace",
    class_name: "AuthGuard",
    namespace_id: "existing-auth-namespace",
  },
  { name: "ASSETS", type: "assets" },
  { name: "CF_VERSION_METADATA", type: "version_metadata" },
];

describe("existing Worker deployment configuration", () => {
  test("replaces example resources and localhost origin while keeping generated assets, migrations and secrets private", () => {
    const config = configFromBindings(template, bindings);
    expect(config.vars).toEqual({ BETTER_AUTH_URL: "https://app.example.test" });
    expect(config.hyperdrive).toEqual([{ binding: "HYPERDRIVE", id: "a".repeat(32) }]);
    expect(
      config.r2_buckets.map((binding: { bucket_name: string }) => binding.bucket_name),
    ).toEqual(["fixture-design", "fixture-feedback"]);
    expect(config.assets).toEqual(template.assets);
    expect(config.migrations).toEqual(template.migrations);
    expect(config.durable_objects).toEqual(template.durable_objects);
    expect(JSON.stringify(config)).not.toContain("must-not-be-copied");
    expect(template.vars.BETTER_AUTH_URL).toBe("http://localhost:3000");
  });
  test("fails instead of dropping an unrecognized existing resource", () => {
    expect(() =>
      configFromBindings(template, [...bindings, { name: "QUEUE", type: "queue" }]),
    ).toThrow("unsupported binding type queue");
  });
  test("fails if a required database binding is absent", () => {
    expect(() =>
      configFromBindings(
        template,
        bindings.filter((binding) => binding.name !== "HYPERDRIVE"),
      ),
    ).toThrow("missing required binding HYPERDRIVE");
  });
  test("fails if the self-reference targets another Worker", () => {
    expect(() =>
      configFromBindings(
        template,
        bindings.map((binding) =>
          binding.name === "WORKER_SELF_REFERENCE"
            ? { ...binding, service: "other-worker" }
            : binding,
        ),
      ),
    ).toThrow("self-reference binding");
  });
  test("fails instead of changing the class behind an existing Durable Object namespace", () => {
    expect(() =>
      configFromBindings(
        template,
        bindings.map((binding) =>
          binding.name === "FILE_ROOMS" ? { ...binding, class_name: "OtherRoom" } : binding,
        ),
      ),
    ).toThrow("must match the local exported class");
  });
});

test("fresh Cloudflare site checkout generates a private config; local deployments require an explicit config", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "tidy-deploy-config-"));
  const variable = "TIDY_FIXTURE_DEPLOY_CONFIG";
  const previousCI = process.env.WORKERS_CI;
  const previousConfig = process.env[variable];
  try {
    delete process.env.WORKERS_CI;
    delete process.env[variable];
    writeFileSync(
      path.join(directory, "wrangler.jsonc"),
      JSON.stringify({ name: "fixture-site", assets: { directory: "./out" } }),
    );
    await expect(resolveDeploymentConfig(directory, variable)).rejects.toThrow(`Set ${variable}`);
    process.env.WORKERS_CI = "1";
    const file = await resolveDeploymentConfig(directory, variable);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
      name: "fixture-site",
      assets: { directory: "./out" },
    });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    process.env[variable] = "wrangler.deploy.jsonc";
    writeFileSync(file, JSON.stringify({ name: "operator-site" }));
    expect(await resolveDeploymentConfig(directory, variable)).toBe(file);
    expect(JSON.parse(readFileSync(file, "utf8")).name).toBe("operator-site");
    process.env[variable] = "wrangler.jsonc";
    await expect(resolveDeploymentConfig(directory, variable)).rejects.toThrow(
      "private wrangler.deploy.jsonc",
    );
  } finally {
    if (previousCI === undefined) delete process.env.WORKERS_CI;
    else process.env.WORKERS_CI = previousCI;
    if (previousConfig === undefined) delete process.env[variable];
    else process.env[variable] = previousConfig;
    rmSync(directory, { recursive: true, force: true });
  }
});
