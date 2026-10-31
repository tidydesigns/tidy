import { expect, test } from "bun:test";
import type { HarnessUsage } from "../../../../shared/contracts/harness-usage";
import { percentLabel, relevantWindow, untilTime } from "./usage-format";
test("usage labels avoid promising capacity rounded up from almost-empty allowances", () => {
  expect(percentLabel({ id: "a", name: "5-hour", usedPercent: 99.6 })).toBe("<1% left");
  expect(percentLabel({ id: "a", name: "5-hour", usedPercent: 12.2 })).toBe("87% left");
  expect(percentLabel({ id: "a", name: "5-hour", usedPercent: 100 })).toBe("0% left");
});
test("elapsed reset times don't imply restored allowance", () => {
  const value: HarnessUsage = {
    windows: [
      { id: "a", name: "5-hour", usedPercent: 100, resetsAt: 1 },
      { id: "b", name: "Weekly", usedPercent: 80, resetsAt: 300 },
    ],
    state: "limited",
    updatedAt: new Date().toISOString(),
    usagePage: "subscription",
  };
  expect(relevantWindow(value, 2000)?.id).toBe("b");
  expect(untilTime(1, 2000)).toBe("Reset time reached");
});

test("a model's displayed allowance excludes other models and the separate Go provider", () => {
  const value: HarnessUsage = {
    windows: [
      { id: "a", name: "Model budget", models: ["opencode/a"], usedPercent: 40 },
      { id: "b", name: "Model budget", models: ["opencode/b"], usedPercent: 100 },
      { id: "go", name: "Go allowance", provider: "opencode-go", usedPercent: 90 },
      { id: "pool", name: "Pooled budget", models: ["opencode/a", "opencode/b"], usedPercent: 60 },
    ],
    state: "limited",
    updatedAt: new Date().toISOString(),
    usagePage: "api",
  };
  expect(relevantWindow(value, Date.now(), "opencode/a")?.id).toBe("pool");
  expect(relevantWindow(value, Date.now(), "opencode/b")?.id).toBe("b");
  expect(relevantWindow(value, Date.now(), "opencode-go/a")?.id).toBe("go");
});
