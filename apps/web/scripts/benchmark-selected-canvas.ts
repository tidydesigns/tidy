import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { chromium } from "playwright";

const base = process.env.EDITOR_TEST_URL ?? "http://localhost:3117";
assert.ok(["localhost", "127.0.0.1"].includes(new URL(base).hostname));
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
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
  await page.addLocatorHandler(
    page.getByRole("button", { name: "Use essential storage", exact: true }),
    (button) => button.click(),
  );
  await page.route("https://**", (route) => route.abort());
  const path =
    process.env.BENCHMARK_PATH ?? "/dev/performance-preview?nodes=1000&components=1&compact=1";
  const url = new URL(path, base);
  assert.equal(url.origin, new URL(base).origin);
  await page.goto(url.href);
  await page.getByRole("button", { name: /^Zoom / }).waitFor();
  await page.waitForTimeout(1500);
  const selection = process.env.BENCHMARK_SELECTION ?? "component-instance-0";
  const id = selection === "none" ? null : selection;
  if (id) {
    const layer = page.locator(`[data-node-id="${id}"]`);
    if (process.env.BENCHMARK_DEEP === "1") {
      const point = await layer.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        for (let y = rect.top + 0.25; y < rect.bottom; y += 0.5)
          for (let x = rect.left + 0.25; x < rect.right; x += 0.5)
            if (document.elementFromPoint(x, y)?.closest("[data-node-id]") === element)
              return { x, y };
        throw new Error("Layer has no exposed hit area");
      });
      await page.keyboard.down("Control");
      await page.mouse.click(point.x, point.y);
      await page.keyboard.up("Control");
    } else await layer.click();
    await page.waitForTimeout(1500);
    assert.equal(
      await page.locator(`[data-node-id="${id}"]`).getAttribute("data-selected"),
      "true",
    );
  }
  const client = await page.context().newCDPSession(page);
  await client.send("Performance.enable");
  await client.send("Profiler.enable");
  await client.send("Profiler.start");
  const before = await client.send("Performance.getMetrics");
  const result = await page.evaluate(async () => {
    const canvas = document.querySelector('[aria-label="Design canvas"]');
    const artwork = document.querySelector<HTMLElement>("[data-node-id]")?.parentElement;
    if (!canvas || !artwork) throw new Error("Expected canvas artwork");
    const startTransform = artwork.style.transform;
    const times: number[] = [];
    let previous = 0;
    for (let i = 0; i < 24; i++) {
      const now = await new Promise<number>(requestAnimationFrame);
      if (previous) times.push(now - previous);
      previous = now;
      canvas.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaX: 4 }));
    }
    await new Promise(requestAnimationFrame);
    await new Promise(requestAnimationFrame);
    times.sort((a, b) => a - b);
    return {
      mean: times.reduce((a, b) => a + b, 0) / times.length,
      p95: times[Math.floor(times.length * 0.95)],
      max: Math.max(...times),
      startTransform,
      endTransform: artwork.style.transform,
    };
  });
  const after = await client.send("Performance.getMetrics");
  const { profile } = await client.send("Profiler.stop");
  if (process.env.BENCHMARK_PROFILE)
    await writeFile(process.env.BENCHMARK_PROFILE, JSON.stringify(profile));
  const delta = Object.fromEntries(
    after.metrics.map((metric) => [
      metric.name,
      metric.value - (before.metrics.find((old) => old.name === metric.name)?.value ?? 0),
    ]),
  );
  assert.notEqual(
    result.startTransform,
    result.endTransform,
    "Benchmark must actually pan the canvas",
  );
  console.log(JSON.stringify({ selection: id ?? null, ...result, metrics: delta }, null, 2));
} finally {
  await browser.close();
}
