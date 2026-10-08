import { test, expect } from "bun:test";
import { createHash } from "node:crypto";
import { browserCaptureSourceHash } from "./browser-capture.generated";

test("the MCP browser script is regenerated when the shared capture engine changes", async () => {
  const root = new URL("../../../../packages/design/", import.meta.url);
  const hash = createHash("sha256");
  for (const name of [
    "browser-capture-entry.ts",
    "browser-capture.ts",
    "capture-gradients.ts",
    "effects.ts",
    "capture-effects.ts",
    "rasterize-element.ts",
    "raster-tiles.ts",
    "capture-source.ts",
    "document-defaults.ts",
  ]) {
    hash.update(await Bun.file(new URL(name, root)).text());
  }
  expect(browserCaptureSourceHash).toBe(hash.digest("hex"));
});
