import assert from "node:assert/strict";
import { chromium } from "playwright";
const base = process.env.EDITOR_TEST_URL || "http://localhost:3107";
const count = Number(process.env.WORKSPACE_PERF_FILES || 100);
if (!["localhost", "127.0.0.1"].includes(new URL(base).hostname))
  throw new Error("Use the local performance fixture.");
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  let snapshots = 0;
  const fixture = await (await page.request.get(`${base}/dev/performance-preview/snapshot`)).json();
  await page.route("**/api/files/versions", (route) => route.fulfill({ json: { versions: {} } }));
  await page.route("**/api/files/benchmark-*/snapshot", async (route) => {
    snapshots++;
    await route.fulfill({ json: fixture });
  });
  await page.addInitScript(() => {
    window.thumbnailProfile = { maxRenderers: 0, maxNodes: 0 };
    new MutationObserver(() => {
      window.thumbnailProfile.maxRenderers = Math.max(
        window.thumbnailProfile.maxRenderers,
        document.querySelectorAll("[data-thumbnail-renderer]").length,
      );
      window.thumbnailProfile.maxNodes = Math.max(
        window.thumbnailProfile.maxNodes,
        document.querySelectorAll("[data-thumbnail-node]").length,
      );
    }).observe(document, { childList: true, subtree: true });
  });
  const response = await page.goto(`${base}/dev/performance-preview?workspace=1&files=${count}`);
  const html = await response.text();
  assert.ok(
    !html.includes('"box":') && !html.includes('"nodes":'),
    "Workspace payload must contain metadata, not editable documents",
  );
  await page.waitForFunction(() =>
    [...document.querySelectorAll('img[src^="blob:"]')].some(
      (image) => image.complete && image.naturalWidth === 512,
    ),
  );
  const image = page.locator('img[src^="blob:"]').first();
  const colored = await image.evaluate((image) => {
    const canvas = document.createElement("canvas");
    canvas.width = 512;
    canvas.height = 320;
    const context = canvas.getContext("2d");
    context.drawImage(image, 0, 0);
    const data = context.getImageData(0, 0, 512, 320).data;
    let pixels = 0;
    for (let i = 0; i < data.length; i += 4)
      if (data[i + 3] > 0 && (data[i] < 230 || data[i + 1] < 230 || data[i + 2] < 230)) pixels++;
    return pixels;
  });
  assert.ok(colored > 100, "Generated PNG must contain scene content");
  const profile = await page.evaluate(() => window.thumbnailProfile);
  assert.equal(profile.maxRenderers, 1, "Only one cold thumbnail scene may mount at once");
  assert.ok(profile.maxNodes <= 100, "Offscreen files cannot multiply mounted document nodes");
  assert.ok(snapshots < count, "Offscreen snapshots must not be fetched on initial load");
  assert.deepEqual(errors, []);
  console.log(
    `PASS: compact ${count}-file workspace, bounded cold rendering, nonempty 512px PNG:`,
    JSON.stringify({
      ...profile,
      snapshots,
      coloredPixels: colored,
      htmlBytes: Buffer.byteLength(html),
    }),
  );
  const png = Buffer.from(
    await image.evaluate(async (image) => [
      ...new Uint8Array(await (await fetch(image.src)).arrayBuffer()),
    ]),
  );
  await page.unrouteAll({ behavior: "ignoreErrors" });
  await page.close();
  const warm = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  let warmSnapshots = 0;
  warm.on("pageerror", (error) => errors.push(error.message));
  await warm.route("**/api/files/versions", (route) => route.fulfill({ json: { versions: {} } }));
  await warm.route("**/api/files/benchmark-*/snapshot", (route) => {
    warmSnapshots++;
    return route.fulfill({ status: 500 });
  });
  await warm.route("**/api/files/benchmark-*/thumbnail?*", (route) =>
    route.fulfill({ body: png, contentType: "image/png" }),
  );
  await warm.goto(`${base}/dev/performance-preview?workspace=1&files=${count}&cached=1`);
  await warm.waitForFunction(() =>
    [...document.querySelectorAll("img")].some(
      (image) => image.complete && image.naturalWidth === 512,
    ),
  );
  assert.equal(warmSnapshots, 0, "Cached workspaces do not fetch editable snapshots");
  assert.equal(await warm.locator("[data-thumbnail-renderer]").count(), 0);
  assert.deepEqual(errors, []);
  console.log(
    `PASS: warm ${count}-file workspace mounts no editable thumbnail scenes and fetches no snapshots`,
  );
} finally {
  await browser.close();
}
