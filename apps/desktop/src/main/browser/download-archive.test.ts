import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { downloadBrowserArchive } from "./download-archive";

test("archive downloads replace atomically and clean interrupted or oversized transfers", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tidy-browser-archive-"));
  const path = join(directory, "browser.zip");
  const server = createServer((request, response) => {
    if (request.url === "/redirect") {
      response.writeHead(302, { Location: "/archive" });
      response.end();
    } else if (request.url === "/stalled") {
      response.writeHead(200, { "Content-Length": 100 });
      response.write("partial");
    } else if (request.url === "/oversized") {
      response.writeHead(200, { "Content-Length": 512 * 1024 * 1024 + 1 });
      response.write("partial");
    } else response.end("archive");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    await writeFile(path, "previous");
    await downloadBrowserArchive({
      url: new URL(`${origin}/redirect`),
      path,
      signal: AbortSignal.timeout(5000),
      progress() {},
    });
    assert.equal(await readFile(path, "utf8"), "archive");
    for (const route of ["stalled", "oversized"]) {
      await assert.rejects(
        downloadBrowserArchive({
          url: new URL(`${origin}/${route}`),
          path,
          signal: AbortSignal.timeout(100),
          progress() {},
        }),
      );
      assert.equal(await readFile(path, "utf8"), "archive");
      assert.deepEqual(await readdir(directory), ["browser.zip"]);
    }
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
