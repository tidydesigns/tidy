import assert from "node:assert/strict";
import { chromium } from "playwright";

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(
    `${process.env.EDITOR_TEST_URL || "http://localhost:3111"}/dev/import-preview?edit=1`,
  );
  const canvas = page.getByLabel("Design canvas", { exact: true });
  await canvas.waitFor();
  await page.waitForFunction(() =>
    [...document.querySelectorAll("button")].some(
      (button) =>
        button.getAttribute("aria-label")?.startsWith("Shape tool") &&
        Object.keys(button).some((key) => key.startsWith("__reactProps")),
    ),
  );
  for (const name of ["Ellipse", "Line", "Arrow", "Polygon", "Star"]) {
    await page.getByRole("button", { name: /^Shape tool/ }).click();

    await page
      .getByRole("menu", { name: "Shape tool", exact: true })
      .getByRole("menuitemradio", { name, exact: true })
      .click();
    const bounds = await canvas.boundingBox();
    const x = bounds.x + bounds.width * 0.55,
      y = bounds.y + bounds.height * 0.7;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + 80, y + 60, { steps: 5 });
    await page.mouse.up();
    await page.getByRole("button", { name: "Select tool", exact: true }).click();
    const node = page.locator(`[data-node-id]:has(> img[alt="${name}"])`).first();
    await node.waitFor();
    const src = await node.locator("img").getAttribute("src");
    assert.ok(src.startsWith("data:image/svg+xml,"));
    const before = await node.getAttribute("style");
    const resize = page.getByRole("button", { name: `Resize ${name} bottom right`, exact: true });
    const handle = await resize.boundingBox();
    assert.ok(handle, `${name} has resize handles`);
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
    await page.mouse.down();
    await page.mouse.move(handle.x + 50, handle.y + 40, { steps: 5 });
    await page.mouse.up();
    assert.notEqual(await node.getAttribute("style"), before);
    await canvas.focus();
    await page.keyboard.press("ControlOrMeta+z");
    await page.waitForFunction(
      ({ id, style }) =>
        document.querySelector(`[data-node-id="${id}"]`)?.getAttribute("style") === style,
      { id: await node.getAttribute("data-node-id"), style: before },
    );
    const rotation = page.getByRole("spinbutton", { name: "Rotation", exact: true });
    await rotation.fill("37");
    await rotation.press("Enter");
    assert.ok((await node.getAttribute("style")).includes("37deg"));
    await canvas.focus();
    await page.keyboard.press("ControlOrMeta+z");
    if (name === "Polygon" || name === "Star") {
      const points = page.getByRole("spinbutton", { name: "Points", exact: true });
      await points.fill("7");
      await points.press("Enter");
      assert.notEqual(await node.locator("img").getAttribute("src"), src);
      await canvas.focus();
      await page.keyboard.press("ControlOrMeta+z");
    }
    if (name === "Star") {
      const original = await node.locator("img").getAttribute("src");
      await page.getByRole("button", { name: "Edit points", exact: true }).click();
      const anchor = await page.locator('[data-vector-control="anchor"]').first().boundingBox();
      await page.mouse.move(anchor.x + anchor.width / 2, anchor.y + anchor.height / 2);
      await page.mouse.down();
      await page.mouse.move(anchor.x + anchor.width / 2 + 15, anchor.y + anchor.height / 2 + 10, {
        steps: 5,
      });
      await page.mouse.up();
      assert.notEqual(await node.locator("img").getAttribute("src"), original);
      assert.equal(await page.getByRole("spinbutton", { name: "Points", exact: true }).count(), 0);
      await page.getByRole("button", { name: "Finish editing points", exact: true }).click();
      await canvas.focus();
      await page.keyboard.press("ControlOrMeta+z");
      await page.getByRole("spinbutton", { name: "Points", exact: true }).waitFor();
      assert.equal(await node.locator("img").getAttribute("src"), original);
    }
    await canvas.focus();
    await page.keyboard.press("ControlOrMeta+z");
    await node.waitFor({ state: "detached" });
    console.log(
      `PASS ${name}: drag creation, SVG preview, resize, rotation, contextual controls, one-step undo`,
    );
  }
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
}
