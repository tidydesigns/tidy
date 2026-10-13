import type { Browser, BrowserContext } from "playwright";

type Metrics = { metrics: { name: string; value: number }[] };
export type BrowserCosts = { taskMs: number; scriptMs: number; layoutMs: number; styleMs: number };

export function editorBenchmarkUrl(): string {
  const base = process.env.EDITOR_TEST_URL ?? "http://localhost:3117";
  const url = new URL(base);
  if (!["localhost", "127.0.0.1"].includes(url.hostname))
    throw new Error("Use the local synthetic performance fixture.");
  return base;
}

export async function editorBenchmarkContext(browser: Browser): Promise<BrowserContext> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  // Fixture runs never send analytics, auth, fonts or other requests externally.
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
  return context;
}

export function browserCosts(before: Metrics, after: Metrics): BrowserCosts {
  const duration = (name: string) => {
    const start = before.metrics.find((metric) => metric.name === name)?.value ?? 0;
    const end = after.metrics.find((metric) => metric.name === name)?.value ?? 0;
    return +((end - start) * 1000).toFixed(1);
  };
  return {
    taskMs: duration("TaskDuration"),
    scriptMs: duration("ScriptDuration"),
    layoutMs: duration("LayoutDuration"),
    styleMs: duration("RecalcStyleDuration"),
  };
}

export function percentile(values: number[], fraction: number, decimals = 1): number {
  const sorted = [...values].sort((a, b) => a - b);
  return +sorted[Math.ceil(sorted.length * fraction) - 1].toFixed(decimals);
}

export async function writeBenchmarkReport(report: object): Promise<string> {
  const json = JSON.stringify(report, null, 2) + "\n";
  if (process.env.EDITOR_BENCH_OUTPUT) await Bun.write(process.env.EDITOR_BENCH_OUTPUT, json);
  return json;
}
