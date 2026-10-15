import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test, required } from "./fixtures";

test("image cropping, keyboard edits, history and export", async ({ page, baseURL }) => {
  const base = baseURL!;
  const command = "ControlOrMeta";

  await page.goto(`${base}/dev/import-preview?edit=1&crop=1`);
  await page.getByRole("button", { name: "Select Crop test image", exact: true }).first().click();
  const logo = page.locator('[data-node-id="desktop-crop-fixture"]'),
    canvas = page.getByLabel("Design canvas", { exact: true });
  const beginCrop = async () => {
    await page.getByRole("button", { name: "Edit image", exact: true }).click();
    await page
      .getByRole("dialog", { name: "Image editor" })
      .getByRole("button", { name: "Crop", exact: true })
      .click();
  };
  const set = async (name: string, value: number) => {
    const field = page.getByRole("spinbutton", { name, exact: true });
    await field.fill(String(value));
    await field.press("Enter");
  };
  const undo = async () => {
    await canvas.focus();
    await page.keyboard.press(`${command}+z`);
  };
  await set("Width", 200);
  await set("Height", 200);
  await logo.locator("img").evaluate((image: HTMLImageElement) => image.decode());
  await beginCrop();
  const cropped = logo.locator("svg[data-image-crop]");
  await cropped.waitFor();
  assert.equal(await cropped.getAttribute("viewBox"), "200 0 400 400");
  assert.equal(
    await page.getByRole("button", { name: "Rotate Crop test image", exact: true }).count(),
    0,
  );
  const before = required(await logo.boundingBox()),
    viewBox = await cropped.getAttribute("viewBox");
  await page.mouse.move(before.x + before.width / 2, before.y + before.height * 0.15);
  await page.mouse.down();
  await page.mouse.move(before.x + before.width / 2 + 20, before.y + before.height * 0.15, {
    steps: 5,
  });
  await page.mouse.up();
  assert.notEqual(await cropped.getAttribute("viewBox"), viewBox);
  assert.equal(await logo.evaluate((element: HTMLElement) => element.style.width), "200px");
  await undo();
  assert.equal(await cropped.getAttribute("viewBox"), viewBox);
  const handle = page.getByRole("button", { name: "Crop Crop test image left", exact: true });
  await handle.waitFor();
  const hb = required(await handle.boundingBox());
  await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
  await page.mouse.down();
  await page.mouse.move(hb.x + hb.width / 2 + 20, hb.y + hb.height / 2, { steps: 5 });
  await page.mouse.up();
  assert.ok(parseFloat(await logo.evaluate((element: HTMLElement) => element.style.width)) < 200);
  const resized = required(await cropped.getAttribute("viewBox"))
    .split(" ")
    .map(Number);
  assert.ok(resized[0] > 200);
  assert.ok(resized[2] < 400);
  assert.ok(Math.abs(resized[0] + resized[2] - 600) < 0.001);
  await undo();
  assert.equal(await logo.evaluate((element: HTMLElement) => element.style.width), "200px");
  assert.equal(await cropped.getAttribute("viewBox"), viewBox);
  await page.getByRole("button", { name: "Zoom image in", exact: true }).click();
  assert.ok(Number(required(await cropped.getAttribute("viewBox")).split(" ")[2]) < 400);
  await undo();
  assert.equal(await cropped.getAttribute("viewBox"), viewBox);
  // Escape during a captured drag discards the transient preview; the prior crop stays.
  const rect = required(await logo.boundingBox());
  await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height * 0.15);
  await page.mouse.down();
  await page.mouse.move(rect.x + rect.width / 2 + 10, rect.y + rect.height * 0.15);
  await page.keyboard.press("Escape");
  await page.mouse.up();
  assert.equal(await cropped.getAttribute("viewBox"), viewBox);
  await beginCrop();
  await canvas.focus();
  await page.keyboard.press("+");
  assert.ok(Number(required(await cropped.getAttribute("viewBox")).split(" ")[2]) < 400);
  await undo();
  await page.keyboard.press("ArrowRight");
  assert.ok(Number(required(await cropped.getAttribute("viewBox")).split(" ")[0]) < 200);
  await undo();
  await page.getByRole("button", { name: "Finish crop", exact: true }).click();
  await set("Width", 100);
  await beginCrop();
  assert.equal(await cropped.getAttribute("viewBox"), "300 0 200 400");
  await undo();
  await page.getByRole("button", { name: "Finish crop", exact: true }).click();
  await undo();
  assert.equal(await logo.evaluate((element: HTMLElement) => element.style.width), "200px");
  await beginCrop();

  await page.getByRole("button", { name: "Finish crop", exact: true }).click();
  await page.getByRole("button", { name: "Select Crop test image", exact: true }).first().click();
  await page.getByText("Export", { exact: true }).click();
  const svgDownload = page.waitForEvent("download", { timeout: 10000 });
  await page.getByRole("button", { name: "svg", exact: true }).click();
  const svg = await readFile(await (await svgDownload).path(), "utf8");
  assert.ok(svg.includes("data:image/svg+xml"));
  assert.ok(!svg.includes('href="/crop-test.svg"'));
  assert.equal(
    await page.evaluate(
      (svg) =>
        new DOMParser().parseFromString(svg, "image/svg+xml").querySelectorAll("parsererror")
          .length,
      svg,
    ),
    0,
  );
  const pngDownload = page.waitForEvent("download", { timeout: 10000 });
  await page.getByRole("button", { name: "png", exact: true }).click();
  const png = await readFile(await (await pngDownload).path());
  const colors = await page.evaluate(
    async (data) => {
      const image = new Image();
      image.src = data;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const context = canvas.getContext("2d")!;
      context.drawImage(image, 0, 0);
      return [
        Array.from(context.getImageData(25, 100, 1, 1).data),
        Array.from(context.getImageData(175, 100, 1, 1).data),
      ];
    },
    `data:image/png;base64,${png.toString("base64")}`,
  );
  assert.ok(colors[0][0] > 200 && colors[0][2] < 10);
  assert.ok(colors[1][2] > 200 && colors[1][0] < 10);
  await page.getByRole("button", { name: "Select Crop test image", exact: true }).first().click();
  await page.getByRole("button", { name: "Reset crop", exact: true }).click();
  await logo.locator("img").waitFor();
  await undo();
  await cropped.waitFor();
  assert.equal(await cropped.getAttribute("viewBox"), viewBox);

  console.log(
    "PASS: non-destructive crop, pan, mask resize without stretch, zoom, keyboard edits, cancel, one-step undo/reset, embedded SVG and rendered PNG crop colors; no page errors",
  );
});
