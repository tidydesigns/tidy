import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

test("demo staging preserves the old output on missing source and fully replaces a successful build", () => {
  const root = mkdtempSync(path.join(tmpdir(), "tidy-demo-copy-"));
  const script = path.join(root, "apps/site/scripts/copy-desktop-demo.mjs");
  const source = path.join(root, "apps/desktop/demo-dist");
  const destination = path.join(root, "apps/site/public/desktop-demo");
  try {
    mkdirSync(path.dirname(script), { recursive: true });
    writeFileSync(script, readFileSync(new URL("./copy-desktop-demo.mjs", import.meta.url)));
    mkdirSync(destination, { recursive: true });
    writeFileSync(path.join(destination, "index.html"), "previous build");
    writeFileSync(path.join(destination, "obsolete.js"), "previous chunk");
    const run = () => spawnSync(process.execPath, [script], { encoding: "utf8" });
    const missing = run();
    expect(missing.status).not.toBe(0);
    expect(missing.stderr).toContain("Desktop demo output is missing or unreadable");
    expect(readFileSync(path.join(destination, "index.html"), "utf8")).toBe("previous build");
    mkdirSync(source, { recursive: true });
    writeFileSync(path.join(source, "index.html"), "next build");
    expect(run().status).toBe(0);
    expect(readFileSync(path.join(destination, "index.html"), "utf8")).toBe("next build");
    expect(readdirSync(destination)).toEqual(["index.html"]);
    expect(readdirSync(path.dirname(destination))).toEqual(["desktop-demo"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
