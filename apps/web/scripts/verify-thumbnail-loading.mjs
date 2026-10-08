import assert from "node:assert/strict";
import { chromium } from "playwright";

const base = process.env.EDITOR_TEST_URL || "http://127.0.0.1:3118";
if (!["localhost", "127.0.0.1"].includes(new URL(base).hostname))
  throw new Error("Use the local performance fixture.");
const browser = await chromium.launch({ headless: true });
const timestamp = "2026-10-03T12:00:00.000Z";
const version = `1:${timestamp}`,
  thumbnailVersion = `png-v2:${version}`;
const opaque = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6ZQAAAABJRU5ErkJggg==",
  "base64",
);
let png;
const errors = [];

async function fixture() {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    colorScheme: "dark",
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/api/auth/**", (route) => route.fulfill({ json: null }));
  for (const pattern of ["**/array/**", "**/flags/**", "**/batch", "**/i/**", "**/e/**"])
    await page.route(pattern, (route) => route.fulfill({ json: {} }));
  await page.route("**/api/files/versions", (route) =>
    route.fulfill({ json: { versions: {}, thumbnailVersions: {} } }),
  );
  return { context, page };
}
async function blobsReady(page, count) {
  await page.waitForFunction(
    (count) =>
      [...document.images].filter(
        (image) => image.src.startsWith("blob:") && image.complete && image.naturalWidth === 512,
      ).length >= count,
    count,
  );
}
async function pixelProfile(page) {
  return page
    .locator('img[src^="blob:"]')
    .first()
    .evaluate((image) => {
      const canvas = document.createElement("canvas");
      canvas.width = 512;
      canvas.height = 320;
      const context = canvas.getContext("2d");
      context.drawImage(image, 0, 0);
      const data = context.getImageData(0, 0, 512, 320).data;
      let opaqueWhite = 0,
        colored = 0;
      for (let i = 0; i < data.length; i += 4) {
        if (data[i + 3] === 255 && data[i] === 255 && data[i + 1] === 255 && data[i + 2] === 255)
          opaqueWhite++;
        if (data[i + 3] && (data[i] < 230 || data[i + 1] < 230 || data[i + 2] < 230)) colored++;
      }
      return {
        corner: [...data.slice(0, 4)],
        opaqueWhite,
        colored,
        background: getComputedStyle(image.parentElement).backgroundColor,
      };
    });
}

try {
  const { context, page } = await fixture();
  const snapshot = await (
    await page.request.get(`${base}/dev/performance-preview/snapshot`)
  ).json();
  let snapshots = 0,
    inFlight = 0,
    maxRequests = 0,
    uploads = 0;
  let release;
  const uploadGate = new Promise((resolve) => {
    release = resolve;
  });
  await page.route("**/api/files/benchmark-*/snapshot", async (route) => {
    snapshots++;
    inFlight++;
    maxRequests = Math.max(maxRequests, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 400));
    inFlight--;
    await route.fulfill({ json: snapshot });
  });
  await page.route("**/api/files/benchmark-*/thumbnail?*", async (route) => {
    assert.equal(route.request().method(), "POST");
    assert.equal(new URL(route.request().url()).searchParams.get("version"), thumbnailVersion);
    uploads++;
    await uploadGate;
    await route.fulfill({ status: 204 });
  });
  await page.addInitScript(() => {
    window.thumbnailProfile = { maxRenderers: 0 };
    new MutationObserver(() => {
      window.thumbnailProfile.maxRenderers = Math.max(
        window.thumbnailProfile.maxRenderers,
        document.querySelectorAll("[data-thumbnail-renderer]").length,
      );
    }).observe(document, { subtree: true, childList: true });
  });
  await page.goto(`${base}/dev/performance-preview?workspace=1&files=2&edit=1`);
  await blobsReady(page, 2);
  assert.equal(snapshots, 2);
  assert.equal(maxRequests, 2);
  assert.equal(uploads, 2);
  await page.waitForFunction(
    () => document.querySelectorAll("[data-thumbnail-renderer]").length === 0,
  );
  assert.equal(await page.evaluate(() => window.thumbnailProfile.maxRenderers), 1);
  const pixels = await pixelProfile(page);
  assert.equal(pixels.corner[3], 0);
  assert.ok(pixels.opaqueWhite > 100);
  assert.ok(pixels.colored > 100);
  assert.equal(pixels.background, "rgb(23, 25, 28)");
  await page.emulateMedia({ colorScheme: "light" });
  assert.equal((await pixelProfile(page)).background, "rgb(242, 242, 240)");
  assert.equal((await pixelProfile(page)).corner[3], 0);
  await page.emulateMedia({ colorScheme: "dark" });
  png = Buffer.from(
    await page
      .locator('img[src^="blob:"]')
      .first()
      .evaluate(async (image) => [...new Uint8Array(await (await fetch(image.src)).arrayBuffer())]),
  );
  console.log(
    "PASS: transparent scene with retained white design fills; two snapshots overlap; previews display while both uploads are blocked",
  );
  release();
  await page.getByRole("button", { name: "List view", exact: true }).click();
  await blobsReady(page, 2);
  assert.equal(snapshots, 2, "Remounting file cards reuses scoped previews");
  console.log("PASS: changing view reuses preview blobs without another snapshot or renderer");
  await context.close();

  for (const legacy of [false, true]) {
    const { context, page } = await fixture();
    let snapshots = 0,
      gets = 0,
      uploads = 0;
    await page.route("**/api/files/benchmark-*/snapshot", (route) => {
      snapshots++;
      return route.fulfill({ json: snapshot });
    });
    await page.route("**/api/files/benchmark-*/thumbnail?*", (route) => {
      if (route.request().method() === "POST") {
        uploads++;
        return route.fulfill({ status: 204 });
      }
      gets++;
      return route.fulfill({ contentType: "image/png", body: legacy ? opaque : png });
    });
    await page.goto(
      `${base}/dev/performance-preview?workspace=1&files=100&cached=${legacy ? "legacy" : "1"}&edit=1`,
    );
    if (legacy) {
      await blobsReady(page, 2);
      assert.ok(snapshots >= 2);
      assert.equal((await pixelProfile(page)).corner[3], 0);
      assert.ok(uploads > 0);
      console.log(
        "PASS: existing opaque cache entries regenerate without a document edit or schema change",
      );
    } else {
      await page
        .locator("img")
        .first()
        .evaluate((image) => image.decode());
      assert.equal(snapshots, 0);
      assert.equal(uploads, 0);
      assert.equal(await page.locator("[data-thumbnail-renderer]").count(), 0);
      assert.ok(gets < 20, `Only cards in the viewport margin load PNGs, got ${gets}`);
      console.log(
        `PASS: cached 100-file workspace loads ${gets} visible/nearby PNGs with no document scenes`,
      );
      await page.getByRole("link", { name: "Open File 99", exact: true }).scrollIntoViewIfNeeded();
      await page.waitForFunction(() =>
        [...document.images].every((image) => image.getBoundingClientRect().bottom >= -200),
      );
      assert.ok((await page.locator("img").count()) < 20, "Scrolling releases offscreen images");
      assert.equal(snapshots, 0);
    }
    await context.close();
  }

  {
    const { context, page } = await fixture();
    let snapshots = 0,
      uploads = 0;
    await page.route("**/api/files/benchmark-*/snapshot", (route) => {
      snapshots++;
      return route.fulfill({ json: snapshot });
    });
    await page.route("**/api/files/benchmark-*/thumbnail?*", (route) => {
      uploads++;
      return route.fulfill({ status: uploads === 1 ? 500 : 204 });
    });
    await page.goto(`${base}/dev/performance-preview?workspace=1&files=1&edit=1`);
    await blobsReady(page, 1);
    const source = await page.locator("img").getAttribute("src");
    await page.waitForResponse(
      (response) => response.url().includes("/thumbnail?") && response.status() === 204,
      { timeout: 15_000 },
    );
    assert.equal(snapshots, 1);
    assert.equal(uploads, 2);
    assert.equal(await page.locator("img").getAttribute("src"), source);
    assert.equal(await page.locator("[data-thumbnail-renderer]").count(), 0);
    console.log("PASS: failed persistence retries the same blob and keeps the displayed preview");
    await context.close();
  }

  {
    const { context, page } = await fixture();
    let snapshots = 0,
      updatedGets = 0;
    const newer = `png-v2:2:${timestamp}`;
    await page.route("**/api/files/versions", (route) =>
      route.fulfill({
        json: {
          versions: { "benchmark-0": `2:${timestamp}` },
          thumbnailVersions: { "benchmark-0": newer },
        },
      }),
    );
    await page.route("**/api/files/benchmark-*/snapshot", (route) => {
      snapshots++;
      return route.fulfill({ status: 500 });
    });
    await page.route("**/api/files/benchmark-*/thumbnail?*", (route) => {
      if (new URL(route.request().url()).searchParams.get("version") === newer) updatedGets++;
      return route.fulfill({ contentType: "image/png", body: png });
    });
    await page.goto(`${base}/dev/performance-preview?workspace=1&files=1&cached=1`);
    await blobsReady(page, 1);
    assert.equal(snapshots, 0);
    assert.equal(updatedGets, 1);
    console.log(
      "PASS: a viewer reuses another editor’s newly persisted preview after an external edit",
    );
    await context.close();
  }

  {
    const { context, page } = await fixture();
    let snapshots = 0,
      uploads = 0;
    await page.route("**/api/files/versions", (route) =>
      route.fulfill({
        json: { versions: { "benchmark-0": version }, thumbnailVersions: { "benchmark-0": null } },
      }),
    );
    await page.route("**/api/files/benchmark-*/snapshot", (route) => {
      snapshots++;
      return route.fulfill({ status: 500 });
    });
    await page.route("**/api/files/benchmark-*/thumbnail?*", (route) => {
      uploads++;
      return route.fulfill({ status: 204 });
    });
    await page.goto(`${base}/dev/performance-preview?prewarm=1`);
    await page.waitForResponse(
      (response) => response.url().includes("/thumbnail?") && response.status() === 204,
    );
    assert.equal(snapshots, 0);
    assert.equal(uploads, 1);
    console.log("PASS: an idle editor prepares a cached preview directly from its loaded document");
    await context.close();
  }
  {
    const { context, page } = await fixture();
    let requests = 0,
      uploads = 0,
      release,
      firstRequest;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const started = new Promise((resolve) => {
      firstRequest = resolve;
    });
    await page.route("**/api/files/versions", async (route) => {
      requests++;
      if (requests === 1) {
        firstRequest();
        await gate;
      }
      await route
        .fulfill({
          json: {
            versions: { "benchmark-0": version },
            thumbnailVersions: { "benchmark-0": null },
          },
        })
        .catch(() => {});
    });
    await page.route("**/api/files/benchmark-*/thumbnail?*", (route) => {
      uploads++;
      return route.fulfill({ status: 204 });
    });
    await page.goto(`${base}/dev/performance-preview?prewarm=1`);
    await started;
    const resumedAt = Date.now();
    await page.evaluate(() => window.dispatchEvent(new PointerEvent("pointerdown")));
    release();
    await page.waitForResponse(
      (response) => response.url().includes("/thumbnail?") && response.status() === 204,
    );
    assert.ok(Date.now() - resumedAt >= 1400, "Canceled preparation waits for a new idle period");
    assert.equal(requests, 2);
    assert.equal(uploads, 1);
    await page.evaluate(() => window.dispatchEvent(new PointerEvent("pointerdown")));
    await page.waitForFunction(() => !document.querySelector("[data-editor-thumbnail]"));
    console.log(
      "PASS: resuming editor interaction cancels preparation and removes the extra scene",
    );
    await context.close();
  }
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
}
