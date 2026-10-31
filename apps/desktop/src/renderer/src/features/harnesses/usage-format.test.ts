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
