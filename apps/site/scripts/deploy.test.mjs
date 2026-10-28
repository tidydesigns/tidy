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
    const deploy = () =>
      spawnSync(process.execPath, [fileURLToPath(new URL("./deploy.mjs", import.meta.url))], {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: directory,
          TIDY_SITE_DEPLOY_CONFIG: config,
          TIDY_DEPLOY_TEST_ARGS: invocation,
        },
      });

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
    const result = deploy();
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    const invoked = JSON.parse(readFileSync(invocation, "utf8"));
    expect(invoked.args).toEqual([
      "wrangler",
      "deploy",
      "--config",
      expect.stringContaining("wrangler.deploy.jsonc"),
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
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
