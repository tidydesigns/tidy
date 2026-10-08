import { artifactPath } from "./artifact-path.mjs";
import { chooseSelectMenu } from "./select-menu-controls.mjs";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const browser = await chromium.launch({ headless: true });
const base = process.env.EDITOR_TEST_URL || "http://127.0.0.1:3107",
  command = process.platform === "darwin" ? "Meta" : "Control";
try {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1100 },
    ignoreHTTPSErrors: true,
  });
  const page = await context.newPage(),
    errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${base}/dev/import-preview?edit=1`);
  await page.getByRole("button", { name: "Select Desktop 1440 · /login", exact: true }).click();
  const frame = page.locator('[data-node-id="desktop-screen"]'),
    canvas = page.getByLabel("Design canvas", { exact: true });
  const set = async (name, value) => {
    const field = page.getByRole("spinbutton", { name, exact: true });
    await field.fill(String(value));
    await field.press("Enter");
  };
  const color = async (name, value) => {
    const field = page.getByRole("textbox", { name, exact: true });
    await field.fill(value);
    await field.press("Enter");
  };
  const undo = async () => {
    await canvas.focus();
    await page.keyboard.press(`${command}+z`);
  };
  const background = () =>
    frame.evaluate(
      (element) =>
        element.querySelector(":scope > [data-fill-stack] > [data-fill-id]")?.style.background ||
        element.style.background,
    );
  const center = async (control) => {
    const box = await control.boundingBox();
    assert.ok(box);
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  };
  await set("Width", 600);
  await set("Height", 400);
  await chooseSelectMenu(page, "Fill type", "Linear gradient");
  await set("Gradient angle", 90);
  await color("Stop 1 color", "#ff0000");
  await color("Stop 2 color", "#0000ff");
  await page.getByRole("button", { name: "Edit gradient", exact: true }).click();
  const initial = await background(),
    geometry = await frame.evaluate((element) => [
      element.style.left,
      element.style.top,
      element.style.width,
      element.style.height,
    ]);
  const end = page.getByRole("button", { name: "Gradient end", exact: true }),
    endpoint = await center(end);
  await page.mouse.move(endpoint.x, endpoint.y);
  await page.mouse.down();
  await page.mouse.move(endpoint.x - 60, endpoint.y, { steps: 8 });
  const preview = await background();
  assert.notEqual(preview, initial, "The endpoint must preview before release.");
  await page.mouse.up();
  assert.equal(await background(), preview);
  assert.deepEqual(
    await frame.evaluate((element) => [
      element.style.left,
      element.style.top,
      element.style.width,
      element.style.height,
    ]),
    geometry,
  );
  await undo();
  assert.equal(await background(), initial, "One undo restores the whole endpoint gesture.");
  // Keyboard endpoint positions create a short central gradient with flat color beyond its ends.
  const start = page.getByRole("button", { name: "Gradient start", exact: true });
  await start.focus();
  for (let i = 0; i < 15; i++) await page.keyboard.press("Shift+ArrowRight");
  await end.focus();
  for (let i = 0; i < 15; i++) await page.keyboard.press("Shift+ArrowLeft");
  assert.ok((await background()).includes("25%") && (await background()).includes("75%"));
  await set("Gradient angle", 180);
  assert.equal(
    Number(
      await page.getByRole("spinbutton", { name: "Gradient angle", exact: true }).inputValue(),
    ),
    180,
  );
  assert.ok(
    (await background()).includes("12.5%") && (await background()).includes("87.5%"),
    "The rotated endpoints preserve their physical length.",
  );
  await set("Gradient angle", 90);
  await page.getByRole("button", { name: "Add gradient stop", exact: true }).click();
  await color("Stop 3 color", "#00ff00");
  const stop = page.getByRole("slider", { name: "Gradient stop 3", exact: true }),
    stopPoint = await center(stop);
  await page.mouse.move(stopPoint.x, stopPoint.y);
  await page.mouse.down();
  await page.mouse.move(stopPoint.x + 25, stopPoint.y, { steps: 5 });
  assert.ok(
    Number(
      await page.getByRole("spinbutton", { name: "Stop 3 position %", exact: true }).inputValue(),
    ) > 50,
  );
  await page.mouse.up();
  await undo();
  assert.equal(
    Number(
      await page.getByRole("spinbutton", { name: "Stop 3 position %", exact: true }).inputValue(),
    ),
    50,
  );
  await stop.focus();
  await page.keyboard.press("Shift+ArrowRight");
  assert.equal(await stop.getAttribute("aria-valuenow"), "60");
  await undo();
  assert.equal(await stop.getAttribute("aria-valuenow"), "50");
  const beforeCancel = await background(),
    cancelPoint = await center(end);
  await page.mouse.move(cancelPoint.x, cancelPoint.y);
  await page.mouse.down();
  await page.mouse.move(cancelPoint.x - 35, cancelPoint.y);
  assert.notEqual(await background(), beforeCancel);
  await page.keyboard.press("Escape");
  await page.mouse.up();
  assert.equal(await background(), beforeCancel);
  assert.equal(await page.locator("[data-gradient-controls]").count(), 0);
  assert.equal(
    await page.getByRole("spinbutton", { name: "Width", exact: true }).count(),
    1,
    "Cancel retains selection.",
  );
  // Verify rendered endpoint length/offset in a downloaded PNG, and serialized SVG.
  await page.getByRole("button", { name: "Remove stop 3", exact: true }).click();
  await page.getByText("Export", { exact: true }).click();
  const downloaded = page.waitForEvent("download");
  await page.getByRole("button", { name: "png", exact: true }).click();
  const png = await readFile(await (await downloaded).path());
  const pixels = await page.evaluate(
    async (data) => {
      const image = new Image();
      image.src = data;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(image, 0, 0);
      return [50, 300, 550].map((x) => [...ctx.getImageData(x, 20, 1, 1).data]);
    },
    `data:image/png;base64,${png.toString("base64")}`,
  );
  assert.ok(pixels[0][0] > 250 && pixels[0][2] < 3);
  assert.ok(pixels[2][2] > 250 && pixels[2][0] < 3);
  assert.ok(Math.abs(pixels[1][0] - pixels[1][2]) < 3);
  const svgDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "svg", exact: true }).click();
  const svg = await readFile(await (await svgDownload).path(), "utf8");
  assert.ok(svg.includes("25%") && svg.includes("75%"));
  await chooseSelectMenu(page, "Fill type", "Radial gradient");
  await page.getByRole("button", { name: "Edit gradient", exact: true }).click();
  const radialCenter = page.getByRole("button", { name: "Gradient center", exact: true }),
    c = await center(radialCenter);
  await page.mouse.move(c.x, c.y);
  await page.mouse.down();
  await page.mouse.move(c.x + 20, c.y + 10, { steps: 5 });
  await page.mouse.up();
  assert.ok(
    Number(await page.getByRole("spinbutton", { name: "Gradient X %", exact: true }).inputValue()) >
      50,
  );
  await undo();
  assert.equal(
    Number(await page.getByRole("spinbutton", { name: "Gradient X %", exact: true }).inputValue()),
    50,
  );
  const radius = page.getByRole("button", { name: "Gradient radius X", exact: true }),
    r = await center(radius);
  await page.mouse.move(r.x, r.y);
  await page.mouse.down();
  await page.keyboard.down("Shift");
  await page.mouse.move(r.x - 25, r.y, { steps: 5 });
  await page.mouse.up();
  await page.keyboard.up("Shift");
  assert.ok(
    Number(
      await page.getByRole("spinbutton", { name: "Gradient radius X %", exact: true }).inputValue(),
    ) < 50,
  );
  assert.ok(
    Math.abs(
      Number(
        await page
          .getByRole("spinbutton", { name: "Gradient radius X %", exact: true })
          .inputValue(),
      ) -
        Number(
          await page
            .getByRole("spinbutton", { name: "Gradient radius Y %", exact: true })
            .inputValue(),
        ),
    ) < 0.00001,
  );
  await undo();
  assert.equal(
    Number(
      await page.getByRole("spinbutton", { name: "Gradient radius X %", exact: true }).inputValue(),
    ),
    50,
  );
  // The controls follow the padding box and the full transformed layer.
  await page.getByRole("button", { name: "Finish gradient", exact: true }).click();
  await set("Border width", 12);
  await set("Rotation", 30);
  await frame.click({ button: "right", position: { x: 100, y: 100 } });
  await page.getByRole("menuitem", { name: "Flip horizontally", exact: true }).click();
  await page.getByRole("button", { name: "Edit gradient", exact: true }).click();
  const transformedCenter = page.getByRole("button", { name: "Gradient center", exact: true }),
    transformed = await center(transformedCenter);
  const matrix = await frame.evaluate((element) => {
    let matrix = new DOMMatrix();
    for (
      let current = element;
      current && current.getAttribute("aria-label") !== "Design canvas";
      current = current.parentElement
    ) {
      const transform = getComputedStyle(current).transform;
      if (transform !== "none") matrix = new DOMMatrix(transform).multiply(matrix);
    }
    return { a: matrix.a, b: matrix.b };
  });
  await page.mouse.move(transformed.x, transformed.y);
  await page.mouse.down();
  await page.mouse.move(transformed.x + matrix.a * 20, transformed.y + matrix.b * 20, { steps: 5 });
  await page.mouse.up();
  const transformedX = Number(
      await page.getByRole("spinbutton", { name: "Gradient X %", exact: true }).inputValue(),
    ),
    transformedY = Number(
      await page.getByRole("spinbutton", { name: "Gradient Y %", exact: true }).inputValue(),
    );
  assert.ok(Math.abs(transformedX - (50 + (20 / 576) * 100)) < 0.02);
  assert.ok(Math.abs(transformedY - 50) < 0.02);
  await undo();
  assert.equal(
    Number(await page.getByRole("spinbutton", { name: "Gradient X %", exact: true }).inputValue()),
    50,
  );
  await page.screenshot({ path: artifactPath("bella-editor-gradient-handles.png") });
  await page.getByRole("button", { name: "Finish gradient", exact: true }).click();
  assert.equal(await page.locator("[data-gradient-controls]").count(), 0);
  await page.getByRole("button", { name: "Edit gradient", exact: true }).click();
  const interrupted = await center(
    page.getByRole("button", { name: "Gradient center", exact: true }),
  );
  await page.mouse.move(interrupted.x, interrupted.y);
  await page.mouse.down();
  await page.mouse.move(interrupted.x + 20, interrupted.y + 10);
  await page.keyboard.press(`${command}+z`);
  await page.mouse.up();
  assert.equal(
    await page.locator("[data-gradient-controls]").count(),
    0,
    "Undo interrupts a captured gesture instead of preserving its preview.",
  );
  assert.equal(
    Number(await page.getByRole("spinbutton", { name: "Gradient X %", exact: true }).inputValue()),
    50,
  );
  assert.deepEqual(errors, []);
  console.log(
    "PASS: direct linear/radial gestures, immediate preview, keyboard stops, cancellation, one-step undo, angle editing, preserved layer geometry, positioned SVG/PNG pixels, radial proportion lock, and rotated/flipped padding-box gestures; no page errors",
  );
} finally {
  await browser.close();
}
