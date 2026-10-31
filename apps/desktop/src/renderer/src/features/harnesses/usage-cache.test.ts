import { expect, test } from "bun:test";
import type { HarnessUsage } from "../../../../shared/contracts/harness-usage";
import type { DesktopAPI } from "../../../../shared/contracts/desktop";
import { UsageCache, usageCache } from "./usage-cache";
const value: HarnessUsage = {
  windows: [],
  state: "available",
  updatedAt: new Date().toISOString(),
  usagePage: "subscription",
};
test("usage refresh coalesces requests, keeps data available and preserves it on failure", async () => {
  let calls = 0;
  let reject!: (error: Error) => void;
  const cache = new UsageCache(() => {
    calls++;
    return new Promise((_, fail) => (reject = fail));
  }, value);
  const first = cache.refresh(true),
    second = cache.refresh(true);
  expect(first).toBe(second);
  expect(cache.read().value).toBe(value);
  expect(cache.read().loading).toBe(true);
  await Promise.resolve();
  expect(calls).toBe(1);
  reject(new Error("secret native error"));
  await first;
  expect(cache.read().value).toBe(value);
  expect(cache.read().error).toContain("last-known");
  expect(cache.read().error).not.toContain("secret");
  await cache.refresh();
  expect(calls).toBe(1);
});
test("cleared account caches ignore late completions from the previous sign-in", async () => {
  let resolve!: (value: HarnessUsage) => void;
  const cache = new UsageCache(() => new Promise((done) => (resolve = done)));
  const pending = cache.refresh();
  await Promise.resolve();
  cache.clear();
  resolve(value);
  await pending;
  expect(cache.read()).toEqual({ loading: false });
  cache.seed(value);
  expect(cache.read().value).toBeUndefined();
});
test("usage caches are isolated by API identity, project and harness", () => {
  const one = {} as DesktopAPI,
    two = {} as DesktopAPI;
  expect(usageCache(one, "project", "codex")).toBe(usageCache(one, "project", "codex"));
  expect(usageCache(one, "project", "codex")).not.toBe(usageCache(two, "project", "codex"));
  expect(usageCache(one, "project", "codex")).not.toBe(usageCache(one, "other", "codex"));
  expect(usageCache(one, "project", "codex")).not.toBe(usageCache(one, "project", "claude"));
});
