import { test, expect, required } from "./fixtures";

for (const layer of [
  { id: "hover-card", name: "Votes card" },
  { id: "hover-rotated", name: "Rotated ribbon" },
]) {
  test(`selection geometry stays aligned during ${layer.name} drags and cancellation`, async ({
    page,
  }) => {
    await page.goto("/dev/hover-preview");
    await page.getByRole("button", { name: `Select ${layer.name}`, exact: true }).click();
    const node = page.locator(`[data-node-id="${layer.id}"]`);
    const before = required(await node.boundingBox());
    const x = before.x + (layer.id === "hover-card" ? before.width - 12 : before.width / 2);
    const y = before.y + before.height / 2;
    const overlayError = () =>
      page.getByLabel("Selection size", { exact: true }).evaluate((output, id) => {
        const handles = output.parentElement;
        const canvas = output.closest('[aria-label="Design canvas"]');
        const artwork = document.querySelector(`[data-node-id="${id}"]`);
        if (!handles || !canvas || !artwork) throw new Error("Selection geometry is unavailable.");
        const origin = canvas.getBoundingClientRect();
        const bounds = artwork.getBoundingClientRect();
        return Math.max(
          Math.abs(origin.left + parseFloat(handles.style.left) - bounds.left - bounds.width / 2),
          Math.abs(origin.top + parseFloat(handles.style.top) - bounds.top - bounds.height / 2),
        );
      }, layer.id);
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.keyboard.down("Control");
    for (const delta of [
      { x: 30, y: 15 },
      { x: -15, y: 25 },
      { x: 45, y: -10 },
    ]) {
      await page.mouse.move(x + delta.x, y + delta.y, { steps: 3 });
      await expect.poll(overlayError).toBeLessThan(0.2);
      const actual = await node.evaluate((element) => ({
        x: parseFloat(element.style.left),
        y: parseFloat(element.style.top),
      }));
      await expect
        .poll(async () =>
          Number(await page.getByRole("spinbutton", { name: "X", exact: true }).inputValue()),
        )
        .toBeCloseTo(actual.x, 1);
      await expect
        .poll(async () =>
          Number(await page.getByRole("spinbutton", { name: "Y", exact: true }).inputValue()),
        )
        .toBeCloseTo(actual.y, 1);
    }
    await page.keyboard.up("Control");
    await page.keyboard.press("Escape");
    await page.mouse.up();
    await expect
      .poll(async () => Math.abs(required(await node.boundingBox()).x - before.x))
      .toBeLessThan(0.2);
    await expect.poll(overlayError).toBeLessThan(0.2);
    await page.setViewportSize({ width: 1300, height: 900 });
    await expect.poll(overlayError).toBeLessThan(0.2);
  });
}

test("dense-layer movement avoids per-frame geometry reads for selection controls", async ({
  page,
}) => {
  await page.goto("/dev/hover-preview?nodes=5000");
  await page.getByRole("button", { name: "Select Data / Dark", exact: true }).click();
  const node = page.locator('[data-node-id="dense-25"]');
  await node.click();
  const before = required(await node.boundingBox());
  const x = before.x + before.width / 2,
    y = before.y + before.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.keyboard.down("Control");
  await page.mouse.move(x + 10, y + 10);
  await node.evaluate(async (element) => {
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
    const original = element.getBoundingClientRect;
    element.dataset.geometryReads = "0";
    element.getBoundingClientRect = function () {
      element.dataset.geometryReads = String(Number(element.dataset.geometryReads) + 1);
      return original.call(this);
    };
  });
  try {
    for (let index = 2; index <= 8; index++) await page.mouse.move(x + index * 10, y + index * 6);
    await expect
      .poll(async () =>
        Number(await page.getByRole("spinbutton", { name: "X", exact: true }).inputValue()),
      )
      .toBeGreaterThan(142);
    await expect(node).toHaveAttribute("data-geometry-reads", "0");
  } finally {
    await node.evaluate((element) => Reflect.deleteProperty(element, "getBoundingClientRect"));
  }
  await page.mouse.up();
  await page.keyboard.up("Control");
});

test("cached selection geometry refreshes after an ancestor changes rendered size", async ({
  page,
}) => {
  await page.goto("/dev/hover-preview");
  await page.getByRole("button", { name: "Select Rotated ribbon", exact: true }).click();
  const parent = page.locator('[data-node-id="hover-clip"]');
  const selection = page.getByLabel("Selection size", { exact: true });
  const error = () =>
    selection.evaluate((output) => {
      const handles = output.parentElement;
      const canvas = output.closest('[aria-label="Design canvas"]');
      const node = document.querySelector('[data-node-id="hover-rotated"]');
      if (!handles || !canvas || !node) throw new Error("Selection is unavailable.");
      const bounds = node.getBoundingClientRect(),
        origin = canvas.getBoundingClientRect();
      return Math.max(
        Math.abs(origin.left + parseFloat(handles.style.left) - bounds.left - bounds.width / 2),
        Math.abs(origin.top + parseFloat(handles.style.top) - bounds.top - bounds.height / 2),
      );
    });
  const before = await parent.evaluate((element) => {
    const width = element.style.width;
    element.style.width = "400px";
    return width;
  });
  await expect.poll(error).toBeLessThan(0.2);
  await parent.evaluate((element, width) => {
    element.style.width = width;
  }, before);
  await expect.poll(error).toBeLessThan(0.2);
});
