import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

test("site deployment rejects unsafe private configs before invoking Wrangler", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "tidy-site-deploy-"));
  const config = path.join(directory, "wrangler.deploy.jsonc");
  const invocation = path.join(directory, "wrangler-arguments.json");
  try {
    // Substitute the executable so even an incorrectly accepted config cannot deploy.
    writeFileSync(
      path.join(directory, "bunx"),
      `#!${process.execPath}
const args = process.argv.slice(2);
const config = JSON.parse(await Bun.file(args[args.indexOf('--config') + 1]).text());
await Bun.write(process.env.TIDY_DEPLOY_TEST_ARGS, JSON.stringify({ args, config }));
`,
      { mode: 0o700 },
    );
    const deploy = ({ environment = "", args = [] } = {}) =>
      spawnSync(
        process.execPath,
        [fileURLToPath(new URL("./deploy.mjs", import.meta.url)), ...args],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            CLOUDFLARE_ENV: environment,
            PATH: directory,
            TIDY_SITE_DEPLOY_CONFIG: config,
            TIDY_DEPLOY_TEST_ARGS: invocation,
          },
        },
      );

    for (const flags of [
      {},
      { workers_dev: false },
      { preview_urls: false },
      { workers_dev: true, preview_urls: false },
      { workers_dev: false, preview_urls: true },
      { workers_dev: "false", preview_urls: false },
      { workers_dev: false, preview_urls: "false" },
    ]) {
      writeFileSync(config, JSON.stringify({ name: "fixture-site", ...flags }));
      const result = deploy();
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Set workers_dev and preview_urls to false");
      expect(existsSync(invocation)).toBe(false);
    }

    writeFileSync(
      config,
      JSON.stringify({ name: "fixture-site", workers_dev: false, preview_urls: false }),
    );
    for (const options of [
      { environment: "production" },
      { args: ["--env", "production"] },
      { args: ["-e", "production"] },
      { args: ["--env=production"] },
    ]) {
      const result = deploy(options);
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("intended target at the top level");
      expect(existsSync(invocation)).toBe(false);
    }

    writeFileSync(
      config,
      JSON.stringify({ name: "fixture-site", workers_dev: false, preview_urls: false }),
    );
    const result = deploy();
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    const invoked = JSON.parse(readFileSync(invocation, "utf8"));
    expect(invoked.args).toEqual([
      "wrangler",
      "deploy",
      "--config",
      expect.stringContaining("wrangler.deploy.jsonc"),
      "--env=",
      "--keep-vars",
    ]);
    expect(invoked.config.name).toBe("fixture-site");
    expect(invoked.config.secrets.required).toEqual(["GITHUB_RELEASES_TOKEN"]);
    expect(invoked.config.main).toBe(fileURLToPath(new URL("../worker/index.ts", import.meta.url)));
    expect(invoked.config.assets.binding).toBe("ASSETS");
    expect(invoked.config.assets.run_worker_first).toEqual(["/download/mac", "/download/mac/"]);
    expect(existsSync(invoked.args[3])).toBe(false);
    expect(JSON.parse(readFileSync(config, "utf8"))).toEqual({
      name: "fixture-site",
      workers_dev: false,
      preview_urls: false,
    });

    for (const required of [
      ["EXISTING_SECRET"],
      ["GITHUB_RELEASES_TOKEN", "EXISTING_SECRET", "GITHUB_RELEASES_TOKEN"],
    ]) {
      const settings = {
        name: "fixture-site",
        workers_dev: false,
        preview_urls: false,
        secrets: { required },
      };
      writeFileSync(config, JSON.stringify(settings));
      const result = deploy();
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      const invoked = JSON.parse(readFileSync(invocation, "utf8"));
      expect(invoked.config.secrets.required.toSorted()).toEqual([
        "EXISTING_SECRET",
        "GITHUB_RELEASES_TOKEN",
      ]);
      expect(JSON.parse(readFileSync(config, "utf8"))).toEqual(settings);
      expect(existsSync(invoked.args[3])).toBe(false);
    }

    // Check the actual Wrangler resolver, not just the generated JSON. A late
    // environment selector must not replace the private target we validated.
    const settings = {
      name: "fixture-site",
      compatibility_date: "2026-09-29",
      workers_dev: false,
      preview_urls: false,
      secrets: { required: ["EXISTING_SECRET"] },
      env: {
        staging: {
          name: "different-site",
          workers_dev: true,
          preview_urls: true,
          secrets: { required: ["STAGING_SECRET"] },
        },
      },
    };
    writeFileSync(config, JSON.stringify(settings));
    expect(deploy().status).toBe(0);
    const prepared = JSON.parse(readFileSync(invocation, "utf8"));
    const resolvedConfig = path.join(directory, "prepared.json");
    writeFileSync(resolvedConfig, JSON.stringify(prepared.config));
    const wrangler = new URL("../node_modules/wrangler/wrangler-dist/cli.js", import.meta.url).href;
    const resolved = spawnSync(
      process.execPath,
      [
        "--eval",
        `import { unstable_readConfig } from ${JSON.stringify(wrangler)};
const implicit = unstable_readConfig({config: process.env.TIDY_DEPLOY_TEST_CONFIG});
const config = unstable_readConfig({config: process.env.TIDY_DEPLOY_TEST_CONFIG, env: process.env.TIDY_DEPLOY_TEST_ENV});
console.log(JSON.stringify({implicit: {name: implicit.name, secrets: implicit.secrets}, name: config.name, secrets: config.secrets, assets: config.assets, workers_dev: config.workers_dev, preview_urls: config.preview_urls}));`,
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          CLOUDFLARE_ENV: "staging",
          TIDY_DEPLOY_TEST_CONFIG: resolvedConfig,
          TIDY_DEPLOY_TEST_ENV: prepared.args.find((arg) => arg.startsWith("--env=")).slice(6),
          WRANGLER_SEND_METRICS: "false",
        },
      },
    );
    expect(resolved.error).toBeUndefined();
    expect(resolved.status).toBe(0);
    const active = JSON.parse(resolved.stdout);
    expect(active.implicit).toEqual({
      name: "different-site",
      secrets: { required: ["STAGING_SECRET"] },
    });
    expect(active.name).toBe("fixture-site");
    expect(active.secrets.required).toEqual(["EXISTING_SECRET", "GITHUB_RELEASES_TOKEN"]);
    expect(active.workers_dev).toBe(false);
    expect(active.preview_urls).toBe(false);
    expect(active.assets.binding).toBe("ASSETS");
    expect(active.assets.run_worker_first).toEqual(["/download/mac", "/download/mac/"]);
    expect(JSON.parse(readFileSync(config, "utf8"))).toEqual(settings);

    // Exercise the real CLI too: the resolver above bypasses argument parsing.
    // Model the missing empty argument seen in Workers Builds when forwarding
    // through bunx, and ensure a late environment selector cannot change targets.
    const fixtureWorker = path.join(directory, "worker.js");
    writeFileSync(fixtureWorker, 'export default { fetch() { return new Response("fixture"); } };');
    writeFileSync(
      resolvedConfig,
      JSON.stringify({
        ...prepared.config,
        main: fixtureWorker,
        assets: undefined,
        env: { staging: { main: "must-not-use-staging.js" } },
      }),
    );
    const dryRun = spawnSync(
      process.execPath,
      [
        "x",
        "--no-install",
        ...prepared.args
          .filter(Boolean)
          .map((arg) => (arg === prepared.args[3] ? resolvedConfig : arg)),
        "--dry-run",
        "--outdir",
        path.join(directory, "output"),
      ],
      {
        cwd: fileURLToPath(new URL("..", import.meta.url)),
        encoding: "utf8",
        timeout: 30_000,
        env: { ...process.env, CLOUDFLARE_ENV: "staging", WRANGLER_SEND_METRICS: "false" },
      },
    );
    expect(dryRun.error).toBeUndefined();
    expect(dryRun.status, dryRun.stdout + dryRun.stderr).toBe(0);
    expect(dryRun.stdout).toContain("--dry-run: exiting now.");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
