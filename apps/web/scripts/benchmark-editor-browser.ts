import assert from "node:assert/strict";
import { chromium } from "playwright";

import {
  browserCosts,
  editorBenchmarkContext,
  editorBenchmarkUrl,
  percentile,
  writeBenchmarkReport,
  type BrowserCosts,
} from "./editor-benchmark";

type NudgeResult = BrowserCosts & {
  nodes: number;
  samples: number;
  warmups: number;
  cpuThrottle: number;
  firstSelectionMs: number;
  nudgeUpdateRafP50Ms: number;
  nudgeUpdateRafP95Ms: number;
  mounted: number;
  rows: number;
};
type PanResult = BrowserCosts & { nodes: number; scenario: string; cpuThrottle: number };

const base = editorBenchmarkUrl();
const browser = await chromium.launch({ headless: true });
const results: (NudgeResult | PanResult)[] = [];
try {
  for (const nodes of [100, 1000, 5000]) {
    const context = await editorBenchmarkContext(browser);
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const cdp = await context.newCDPSession(page);
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
    const readyStart = performance.now();
    await page.goto(`${base}/dev/performance-preview?nodes=${nodes}`);
    const canvas = page.getByLabel("Design canvas", { exact: true });
    await canvas.waitFor();
    await canvas.focus();
    await page.keyboard.press("Shift+0");
    await page.getByRole("button", { name: "Select Layer 1", exact: true }).click();
    await page.getByRole("textbox", { name: "Layer name", exact: true }).waitFor();
    await canvas.focus();
    const firstSelectionMs = Math.round(performance.now() - readyStart);
    await cdp.send("Performance.enable");
    const startMetrics = await cdp.send("Performance.getMetrics");
    const timings = await page.evaluate(async () => {
      const canvas = document.querySelector<HTMLElement>('[aria-label="Design canvas"]')!;
      const layer = document.querySelector<HTMLElement>('[data-node-id="layer-1"]')!;
      const samples: number[] = [];
      const initialX = parseFloat(layer.style.left);
      for (let index = 0; index < 70; index++) {
        const previous = layer.style.left;
        const start = performance.now();
        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => {
            observer.disconnect();
            reject(new Error("Nudge did not update the selected layer."));
          }, 10_000);
          const observer = new MutationObserver(() => {
            if (layer.style.left === previous) return;
            observer.disconnect();
            clearTimeout(timeout);
            requestAnimationFrame(() => resolve());
          });
          observer.observe(layer, { attributes: true, attributeFilter: ["style"] });
          canvas.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
        });
        if (index >= 10) samples.push(performance.now() - start);
        // Let acknowledgment/overlay work settle before the next sample.
        await new Promise((resolve) => requestAnimationFrame(resolve));
      }
      const finalX = parseFloat(layer.style.left);
      if (finalX !== initialX + 70) throw new Error(`Nudges lost: ${initialX} -> ${finalX}`);
      return { samples: samples.sort((a, b) => a - b), initialX, finalX };
    });
    const endMetrics = await cdp.send("Performance.getMetrics");
    const mounted = await page.locator("[data-node-id]").count();
    const rows = await page
      .getByRole("tree", { name: "Layers", exact: true })
      .getByRole("treeitem")
      .count();
    assert.ok(mounted <= 300);
    assert.ok(rows <= 100);
    assert.deepEqual(errors, []);
    results.push({
      nodes,
      samples: timings.samples.length,
      warmups: 10,
      cpuThrottle: 4,
      firstSelectionMs,
      nudgeUpdateRafP50Ms: percentile(timings.samples, 0.5),
      nudgeUpdateRafP95Ms: percentile(timings.samples, 0.95),
      ...browserCosts(startMetrics, endMetrics),
      mounted,
      rows,
    });
    const panStart = await cdp.send("Performance.getMetrics");
    await page.evaluate(async () => {
      const canvas = document.querySelector<HTMLElement>('[aria-label="Design canvas"]')!;
      const surface = [...canvas.querySelectorAll<HTMLElement>("div[style]")].find((element) =>
        element.style.transform.startsWith("translate("),
      )!;
      const before = surface.style.transform;
      for (let index = 0; index < 120; index++) {
        canvas.dispatchEvent(
          new WheelEvent("wheel", {
            deltaX: 2,
            deltaY: 1,
            bubbles: true,
            cancelable: true,
          }),
        );
        await new Promise((resolve) => requestAnimationFrame(resolve));
      }
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      if (surface.style.transform === before) throw new Error("Pan did not update the viewport.");
    });
    const panEnd = await cdp.send("Performance.getMetrics");
    results.push({
      nodes,
      scenario: "120 pan events",
      cpuThrottle: 4,
      ...browserCosts(panStart, panEnd),
    });
    await context.close();
  }
  const report = {
    browser: browser.version(),
    build: process.env.EDITOR_BENCH_BUILD ?? "local production fixture",
    results,
  };
  console.log(await writeBenchmarkReport(report));
} finally {
  await browser.close();
}
