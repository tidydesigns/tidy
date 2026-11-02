import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { checksum } from "./desktop-demo-snapshot.mjs";

test("demo staging verifies the pin, ignores current desktop output and replaces old assets", () => {
  const root = mkdtempSync(path.join(tmpdir(), "tidy-demo-copy-"));
  const script = path.join(root, "apps/site/scripts/copy-desktop-demo.mjs");
  const source = path.join(root, "apps/site/desktop-demo");
  const destination = path.join(root, "apps/site/public/desktop-demo");
  try {
    mkdirSync(path.dirname(script), { recursive: true });
    writeFileSync(script, readFileSync(new URL("./copy-desktop-demo.mjs", import.meta.url)));
    writeFileSync(
      path.join(path.dirname(script), "desktop-demo-snapshot.mjs"),
      readFileSync(new URL("./desktop-demo-snapshot.mjs", import.meta.url)),
    );
    mkdirSync(destination, { recursive: true });
    writeFileSync(path.join(destination, "index.html"), "previous build");
    writeFileSync(path.join(destination, "obsolete.js"), "previous chunk");
    const run = () => spawnSync(process.execPath, [script], { encoding: "utf8" });
    const missing = run();
    expect(missing.status).not.toBe(0);
    expect(missing.stderr).toContain("manifest.json");
    expect(readFileSync(path.join(destination, "index.html"), "utf8")).toBe("previous build");
    mkdirSync(source, { recursive: true });
    const pin = (files) => {
      const bytes = gzipSync(JSON.stringify(files));
      writeFileSync(path.join(source, "snapshot.json.gz"), bytes);
      writeFileSync(
        path.join(source, "manifest.json"),
        JSON.stringify({ format: 1, sha256: checksum(bytes) }),
      );
    };
    const current = path.join(root, "apps/desktop/demo-dist");
    mkdirSync(current, { recursive: true });
    writeFileSync(path.join(current, "index.html"), "unreviewed desktop build");
    const files = [{ path: "index.html", content: Buffer.from("pinned build").toString("base64") }];
    pin(files);
    writeFileSync(path.join(source, "snapshot.json.gz"), "corrupt archive");
    expect(run().status).not.toBe(0);
    expect(readFileSync(path.join(destination, "index.html"), "utf8")).toBe("previous build");
    for (const name of [
      "../escape.js",
      "/absolute.js",
      "assets/../../escape.js",
      "assets\\escape.js",
    ]) {
      pin([...files, { path: name, content: "" }]);
      expect(run().status).not.toBe(0);
      expect(readFileSync(path.join(destination, "index.html"), "utf8")).toBe("previous build");
    }
    pin([{ path: "assets/only.js", content: "" }]);
    expect(run().status).not.toBe(0);
    pin([...files, ...files]);
    expect(run().status).not.toBe(0);
    pin(files);
    expect(run().status).toBe(0);
    expect(readFileSync(path.join(destination, "index.html"), "utf8")).toBe("pinned build");
    expect(readdirSync(destination)).toEqual(["index.html"]);
    expect(readdirSync(path.dirname(destination))).toEqual(["desktop-demo"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
