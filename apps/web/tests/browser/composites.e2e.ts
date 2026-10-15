import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import sharp from "sharp";
import { test } from "./fixtures";

test("boolean operands, masks, history and exported pixels", async ({ page, baseURL }) => {
  const base = baseURL!;

  const temporary = await mkdtemp(join(tmpdir(), "tidy-composites-"));
  const select = (name: string) =>
    page.getByRole("button", { name: `Select ${name}`, exact: true }).click();
  const svg = (id: string) =>
    page
      .locator(`[data-node-id="${id}"] > img[data-vector-path]`)
      .evaluate((e: HTMLImageElement) => decodeURIComponent(e.src.split(",")[1]));
  const mask = () =>
    page.locator('[data-node-id="mask-group"]').evaluate((e: HTMLElement) => e.style.maskImage);
  const undo = () => page.keyboard.press("Meta+z");

  try {
    await page.goto(`${base}/dev/import-preview?edit=1&composites=1`);
    await page.waitForSelector('[data-node-id="boolean-group"] > img[data-vector-path]');
    const original = await svg("boolean-group"),
      source = await svg("first");
    await select("Union");
    for (const operation of ["Subtract", "Intersect", "Exclude", "Union"] as const) {
      await page.getByRole("button", { name: /^Operation / }).click();
      await page.getByRole("menuitemradio", { name: operation, exact: true }).click();
      const result = await svg("boolean-group");
      const image = await sharp(Buffer.from(result))
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      const alpha = (x: number) => image.data[(70 * image.info.width + x) * 4 + 3];
      const expected = {
        Union: [255, 255, 255],
        Subtract: [255, 0, 0],
        Intersect: [0, 255, 0],
        Exclude: [255, 0, 255],
      }[operation];
      assert.deepEqual([alpha(35), alpha(105), alpha(175)], expected);
      assert.equal(await svg("first"), source);
    }
    await select("First path");
    await page.getByLabel("X", { exact: true }).fill("-20");
    await page.getByLabel("X", { exact: true }).press("Enter");
    assert.notEqual(await svg("boolean-group"), original);
    await undo();
    assert.equal(await svg("boolean-group"), original);
    await select("Union");
    await page.getByRole("button", { name: "Release boolean", exact: true }).click();
    assert.equal(
      await page.locator('[data-node-id="boolean-group"] > img[data-vector-path]').count(),
      0,
    );
    await undo();
    assert.equal(await svg("boolean-group"), original);
    await select("Third path");
    await page
      .getByRole("button", { name: "Select Fourth path", exact: true })
      .click({ modifiers: ["Shift"] });
    await page.getByRole("button", { name: "Union", exact: true }).click();
    assert.equal(
      await page
        .locator('[data-node-id="third"]')
        .evaluate((e: HTMLElement) => e.parentElement!.dataset.nodeId),
      await page
        .locator('[data-node-id="fourth"]')
        .evaluate((e: HTMLElement) => e.parentElement!.dataset.nodeId),
    );
    await undo();
    assert.equal(
      await page
        .locator('[data-node-id="third"]')
        .evaluate((e: HTMLElement) => e.parentElement!.dataset.nodeId),
      "frame",
    );
    await select("Mask group");
    const alphaMask = await mask();
    await page.getByRole("button", { name: /^Mask mode / }).click();
    await page.getByRole("menuitemradio", { name: "Luminance", exact: true }).click();
    assert.ok(decodeURIComponent(await mask()).includes('mask-type="luminance"'));
    await page.getByRole("button", { name: "Disable mask", exact: true }).click();
    assert.equal(await mask(), "");
    await page.getByRole("button", { name: "Enable mask", exact: true }).click();
    await page.getByRole("button", { name: /^Mask mode / }).click();
    await page.getByRole("menuitemradio", { name: "Alpha", exact: true }).click();
    assert.equal(await mask(), alphaMask);
    await page.getByRole("button", { name: "Release mask", exact: true }).click();
    assert.equal(await mask(), "");
    await undo();
    assert.equal(await mask(), alphaMask);
    await select("Composite frame");
    for (const format of ["svg", "png", "webp"]) {
      const downloadPromise = page.waitForEvent("download");
      await page.getByRole("button", { name: format, exact: true }).click();
      const download = await downloadPromise,
        file = join(temporary, `frame.${format}`);
      await download.saveAs(file);
      const bytes = await readFile(file);
      if (format === "svg") {
        assert.ok(bytes.toString().includes("mask-image"));
        assert.ok(bytes.toString().includes("foreignObject"));
      } else {
        const { data, info } = await sharp(bytes)
          .ensureAlpha()
          .raw()
          .toBuffer({ resolveWithObject: true });
        assert.equal(info.width, 740);
        assert.equal(info.height, 420);
        const pixel = (x: number, y: number) => [
          ...data.subarray((y * info.width + x) * 4, (y * info.width + x) * 4 + 3),
        ];
        const orange = pixel(105, 110),
          masked = pixel(450, 80),
          outside = pixel(600, 110);
        assert.ok(orange[0] > 230 && orange[1] < 150 && orange[2] < 40);
        assert.ok(
          masked[0] > 230 && masked[1] < 150 && masked[2] < 40,
          `${format}: ${JSON.stringify({ orange, masked, outside })}`,
        );
        assert.ok(outside.every((channel) => channel > 245));
      }
    }

    console.log(
      "PASS: boolean areas, editable operands, grouping/undo, mask modes/release, SVG/PNG/WebP exports",
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
