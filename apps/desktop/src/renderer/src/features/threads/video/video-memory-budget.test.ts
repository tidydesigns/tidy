import { expect, test } from "bun:test";
import { VideoMemoryBudget } from "./video-memory-budget";

test("retention prefers offscreen recordings, then the least recently visited, and releases capacity", () => {
  const budget = new VideoMemoryBudget(2);
  const evicted: string[] = [];
  const retain = (name: string, visible = true) =>
    budget.retain({ size: 1, priority: () => visible, evict: () => evicted.push(name) });
  const first = retain("first");
  retain("offscreen", false);
  retain("second");
  expect(evicted).toEqual(["offscreen"]);
  first.touch();
  const third = retain("third");
  expect(evicted).toEqual(["offscreen", "second"]);
  third.release();
  third.release();
  retain("fourth");
  expect(evicted).toEqual(["offscreen", "second"]);
});
