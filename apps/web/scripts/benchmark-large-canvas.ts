import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { chromium } from "playwright";

type Audit = {
  frames: number[];
  tasks: number[];
  trusted: number;
  cameraChanges: number;
  last: number;
  raf: number;
  observer: PerformanceObserver;
  cameraObserver: MutationObserver;
  wheel: (event: WheelEvent) => void;
};
declare global {
  interface Window {
    largeCanvasAudit?: Audit;
  }
}
const base = process.env.EDITOR_TEST_URL ?? "http://localhost:3117";
assert.ok(["localhost", "127.0.0.1"].includes(new URL(base).hostname));
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await page.route("**/api/**", (route) => route.fulfill({ json: null }));
  await page.route("**/api/privacy/consent", (route) =>
    route.fulfill({
      json: {
        id: "00000000-0000-4000-8000-000000000001",
        browserId: "00000000-0000-4000-8000-000000000002",
        user: null,
      },
    }),
  );
  await page.route("https://**", (route) => route.abort());
  await page.addLocatorHandler(
    page.getByRole("button", { name: "Use essential storage", exact: true }),
    (button) => button.click(),
  );
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const client = await page.context().newCDPSession(page);
  await client.send("Performance.enable");
  const results = [];
  for (const scene of [
    { name: "one-frame-9000-layers", path: "large=1&nodes=9000&frameLayers=all", step: 90 },
    { name: "nine-large-frames", path: "large=1&nodes=9000", step: 360 },
  ]) {
    if (process.env.BENCHMARK_SCENE && process.env.BENCHMARK_SCENE !== scene.name) continue;
    for (const selection of ["none", "frame", "child"]) {
      if (process.env.BENCHMARK_SELECTION && process.env.BENCHMARK_SELECTION !== selection)
        continue;
      await page.goto(`${base}/dev/performance-preview?${scene.path}`);
      await page.getByRole("button", { name: /^Zoom / }).waitFor();
      const canvas = page.getByRole("region", { name: "Design canvas", exact: true });
      if (selection !== "none") {
        await page
          .getByRole("textbox", { name: "Search layers", exact: true })
          .fill(selection === "frame" ? "Large frame 1" : "Stress layer 1");
        await page
          .locator(
            `[data-layer-row="${selection === "frame" ? "large-frame-0" : "large-layer-1"}"]`,
          )
          .getByRole("button", { name: /^Select / })
          .click();
      }
      await canvas.focus();
      await page.keyboard.press("Shift+0");
      await page.getByRole("button", { name: "Zoom 100%", exact: true }).waitFor();
      await page.waitForTimeout(500);
      const box = await canvas.boundingBox();
      assert.ok(box);
      const x = box.x + box.width / 2,
        y = box.y + box.height / 2;
      await page.mouse.move(x, y);
      await page.evaluate(() => {
        const canvas = document.querySelector<HTMLElement>('[aria-label="Design canvas"]');
        const artwork = document.querySelector<HTMLElement>("[data-node-id]")?.parentElement;
        if (!canvas || !artwork) throw Error("Missing canvas or artwork");
        const audit: Audit = {
          frames: [],
          tasks: [],
          trusted: 0,
          cameraChanges: 0,
          last: 0,
          raf: 0,
          observer: new PerformanceObserver(() => {}),
          cameraObserver: new MutationObserver(() => {}),
          wheel: () => {},
        };
        audit.observer = new PerformanceObserver((list) => {
          if (audit.trusted > 0) audit.tasks.push(...list.getEntries().map((e) => e.duration));
        });
        audit.observer.observe({ type: "longtask" });
        audit.cameraObserver = new MutationObserver(
          (records) => (audit.cameraChanges += records.length),
        );
        audit.cameraObserver.observe(artwork, { attributes: true, attributeFilter: ["style"] });
        audit.wheel = (event) => {
          if (event.isTrusted) audit.trusted++;
        };
        canvas.addEventListener("wheel", audit.wheel, { passive: true });
        const tick = (time: number) => {
          if (audit.trusted > 0) {
            if (audit.last) audit.frames.push(time - audit.last);
            audit.last = time;
          }
          audit.raf = requestAnimationFrame(tick);
        };
        audit.raf = requestAnimationFrame(tick);
        window.largeCanvasAudit = audit;
      });
      await client.send("Profiler.enable");
      await client.send("Profiler.start");
      const trace = process.env.BENCHMARK_TRACE === "1";
      if (trace)
        await client.send("Tracing.start", {
          categories: "devtools.timeline",
          transferMode: "ReturnAsStream",
        });
      const before = await client.send("Performance.getMetrics");
      for (let index = 0; index < 120; index++) {
        const phase = Math.floor(index / 30);
        await client.send("Input.dispatchMouseEvent", {
          type: "mouseMoved",
          x: x + (index % 10) * 8,
          y: y + (index % 8) * 8,
        });
        await client.send("Input.dispatchMouseEvent", {
          type: "mouseWheel",
          x: x + (index % 10) * 8,
          y: y + (index % 8) * 8,
          deltaX: phase === 0 ? scene.step : phase === 2 ? -scene.step : 0,
          deltaY: phase === 1 ? scene.step : phase === 3 ? -scene.step : 0,
        });
        await page.waitForTimeout(8);
      }
      await page.waitForTimeout(200);
      const result = await page.evaluate(() => {
        const audit = window.largeCanvasAudit;
        if (!audit) throw Error("Missing audit");
        cancelAnimationFrame(audit.raf);
        audit.observer.disconnect();
        audit.cameraObserver.disconnect();
        document
          .querySelector<HTMLElement>('[aria-label="Design canvas"]')
          ?.removeEventListener("wheel", audit.wheel);
        const times = audit.frames.sort((a, b) => a - b);
        return {
          frames: times.length,
          mean: times.reduce((a, b) => a + b, 0) / times.length,
          p95: times[Math.floor(times.length * 0.95)],
          max: Math.max(...times),
          over34: times.filter((t) => t > 34).length,
          longTasks: audit.tasks.length,
          longTaskMs: audit.tasks.reduce((a, b) => a + b, 0),
          trusted: audit.trusted,
          cameraChanges: audit.cameraChanges,
          domLayers: document.querySelectorAll("[data-node-id]").length,
          selected: [...document.querySelectorAll<HTMLElement>('[data-selected="true"]')].map(
            (e) => e.dataset.nodeId,
          ),
        };
      });
      const after = await client.send("Performance.getMetrics");
      const { profile } = await client.send("Profiler.stop");
      if (trace) {
        const complete = new Promise<{ stream?: string }>((resolve) =>
          client.once("Tracing.tracingComplete", resolve),
        );
        await client.send("Tracing.end");
        const { stream } = await complete;
        assert.ok(stream);
        let data = "";
        for (;;) {
          const chunk = await client.send("IO.read", { handle: stream });
          data += chunk.base64Encoded ? Buffer.from(chunk.data, "base64").toString() : chunk.data;
          if (chunk.eof) break;
        }
        await client.send("IO.close", { handle: stream });
        if (process.env.BENCHMARK_LABEL)
          await writeFile(
            `${process.env.BENCHMARK_LABEL}-${scene.name}-${selection}.trace.json`,
            data,
          );
      }
      const label = process.env.BENCHMARK_LABEL;
      if (label)
        await writeFile(`${label}-${scene.name}-${selection}.cpuprofile`, JSON.stringify(profile));
      const metrics = Object.fromEntries(
        after.metrics
          .filter((m) =>
            ["ScriptDuration", "LayoutDuration", "RecalcStyleDuration", "TaskDuration"].includes(
              m.name,
            ),
          )
          .map((m) => [
            m.name,
            1000 * (m.value - (before.metrics.find((old) => old.name === m.name)?.value ?? 0)),
          ]),
      );
      assert.equal(result.trusted, 120);
      assert.ok(result.cameraChanges > 0);
      assert.deepEqual(
        result.selected,
        selection === "none" ? [] : [selection === "frame" ? "large-frame-0" : "large-layer-1"],
      );
      const output = { scene: scene.name, selection, ...result, metrics };
      results.push(output);
      console.log(JSON.stringify(output));
    }
  }
  assert.deepEqual(errors, []);
  if (process.env.BENCHMARK_LABEL)
    await writeFile(`${process.env.BENCHMARK_LABEL}.json`, JSON.stringify(results, null, 2));
} finally {
  await browser.close();
}
