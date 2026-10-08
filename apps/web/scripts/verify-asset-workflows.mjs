// Uses real localhost authentication, uploads, commits and reopen. Only an upload response is delayed;
// its bytes are still sent to the real endpoint. Never loads app credentials or touches production fixtures.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import pg from "pg";
import sharp from "sharp";
import { chromium } from "playwright";
import { verifiedTestAccount } from "./fixtures/verified-test-account.mjs";
const base = process.env.ASSET_TEST_BASE_URL ?? "http://localhost:3115";
const connectionString = process.env.ASSET_TEST_DATABASE_URL;
if (
  !connectionString ||
  new URL(connectionString).hostname !== "127.0.0.1" ||
  new URL(connectionString).pathname !== "/tidy_assets_test" ||
  !["localhost", "127.0.0.1"].includes(new URL(base).hostname)
)
  throw new Error("Use the disposable tidy_assets_test localhost database and app.");
const client = new pg.Client({ connectionString });
await client.connect();
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 1440, height: 1100 },
  extraHTTPHeaders: { Origin: base },
});
const outsider = await browser.newContext({ extraHTTPHeaders: { Origin: base } });
const fileId = `assets-${crypto.randomUUID()}`,
  org = `org-${fileId}`,
  otherOrg = `foreign-${fileId}`;
const png = await sharp(
  Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="96" height="64"><rect width="48" height="64" fill="red"/><rect x="48" width="48" height="64" fill="blue"/></svg>',
  ),
)
  .png()
  .toBuffer();
const webp = await sharp(png).resize(120, 80).webp().toBuffer();
const password = "disposable-asset-test-123";
try {
  const ownerId = await verifiedTestAccount(client, {
    name: "Asset Owner",
    email: "asset-owner@example.test",
    password,
  });
  const otherId = await verifiedTestAccount(client, {
    name: "Asset Outsider",
    email: "asset-outsider@example.test",
    password,
  });
  for (const [ctx, email] of [
    [context, "asset-owner@example.test"],
    [outsider, "asset-outsider@example.test"],
  ]) {
    const response = await ctx.request.post(`${base}/api/auth/sign-in/email`, {
      data: { email, password },
      headers: { Origin: base },
    });
    assert.equal(response.status(), 200, await response.text());
  }
  for (const [organization, user] of [
    [org, ownerId],
    [otherOrg, otherId],
  ]) {
    await client.query(
      'insert into "organization" ("id","name","slug","createdAt","createdByUserId") values ($1,$1,$1,now(),$2)',
      [organization, user],
    );
    await client.query(
      'insert into "member" ("id","organizationId","userId","role","createdAt") values ($1,$2,$3,\'owner\',now())',
      [`member-${organization}`, organization, user],
    );
  }
  await client.query(
    'insert into "designFile" ("id","organizationId","name","createdBy") values ($1,$2,\'Asset workflow test\',$3)',
    [fileId, org, ownerId],
  );
  const upload = await context.request.post(`${base}/api/files/${fileId}/assets`, {
    multipart: { image: { name: "Source.png", mimeType: "image/png", buffer: png } },
  });
  assert.equal(upload.status(), 200, await upload.text());
  const assetId = (await upload.json()).assetId;
  const node = (id, type, parentId, box, style = {}) => ({
    id,
    name: id,
    type,
    parentId,
    box,
    style,
    visible: true,
    locked: false,
    layout: "absolute",
  });
  const content = {
    schemaVersion: 1,
    legacyConverted: false,
    pages: [{ id: "page-1", name: "Page 1" }],
    tokens: {},
    warnings: [],
    editedNodeIds: [],
    deletedSourceKeys: [],
    nodes: [
      node(
        "Frame",
        "artboard",
        null,
        { x: 20, y: 20, width: 600, height: 600 },
        { fill: "#ffffff" },
      ),
      node(
        "Later selection",
        "container",
        "Frame",
        { x: 400, y: 20, width: 100, height: 80 },
        { fill: "#cccccc" },
      ),
      {
        ...node(
          "Photo",
          "image",
          "Frame",
          { x: 40, y: 200, width: 180, height: 140 },
          { objectFit: "cover", borderWidth: 5, borderColor: "#000000" },
        ),
        assetId,
        padding: 10,
      },
      {
        ...node("Flow", "container", "Frame", { x: 260, y: 200, width: 280, height: 180 }),
        layout: "flex-row",
        padding: 8,
        responsiveBreakpoints: [
          { id: crypto.randomUUID(), frameMaxWidth: 800, layout: "flex-column" },
        ],
      },
      {
        ...node(
          "Flow photo",
          "image",
          "Flow",
          { x: 0, y: 0, width: 230, height: 100 },
          { objectFit: "cover", borderWidth: 4, rotation: 15, flipX: true, flipY: true },
        ),
        assetId,
        widthMode: "fill",
        padding: 6,
      },
      node(
        "Fill",
        "container",
        "Frame",
        { x: 40, y: 400, width: 180, height: 140 },
        {
          borderWidth: 5,
          borderColor: "#000000",
          paints: [
            {
              id: "photo-fill",
              type: "image",
              assetId,
              opacity: 1,
              visible: true,
              fit: "cover",
              positionX: 50,
              positionY: 50,
            },
          ],
        },
      ),
    ],
  };
  await client.query(
    'insert into "designDocument" ("fileId","revision","content") values ($1,1,$2)',
    [fileId, JSON.stringify(content)],
  );
  const snap = async () => {
    const r = await context.request.get(`${base}/api/files/${fileId}/changes`);
    assert.equal(r.status(), 200);
    return (await r.json()).snapshot.content;
  };
  const persisted = async (predicate) => {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const value = await snap();
      if (predicate(value)) return value;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("Timed out waiting for the real server commit.");
  };
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => {
    errors.push(error.message);
    console.error(error.message);
  });
  await page.goto(`${base}/files/${fileId}`);
  if (!(await page.getByRole("button", { name: "Select Frame", exact: true }).count()))
    await page.getByRole("button", { name: "Expand editor panels", exact: true }).click();
  const select = async (name) =>
    page
      .getByRole("button", { name: `Select ${name}`, exact: true })
      .first()
      .click();
  const fileInput = page.locator('input[type="file"][multiple]').first();
  await select("Frame");
  let release, started;
  const gate = new Promise((resolve) => (release = resolve)),
    ready = new Promise((resolve) => (started = resolve));
  await page.route(`**/api/files/${fileId}/assets`, async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    const response = await route.fetch();
    started();
    await gate;
    await route.fulfill({ response });
  });
  await fileInput.setInputFiles([
    { name: "First.png", mimeType: "image/png", buffer: png },
    { name: "Second.webp", mimeType: "image/webp", buffer: webp },
  ]);
  await ready;
  await select("Later selection");
  const width = page.getByRole("spinbutton", { name: "Width", exact: true });
  await width.fill("123");
  await width.press("Enter");
  release();
  await page.getByRole("button", { name: "Select Second.webp", exact: true }).first().waitFor();
  await page.unroute(`**/api/files/${fileId}/assets`);
  let saved = await persisted((doc) => doc.nodes.some((node) => node.name === "Second.webp"));
  assert.deepEqual(saved.nodes.find((node) => node.name === "First.png").box, {
    x: 20,
    y: 20,
    width: 96,
    height: 64,
  });
  assert.deepEqual(saved.nodes.find((node) => node.name === "Second.webp").box, {
    x: 44,
    y: 44,
    width: 120,
    height: 80,
  });
  assert.equal(saved.nodes.find((node) => node.id === "Later selection").box.width, 123);
  assert.equal(
    await page.locator('[data-node-id="Later selection"]').getAttribute("data-selected"),
    "true",
  );
  const canvas = page.getByLabel("Design canvas", { exact: true });
  await canvas.focus();
  await page.keyboard.press("ControlOrMeta+z");
  await page
    .getByRole("button", { name: "Select Second.webp", exact: true })
    .first()
    .waitFor({ state: "detached" });
  await page.keyboard.press("ControlOrMeta+Shift+z");
  await page.getByRole("button", { name: "Select Second.webp", exact: true }).first().waitFor();
  // Clipboard images and bulk drop both reach the real upload endpoint.
  await canvas.evaluate(
    (element, bytes) => {
      const data = new DataTransfer();
      data.items.add(new File([new Uint8Array(bytes)], "Pasted.png", { type: "image/png" }));
      element.dispatchEvent(
        new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: data }),
      );
    },
    [...png],
  );
  await page.getByRole("button", { name: "Select Pasted.png", exact: true }).first().waitFor();
  await page.waitForFunction(
    () => document.getElementById("canvas-tip-add-image")?.textContent === "Add image",
  );
  await canvas.evaluate(
    (element, bytes) => {
      const data = new DataTransfer();
      for (const name of ["Drop one.png", "Drop two.png"])
        data.items.add(new File([new Uint8Array(bytes)], name, { type: "image/png" }));
      const rect = element.getBoundingClientRect();
      element.dispatchEvent(
        new DragEvent("drop", {
          bubbles: true,
          cancelable: true,
          dataTransfer: data,
          clientX: rect.left + 200,
          clientY: rect.top + 100,
        }),
      );
    },
    [...png],
  );
  await page.getByRole("button", { name: "Select Drop two.png", exact: true }).first().waitFor();
  await page
    .locator("details > summary")
    .filter({ hasText: /^Assets/ })
    .click();
  const assetButtons = page.locator('button[aria-label^="Place "]');
  await assetButtons.first().waitFor();
  await assetButtons.first().click();
  await page.getByRole("button", { name: "Select Image", exact: true }).first().waitFor();
  console.log(
    "PASS: intrinsic bulk upload, delayed selection/edit preservation, one-step batch undo/redo, clipboard images, bulk drop and asset reuse",
  );
  // Crop and source replacement on the authenticated document, then reopen.
  for (const name of ["Photo", "Flow photo"]) {
    await select(name);
    const layer = page.locator(`[data-node-id="${name}"]`);
    await layer.locator("img").evaluate((image) => image.decode());
    await page.getByRole("button", { name: "Crop image", exact: true }).click();
    await layer.locator("svg[data-image-crop]").waitFor();
    await page.getByRole("button", { name: "Finish crop", exact: true }).click();
  }
  await select("Fill");
  await page.getByRole("button", { name: "Crop fill image", exact: true }).click();
  await page.locator('[data-node-id="Fill"] svg[data-image-crop]').waitFor();
  const cropped = await persisted(
    (doc) => doc.nodes.find((node) => node.id === "Fill").style.paints[0].crop,
  );
  assert.ok(cropped.nodes.find((node) => node.id === "Photo").style.imageCrop);
  assert.ok(cropped.nodes.find((node) => node.id === "Flow photo").style.imageCrop);
  assert.ok(cropped.nodes.find((node) => node.id === "Fill").style.paints[0].crop);
  await page.reload();
  await page.getByRole("button", { name: "Expand editor panels", exact: true }).click();
  await select("Photo");
  assert.deepEqual(
    (await snap()).nodes.filter((node) => ["Photo", "Flow photo", "Fill"].includes(node.id)),
    cropped.nodes.filter((node) => ["Photo", "Flow photo", "Fill"].includes(node.id)),
  );
  await page.getByRole("button", { name: "Replace image", exact: true }).click();
  await page
    .locator('input[type="file"]:not([multiple])')
    .first()
    .setInputFiles({ name: "Replacement.webp", mimeType: "image/webp", buffer: webp });
  await page.locator('[data-node-id="Photo"] svg[data-image-crop]').waitFor({ state: "detached" });
  await persisted((doc) => !doc.nodes.find((node) => node.id === "Photo").style.imageCrop);
  await canvas.focus();
  await page.keyboard.press("ControlOrMeta+z");
  await page.locator('[data-node-id="Photo"] svg[data-image-crop]').waitFor();
  console.log(
    "PASS: authenticated crop persistence/reopen, bordered/padded images, responsive flex crop, rotation/flips, per-fill crop, replacement reset and undo",
  );
  await select("Frame");
  await page.getByText("Export", { exact: true }).click();
  const downloads = {};
  for (const format of ["svg", "png", "webp"]) {
    const pending = page.waitForEvent("download");
    await page.getByRole("button", { name: format, exact: true }).click();
    downloads[format] = await readFile(await (await pending).path());
  }
  assert.equal(
    await page.evaluate(
      (svg) =>
        new DOMParser().parseFromString(svg, "image/svg+xml").querySelectorAll("parsererror")
          .length,
      downloads.svg.toString(),
    ),
    0,
  );
  assert.ok(downloads.svg.toString().includes("data:image/png"));
  for (const format of ["png", "webp"]) {
    const meta = await sharp(downloads[format]).metadata();
    assert.equal(meta.width, 600);
    assert.equal(meta.height, 600);
  }
  // Compare source-crop colors at the same interior coordinates across decoded PNG/WebP.
  const pngPixels = await sharp(downloads.png).ensureAlpha().raw().toBuffer(),
    webpPixels = await sharp(downloads.webp).ensureAlpha().raw().toBuffer();
  const svgPixels = await page.evaluate(async (svg) => {
    const image = new Image();
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 600;
    const context = canvas.getContext("2d");
    context.drawImage(image, 0, 0);
    return Array.from(context.getImageData(0, 0, 600, 600).data);
  }, downloads.svg.toString());
  for (const [x, y] of [
    [70, 240],
    [180, 240],
    [70, 440],
    [180, 440],
  ]) {
    const offset = (y * 600 + x) * 4;
    for (let channel = 0; channel < 3; channel++) {
      assert.ok(Math.abs(pngPixels[offset + channel] - webpPixels[offset + channel]) < 20);
      assert.equal(pngPixels[offset + channel], svgPixels[offset + channel]);
    }
    assert.ok(pngPixels[offset + (x < 100 ? 0 : 2)] > 240);
    assert.ok(pngPixels[offset + (x < 100 ? 2 : 0)] < 15);
  }
  console.log(
    "PASS: real authenticated SVG/PNG/WebP export decode, dimensions and crop color parity",
  );
  const foreignRead = await outsider.request.get(`${base}/api/files/${fileId}/assets`);
  assert.equal(foreignRead.status(), 404);
  const foreignUpload = await outsider.request.post(`${base}/api/files/${fileId}/assets`, {
    multipart: { image: { name: "Denied.png", mimeType: "image/png", buffer: png } },
  });
  assert.equal(foreignUpload.status(), 404);
  assert.equal((await outsider.request.get(`${base}/api/assets/${assetId}`)).status(), 404);
  // Pagination retains exact timestamp precision and never exposes another organization's assets.
  await client.query(
    'insert into "designAsset" ("id","organizationId","mimeType","sha256","body","byteSize","createdAt") select gen_random_uuid()::text,$1,\'image/png\',\'catalog-\'||g,$2,$3,\'2026-10-06 12:00:00.123456+00\' from generate_series(1,52) g',
    [org, png, png.length],
  );
  const first = await (await context.request.get(`${base}/api/files/${fileId}/assets`)).json();
  assert.equal(first.assets.length, 50);
  assert.ok(first.nextCursor);
  const next = await (
    await context.request.get(
      `${base}/api/files/${fileId}/assets?cursor=${encodeURIComponent(first.nextCursor)}`,
    )
  ).json();
  assert.equal(new Set([...first.assets, ...next.assets].map((asset) => asset.assetId)).size, 54);
  assert.equal(
    (await context.request.get(`${base}/api/files/${fileId}/assets?cursor=bad`)).status(),
    400,
  );
  assert.deepEqual(errors, []);
  console.log(
    "PASS: authenticated file/organization ownership, foreign upload/read denial and stable catalog pagination",
  );
} finally {
  await browser.close();
  await client.query('delete from "organization" where "id" = any($1::text[])', [[org, otherOrg]]);
  await client.end();
}
