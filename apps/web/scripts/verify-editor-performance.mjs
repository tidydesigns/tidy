// Development fixture only. CPU throttling approximates a slower device; timings
// are diagnostic, while render counts catch unnecessary panel work deterministically.
import assert from "node:assert/strict";
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    window.editorProfile = {
      LayerTree: 0,
      SelectionInspector: 0,
      CanvasArtwork: 0,
      commits: 0,
      duration: 0,
    };
    window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
      supportsFiber: true,
      renderers: new Map(),
      inject(renderer) {
        this.renderers.set(1, renderer);
        return 1;
      },
      onCommitFiberUnmount() {},
      onCommitFiberRoot(_id, root) {
        function visit(fiber) {
          if (!fiber) return;
          const name = fiber.type?.name;
          if (
            fiber.flags & 1 &&
            (name === "LayerTree" || name === "SelectionInspector" || name === "CanvasArtwork")
          )
            window.editorProfile[name]++;
          visit(fiber.child);
          visit(fiber.sibling);
        }
        visit(root.current);
        window.editorProfile.commits++;
        window.editorProfile.duration += root.current.actualDuration ?? 0;
      },
    };
  });
  await page.goto(
    `${process.env.EDITOR_TEST_URL || "http://localhost:3107"}/dev/import-preview?edit=1`,
  );
  await page.waitForFunction(() => window.editorProfile.LayerTree > 0);
  await page.getByRole("button", { name: "Select Email input", exact: true }).first().click();
  await page.getByRole("spinbutton", { name: "Width", exact: true }).waitFor();
  const initial = await page.evaluate(() => window.editorProfile);
  assert.ok(
    initial.LayerTree > 0 && initial.SelectionInspector > 0,
    "Profiler must observe both panels",
  );
  const client = await page.context().newCDPSession(page);
  await client.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  const canvas = page.getByLabel("Design canvas", { exact: true });
  await page.waitForTimeout(300);
  const before = await page.evaluate(() => ({ ...window.editorProfile }));
  for (let i = 0; i < 30; i++) {
    await canvas.dispatchEvent("wheel", { deltaX: 2, deltaY: 1, bubbles: true, cancelable: true });
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
  }
  const after = await page.evaluate(() => ({ ...window.editorProfile }));
  const result = Object.fromEntries(
    Object.keys(before).map((key) => [key, after[key] - before[key]]),
  );
  assert.ok(result.commits >= 30, "Each pan must update the editor");
  console.log("30 pan updates, 4x CPU throttle:", JSON.stringify(result));
  if (!process.env.EDITOR_PERF_BASELINE) {
    assert.equal(result.CanvasArtwork, 0, "Panning must not render artwork");
    assert.equal(result.LayerTree, 0, "Panning must not render the layer tree");
    assert.equal(result.SelectionInspector, 0, "Panning must not render the inspector");
  }
  await canvas.dispatchEvent("wheel", {
    deltaY: -20,
    ctrlKey: true,
    clientX: 700,
    clientY: 400,
    bubbles: true,
    cancelable: true,
  });
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
  const zoomed = await page.evaluate(() => ({ ...window.editorProfile }));
  if (!process.env.EDITOR_PERF_BASELINE) {
    assert.equal(zoomed.CanvasArtwork, after.CanvasArtwork, "Zoom must not render artwork");
    assert.equal(zoomed.LayerTree, after.LayerTree, "Zoom must not render the layer tree");
    assert.equal(
      zoomed.SelectionInspector,
      after.SelectionInspector,
      "Zoom must not render the inspector",
    );
  }
  await client.send("Emulation.setCPUThrottlingRate", { rate: 1 });
  // Callbacks must follow the newest selection despite retaining their identity.
  await page.getByRole("button", { name: "Select Password input", exact: true }).first().click();
  const radius = page.getByRole("spinbutton", { name: "Radius", exact: true });
  await radius.fill("19");
  await radius.press("Enter");
  assert.equal(
    await page
      .locator('[data-node-id="desktop-password-input"]')
      .evaluate((el) => el.style.borderTopLeftRadius),
    "19px",
  );
  assert.notEqual(
    await page
      .locator('[data-node-id="desktop-email-input"]')
      .evaluate((el) => el.style.borderTopLeftRadius),
    "19px",
  );
  assert.deepEqual(errors, []);
  console.log(
    process.env.EDITOR_PERF_BASELINE
      ? "PASS: baseline recorded; selection callback verified"
      : "PASS: panels skip pan renders; inspector callbacks follow selection",
  );
} finally {
  await browser.close();
}
