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
await Bun.write(process.env.TIDY_DEPLOY_TEST_ARGS, JSON.stringify(process.argv.slice(2)));
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
    expect(JSON.parse(readFileSync(invocation, "utf8"))).toEqual([
      "wrangler",
      "deploy",
      "--config",
      config,
      "--keep-vars",
    ]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
