// Local browser fixture: no credentials, remote requests or database.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { chromium } from "playwright";
const directory = await mkdtemp(join(tmpdir(), "tidy-image-loading-"));
const built = spawnSync(
  "bun",
  ["build", "scripts/fixtures/image-loading.tsx", "--target=browser", `--outdir=${directory}`],
  { cwd: new URL("..", import.meta.url), encoding: "utf8" },
);
assert.equal(built.status, 0, built.stderr);
const requests = [];
const svg =
  '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 100 100"><rect width="100" height="100" fill="red"><animate attributeName="fill" values="red;blue;red" dur="2s" repeatCount="indefinite"/></rect></svg>';
let releasePendingImage;
let notifyPendingImage;
const pendingImageRequested = new Promise((resolve) => {
  notifyPendingImage = resolve;
});
const server = createServer(async (request, response) => {
  const url = new URL(request.url, "http://localhost");
  if (url.pathname === "/fixture.js") {
    response
      .writeHead(200, { "Content-Type": "application/javascript" })
      .end(await readFile(join(directory, "image-loading.js")));
  } else if (url.pathname.startsWith("/api/assets/")) {
    requests.push(url.pathname + url.search);
    const count = requests.filter((entry) => entry === url.pathname + url.search).length;
    const id = url.pathname.split("/").at(-1);
    if (id === "pending") {
      releasePendingImage = () =>
        response
          .writeHead(200, { "Content-Type": "image/svg+xml" })
          .end(
            svg
              .replace('height="100"', 'height="50"')
              .replace('viewBox="0 0 100 100"', 'viewBox="0 0 100 50"'),
          );
      notifyPendingImage();
      return;
    }
    const status = id === "persistent" || id === "old" || id === "gone" || count === 1 ? 503 : 200;
    response
      .writeHead(status, {
        "Content-Type": "image/svg+xml",
        "Cache-Control": "private, no-store",
        "Content-Security-Policy": "default-src 'none'; sandbox",
      })
      .end(status === 200 ? svg : "");
  } else {
    response
      .writeHead(200, {
        "Content-Type": "text/html",
        "Content-Security-Policy": "frame-ancestors 'none'; base-uri 'self'",
      })
      .end('<div id="root"></div><script src="/fixture.js"></script>');
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
const count = (id) => requests.filter((entry) => entry.startsWith(`/api/assets/${id}`)).length;
async function ready() {
  await page.waitForFunction(() => {
    const img = document.querySelector("#image-0 img");
    const crop = document.querySelector("#image-1 image");
    return (
      img?.getAttribute("src")?.startsWith("blob:") &&
      img.complete &&
      img.naturalWidth > 0 &&
      crop?.getAttribute("href") === img.src
    );
  });
}
try {
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await ready();
  assert.deepEqual(requests, ["/api/assets/recover", "/api/assets/recover"]);
  assert.equal(await page.locator("#image-1 svg").getAttribute("viewBox"), "25 25 50 50");
  assert.equal(
    await page.locator("#image-1 image").getAttribute("data-original-src"),
    "/api/assets/recover",
  );
  const firstFrame = await page.locator("#image-1").screenshot();
  await page.waitForTimeout(600);
  assert.notDeepEqual(
    await page.locator("#image-1").screenshot(),
    firstFrame,
    "Blob SVG must keep animating inside crop",
  );
  const exported = await page.evaluate(() => window.exportImages());
  assert.equal(count("recover"), 3, "Export fetches the recorded original once");
  assert.match(exported, /data:image\/svg\+xml;base64/);
  assert.match(exported, /viewBox="25 25 50 50"/);
  await page.evaluate(() => window.renderImages("/api/assets/pending"));
  await page.waitForFunction(() => {
    const img = document.querySelector("#image-0 img");
    return img?.dataset.imageLoading && img.complete && img.naturalWidth > 0;
  });
  assert.equal(
    await page.evaluate(() => window.captureCrop()),
    null,
    "Loading placeholder dimensions cannot be cropped",
  );
  await page.waitForFunction(
    () => document.querySelector("#image-0 img")?.dataset.originalSrc === "/api/assets/pending",
  );
  await pendingImageRequested;
  releasePendingImage();
  await ready();
  assert.deepEqual(
    await page.evaluate(() => window.captureCrop()),
    {
      x: 0.25,
      y: 0,
      width: 0.5,
      height: 1,
      sourceWidth: 100,
      sourceHeight: 50,
    },
    "Cropping after recovery uses the real image dimensions",
  );
  await page.evaluate(() => window.renderImages("/api/assets/persistent"));
  await page.waitForSelector("#image-0 img[data-image-failed]");
  await page.waitForSelector("#image-1 [data-image-fallback]");
  await page.waitForTimeout(600);
  assert.equal(count("persistent"), 4);
  assert.equal(
    await page.evaluate(() => window.captureCrop()),
    null,
    "Failure fallback dimensions cannot be cropped",
  );
  await page.evaluate(() => window.renderImages("/api/assets/old"));
  await page.waitForFunction(
    () =>
      document.querySelector("#image-0 img")?.getAttribute("data-original-src") ===
      "/api/assets/old",
  );
  await page.waitForTimeout(100);
  await page.evaluate(() => window.renderImages("/api/assets/new"));
  await ready();
  await page.waitForTimeout(600);
  assert.equal(count("old"), 1, "Changing sources cancels old recovery");
  await page.evaluate(() => window.renderImages("/api/assets/gone"));
  await page.waitForTimeout(100);
  await page.evaluate(() => window.clearImages());
  await page.waitForTimeout(600);
  assert.equal(count("gone"), 1, "Unmount cancels pending backoff");
  console.log(
    "PASS: ordinary/cropped recovery, placeholder crop guards, bounded fallback, source/unmount cancellation, SVG animation and original exports",
  );
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
  await rm(directory, { recursive: true, force: true });
}
