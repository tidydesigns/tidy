import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { terminalWasmAsset } from "../../../../../scripts/terminal-wasm-asset";

test("the production transform replaces the duplicate WASM with identical external bytes", async () => {
  const path = new URL(import.meta.resolve("ghostty-web"));
  const source = await readFile(path, "utf8");
  const embedded = /"data:application\/wasm;base64,([A-Za-z0-9+/=]+)"/.exec(source)![1];
  const external = await readFile(new URL(import.meta.resolve("ghostty-web/ghostty-vt.wasm")));
  expect(Buffer.from(embedded, "base64")).toEqual(external);
  const transformed = terminalWasmAsset(source, path.pathname)!;
  expect(transformed.code).not.toContain("data:application/wasm;base64,");
  expect(transformed.code).toContain('from "ghostty-web/ghostty-vt.wasm?url"');
  expect(source.length - transformed.code.length).toBeGreaterThan(500_000);
  expect(terminalWasmAsset(source, "/unrelated.js")).toBeUndefined();
  expect(() => terminalWasmAsset("changed package layout", path.pathname)).toThrow("Review");
});
