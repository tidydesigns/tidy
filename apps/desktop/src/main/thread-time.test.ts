import { expect, test } from "bun:test";
import { relativeThreadTime } from "../shared/thread-time";

test("thread times use compact minute, hour and day boundaries", () => {
  const now = Date.parse("2026-10-18T12:00:00Z");
  for (const [seconds, label] of [
    [-30, "now"],
    [0, "now"],
    [59, "now"],
    [60, "1m"],
    [180, "3m"],
    [3599, "59m"],
    [3600, "1h"],
    [21600, "6h"],
    [86399, "23h"],
    [86400, "1d"],
    [172800, "2d"],
  ] as const)
    expect(relativeThreadTime(new Date(now - seconds * 1000).toISOString(), now)).toBe(label);
  expect(relativeThreadTime("invalid", now)).toBe("");
});
