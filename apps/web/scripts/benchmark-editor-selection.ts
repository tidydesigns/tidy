import assert from "node:assert/strict";
import { chromium } from "playwright";

type DragCapture = {
  downMs: number | null;
  upMs: number | null;
  frames: number[];
};
declare global {
  interface Window {
    editorDragCapture: DragCapture;
  }
}
const base = process.env.EDITOR_TEST_URL ?? "http://localhost:3117";
if (!["localhost", "127.0.0.1"].includes(new URL(base).hostname))
  throw new Error("Use the local synthetic performance fixture.");
const counts = (process.env.EDITOR_SELECTION_COUNTS ?? "100,1000,4999").split(",").map(Number);
if (counts.some((count) => ![100, 1000, 4999].includes(count)))
  throw new Error("Use fixture selections of 100, 1000 or 4999 layers.");
const browser = await chromium.launch({ headless: true });
const results: unknown[] = [];
const percentile = (values: number[], fraction: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return +sorted[Math.ceil(sorted.length * fraction) - 1].toFixed(1);
};
try {
  for (const count of counts) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    await context.route("**/*", (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === "/api/auth/get-session")
        return route.fulfill({ contentType: "application/json", body: "null" });
      if (
        url.pathname.startsWith("/api/") ||
        url.pathname.startsWith("/files") ||
        !["localhost", "127.0.0.1"].includes(url.hostname) ||
        url.port === "9"
      )
        return route.abort();
      return route.continue();
    });
    const page = await context.newPage();
    page.setDefaultTimeout(120_000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const cdp = await context.newCDPSession(page);
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
    await page.goto(`${base}/dev/performance-preview?selection=${count}`, {
      timeout: 120_000,
    });
    const canvas = page.getByLabel("Design canvas", { exact: true });
    await canvas.waitFor();
    await canvas.focus();
    await page.keyboard.press("Shift+1");
    await page.getByRole("button", { name: "Select Selected layer 1", exact: true }).click();
    await page.getByRole("textbox", { name: "Layer name", exact: true }).waitFor();
    await canvas.focus();
    await page.keyboard.press("Shift+1");
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
    const selectionTimes = await page.evaluate(async (count) => {
      const canvas = document.querySelector<HTMLElement>('[aria-label="Design canvas"]')!;
      const first = document.querySelector<HTMLElement>('[data-node-id="selected-0"]')!;
      const last = document.querySelector<HTMLElement>(`[data-node-id="selected-${count - 1}"]`)!;
      const frame = document.querySelector<HTMLElement>('[data-node-id="selection-frame"]')!;
      const waitFor = async (test: () => boolean, action: () => void) => {
        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => {
            observer.disconnect();
            reject(new Error("Selection did not finish."));
          }, 120_000);
          const observer = new MutationObserver(() => {
            if (!test()) return;
            observer.disconnect();
            clearTimeout(timeout);
            requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
          });
          observer.observe(canvas.parentElement!, {
            attributes: true,
            childList: true,
            subtree: true,
          });
          action();
        });
      };
      const key = (key: string, ctrlKey = false) =>
        canvas.dispatchEvent(
          new KeyboardEvent("keydown", { key, ctrlKey, bubbles: true, cancelable: true }),
        );
      const times: number[] = [];
      for (let index = 0; index < 4; index++) {
        if (index) {
          await waitFor(
            () => frame.dataset.selected === "true",
            () => key("Escape"),
          );
          await waitFor(
            () => first.dataset.selected === "true",
            () => key("Enter"),
          );
        }
        const start = performance.now();
        await waitFor(
          () =>
            last.dataset.selected === "true" &&
            !!document.querySelector(`[aria-label="Scale ${count} layers"]`),
          () => key("a", true),
        );
        if (index) times.push(performance.now() - start);
        if (canvas.querySelectorAll('[data-selected="true"]').length !== count)
          throw new Error("Incorrect bulk selection count.");
      }
      return times;
    }, count);
    assert.equal(await page.locator('[data-selected="true"]').count(), count);
    await cdp.send("Performance.enable");
    const beforeMetrics = await cdp.send("Performance.getMetrics");
    await page.evaluate(() => {
      const canvas = document.querySelector<HTMLElement>('[aria-label="Design canvas"]')!;
      const layer = document.querySelector<HTMLElement>('[data-node-id="selected-0"]')!;
      const state: DragCapture = { downMs: null, upMs: null, frames: [] };
      window.editorDragCapture = state;
      window.addEventListener(
        "pointerdown",
        () => {
          const start = performance.now();
          requestAnimationFrame(() =>
            requestAnimationFrame(() => {
              state.downMs = performance.now() - start;
            }),
          );
        },
        { capture: true, once: true },
      );
      window.addEventListener(
        "pointerup",
        () => {
          const start = performance.now();
          requestAnimationFrame(() =>
            requestAnimationFrame(() => {
              state.upMs = performance.now() - start;
            }),
          );
        },
        { capture: true, once: true },
      );
      window.addEventListener(
        "pointermove",
        (event) => {
          if (!event.buttons) return;
          const before = layer.style.left;
          const start = performance.now();
          const observer = new MutationObserver(() => {
            if (layer.style.left === before) return;
            observer.disconnect();
            requestAnimationFrame(() => {
              state.frames.push(performance.now() - start);
            });
          });
          observer.observe(layer, { attributes: true, attributeFilter: ["style"] });
        },
        { capture: true },
      );
    });
    await page.keyboard.press("Shift+1");
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
    const target = page.locator(`[data-node-id="selected-${Math.floor(count / 2) + 7}"]`);
    const firstLayer = page.locator('[data-node-id="selected-0"]');
    const box = await target.boundingBox();
    assert.ok(box);
    const startX = box.x + box.width / 2;
    const startY = box.y + box.height / 2;
    assert.ok(
      await page.evaluate(
        ({ x, y }) => !!document.elementFromPoint(x, y)?.closest('[data-node-id^="selected-"]'),
        { x: startX, y: startY },
      ),
      "Drag target must be visible artwork",
    );
    const originalX = await firstLayer.evaluate((element) => parseFloat(element.style.left));
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.waitForFunction(() => window.editorDragCapture.downMs !== null);
    // Ctrl disables snapping so each pointer move has a verifiable nonzero delta.
    await page.keyboard.down("Control");
    for (let index = 0; index < 6; index++) {
      await page.mouse.move(startX + (index + 1) * 20, startY);
      await page.waitForFunction((index) => window.editorDragCapture.frames.length > index, index);
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
    }
    await page.mouse.up();
    await page.keyboard.up("Control");
    await page.waitForFunction(() => window.editorDragCapture.upMs !== null);
    const capture = await page.evaluate(() => window.editorDragCapture);
    const afterMetrics = await cdp.send("Performance.getMetrics");
    const movement = await page.evaluate((originalX) => {
      const nodes = [...document.querySelectorAll<HTMLElement>('[data-node-id^="selected-"]')];
      const delta = parseFloat(nodes[0].style.left) - originalX;
      if (delta <= 0) throw new Error("Drag did not move selection.");
      for (let index = 0; index < nodes.length; index++) {
        const before = (index % 50) * 28 + 20;
        if (parseFloat(nodes[index].style.left) !== before + delta)
          throw new Error(`Layer ${index} did not move by the same delta.`);
      }
      return delta;
    }, originalX);
    await canvas.focus();
    await page.keyboard.press("Control+z");
    await page.waitForFunction((originalX) => {
      const first = document.querySelector<HTMLElement>('[data-node-id="selected-0"]')!;
      return parseFloat(first.style.left) === originalX;
    }, originalX);
    await page.evaluate(() => {
      const nodes = [...document.querySelectorAll<HTMLElement>('[data-node-id^="selected-"]')];
      for (let index = 0; index < nodes.length; index++)
        if (parseFloat(nodes[index].style.left) !== (index % 50) * 28 + 20)
          throw new Error(`Undo did not restore layer ${index}.`);
    });
    assert.deepEqual(errors, []);
    const metric = (name: string) =>
      +(
        ((afterMetrics.metrics.find((metric) => metric.name === name)?.value ?? 0) -
          (beforeMetrics.metrics.find((metric) => metric.name === name)?.value ?? 0)) *
        1000
      ).toFixed(1);
    results.push({
      selected: count,
      documentNodes: count + 1,
      cpuThrottle: 4,
      selectionSamples: selectionTimes.length,
      selectionP50Ms: percentile(selectionTimes, 0.5),
      selectionP95Ms: percentile(selectionTimes, 0.95),
      dragStartMs: +capture.downMs!.toFixed(1),
      dragSamples: capture.frames.length - 2,
      dragPreviewP50Ms: percentile(capture.frames.slice(2), 0.5),
      dragPreviewP95Ms: percentile(capture.frames.slice(2), 0.95),
      dropCommitFrameMs: +capture.upMs!.toFixed(1),
      dragTaskMs: metric("TaskDuration"),
      dragScriptMs: metric("ScriptDuration"),
      dragLayoutMs: metric("LayoutDuration"),
      movement,
      mounted: await page.locator("[data-node-id]").count(),
      pageErrors: errors,
      oneStepUndoRestoredAll: true,
    });
    console.log(JSON.stringify(results.at(-1)));
    await context.close();
  }
  const report = { browser: browser.version(), build: "local production dense fixture", results };
  if (process.env.EDITOR_BENCH_OUTPUT)
    await Bun.write(process.env.EDITOR_BENCH_OUTPUT, JSON.stringify(report, null, 2) + "\n");
} finally {
  await browser.close();
}
