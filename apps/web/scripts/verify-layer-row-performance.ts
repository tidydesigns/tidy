/** Local browser regression check for selection rendering and layer controls.
 * Run with EDITOR_TEST_URL=http://localhost:3107 bun apps/web/scripts/verify-layer-row-performance.ts
 */
import assert from "node:assert/strict";
import { chromium } from "playwright";

const base = process.env.EDITOR_TEST_URL ?? "http://localhost:3107";
assert.ok(["localhost", "127.0.0.1"].includes(new URL(base).hostname));
const browser = await chromium.launch({ headless: true });
type Fiber = {
  type?: { name?: string };
  flags: number;
  actualDuration?: number;
  memoizedProps?: { row?: { node: { id: string } } };
  child?: Fiber;
  sibling?: Fiber;
};
type ProfileWindow = Window & { layerRowRenders: Record<string, number> };
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  // The fixture has no account or database dependency. Keep analytics local too.
  await page.route("**/api/auth/get-session", (route) =>
    route.fulfill({ contentType: "application/json", body: "null" }),
  );
  await page.route("http://127.0.0.1:9/**", (route) =>
    route.fulfill({ contentType: "application/json", body: "{}" }),
  );
  await page.addInitScript(() => {
    const target = window as unknown as ProfileWindow;
    target.layerRowRenders = {};
    Object.assign(window, {
      __REACT_DEVTOOLS_GLOBAL_HOOK__: {
        supportsFiber: true,
        renderers: new Map<number, unknown>(),
        inject(renderer: unknown) {
          this.renderers.set(1, renderer);
          return 1;
        },
        onCommitFiberUnmount() {},
        onCommitFiberRoot(_id: number, root: { current: Fiber }) {
          function visit(fiber?: Fiber) {
            if (!fiber) return;
            if (
              fiber.flags & 1 &&
              (fiber.actualDuration ?? 0) > 0 &&
              fiber.type?.name === "LayerRow"
            ) {
              const id = fiber.memoizedProps?.row?.node.id;
              if (id) target.layerRowRenders[id] = (target.layerRowRenders[id] ?? 0) + 1;
            }
            visit(fiber.child);
            visit(fiber.sibling);
          }
          visit(root.current);
        },
      },
    });
  });
  await page.goto(`${base}/dev/performance-preview?nodes=5000`);
  await page.getByRole("button", { name: /^Zoom / }).waitFor();
  const canvas = page.getByLabel("Design canvas", { exact: true });
  await canvas.focus();
  await page.keyboard.press("Shift+0");
  const select = (name: string) =>
    page.getByRole("button", { name: `Select ${name}`, exact: true }).click();
  await select("Layer 1");
  await page.getByRole("textbox", { name: "Layer name", exact: true }).waitFor();
  // Opening the inspector resizes the canvas and can mount overscan rows.
  // Measure selection after that separate panel transition has settled.
  await page.waitForTimeout(500);
  const settle = () =>
    page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
  await settle();
  const before = await page.evaluate(() => (window as unknown as ProfileWindow).layerRowRenders);
  assert.ok(Object.keys(before).length > 0, "React profiler observes mounted layer rows");
  await select("Layer 2");
  await settle();
  const after = await page.evaluate(() => (window as unknown as ProfileWindow).layerRowRenders);
  const changedRows = Object.keys(after)
    .filter((id) => after[id] !== before[id])
    .sort();
  assert.deepEqual(
    changedRows,
    ["layer-1", "layer-2"],
    "Only the old and new selected rows render",
  );
  assert.equal(
    await page.getByRole("textbox", { name: "Layer name", exact: true }).inputValue(),
    "Layer 2",
  );

  await page.getByRole("button", { name: "Hide Layer 2", exact: true }).click();
  await page.getByRole("button", { name: "Show Layer 2", exact: true }).waitFor();
  assert.equal(await page.locator('[data-node-id="layer-2"]').count(), 0);
  await page.getByRole("button", { name: "Show Layer 2", exact: true }).click();
  await page.locator('[data-node-id="layer-2"]').waitFor();
  await page.getByRole("button", { name: "Lock Layer 2", exact: true }).click();
  await settle();
  await page.getByRole("button", { name: "Unlock Layer 2", exact: true }).waitFor();
  assert.ok(await page.getByRole("button", { name: "Hide Layer 2", exact: true }).isDisabled());
  await page.getByRole("button", { name: "Unlock Layer 2", exact: true }).click();
  await page.getByRole("button", { name: "Collapse Frame", exact: true }).first().click();
  assert.equal(await page.getByRole("button", { name: "Select Layer 2", exact: true }).count(), 0);
  await page.getByRole("button", { name: "Expand Frame", exact: true }).first().click();
  await page.getByRole("button", { name: "Select Layer 2", exact: true }).waitFor();

  const tree = page.getByRole("tree", { name: "Layers", exact: true });
  await tree.evaluate((element) => {
    const scroller = element.closest<HTMLElement>('[role="tabpanel"]')!;
    scroller.scrollTop = scroller.scrollHeight;
  });
  const last = page.getByRole("button", { name: "Select Layer 4999", exact: true });
  await last.waitFor();
  await last.focus();
  await page.keyboard.press("Enter");
  await page.locator('[data-node-id="layer-4999"]').waitFor();
  assert.equal(
    await page.getByRole("textbox", { name: "Layer name", exact: true }).inputValue(),
    "Layer 4999",
  );
  assert.ok((await tree.getByRole("treeitem").count()) <= 100);
  assert.deepEqual(errors, []);
  console.log(
    "PASS: selection renders two rows; visibility, locking, collapse, virtual scroll and keyboard selection work.",
  );
} finally {
  await browser.close();
}
