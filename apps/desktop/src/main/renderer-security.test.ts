import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { APP_URL, rendererURL, rendererAssetPath, trustedRendererURL } from "./renderer-security";

test("packaged renderers ignore environment overrides; development requires loopback", () => {
  expect(rendererURL(true, "https://attacker.invalid/")).toBe(APP_URL);
  expect(rendererURL(false)).toBe(APP_URL);
  expect(rendererURL(false, "http://127.0.0.1:5173/")).toBe("http://127.0.0.1:5173/");
  for (const url of [
    "https://attacker.invalid/",
    "file:///tmp/index.html",
    "http://127.0.0.1.attacker.invalid/",
    "http://user@localhost:5173/",
    "http://localhost:5173/?redirect=bad",
  ])
    expect(() => rendererURL(false, url)).toThrow();
});

test("IPC authorization matches the entry document, rather than an entire origin", () => {
  expect(trustedRendererURL(APP_URL, APP_URL)).toBe(true);
  expect(trustedRendererURL(`${APP_URL}#canvas`, APP_URL)).toBe(true);
  for (const url of [
    "tidy://app/assets/import.html",
    "tidy://app/index.html?untrusted",
    "tidy://other/index.html",
    "file:///tmp/index.html",
    "https://attacker.invalid/",
    "not a URL",
  ])
    expect(trustedRendererURL(url, APP_URL)).toBe(false);
  expect(trustedRendererURL("http://127.0.0.1:5173/uploaded.html", "http://127.0.0.1:5173/")).toBe(
    false,
  );
});

test("the app protocol exposes only renderer output and rejects traversal", () => {
  const root = resolve("/renderer-output");
  expect(rendererAssetPath(root, APP_URL)).toBe(resolve(root, "index.html"));
  expect(rendererAssetPath(root, "tidy://app/assets/worker.js")).toBe(
    resolve(root, "assets/worker.js"),
  );
  for (const url of [
    "tidy://app/../../private.json",
    "tidy://app/assets/%2f..%2f..%2fprivate.json",
    "tidy://app/assets/%5c..%5cprivate.json",
    "tidy://app/assets/%00.js",
    "tidy://app/out/main/index.js",
    "tidy://other/assets/code.js",
    "tidy://user@app/assets/code.js",
    "file:///private.json",
  ])
    expect(() => rendererAssetPath(root, url)).toThrow();
});
