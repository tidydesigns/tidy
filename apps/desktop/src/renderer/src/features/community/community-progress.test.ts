import { expect, test } from "bun:test";
import { CommunityProgress } from "./community-progress";

function storage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
}

test("counts five distinct accepted threads, preserving progress across sessions", () => {
  const saved = storage();
  let progress = new CommunityProgress(saved);
  const first = crypto.randomUUID();
  for (let i = 0; i < 10; i++) progress.record(first);
  expect(progress.eligible).toBe(false);
  for (let i = 0; i < 3; i++) progress.record(crypto.randomUUID());
  expect(progress.eligible).toBe(false);
  progress = new CommunityProgress(saved);
  progress.record(crypto.randomUUID());
  expect(progress.eligible).toBe(true);
  progress.suppress();
  progress = new CommunityProgress(saved);
  progress.record(crypto.randomUUID());
  expect(progress.eligible).toBe(false);
  expect(progress.suppressed).toBe(true);
});

test("another window's progress writes cannot undo permanent dismissal", () => {
  const saved = storage();
  const one = new CommunityProgress(saved);
  const two = new CommunityProgress(saved);
  for (let i = 0; i < 5; i++) one.record(crypto.randomUUID());
  expect(two.eligible).toBe(true);
  two.suppress();
  one.record(crypto.randomUUID());
  expect(one.suppressed).toBe(true);
  expect(new CommunityProgress(saved).eligible).toBe(false);
});

test("read-only, unavailable, malformed, or duplicate storage never causes a popup", () => {
  const ids = Array.from({ length: 5 }, () => crypto.randomUUID());
  for (const raw of [
    "{",
    JSON.stringify([ids[0], ids[0], ids[0], ids[0], ids[0]]),
    JSON.stringify(["private text"]),
  ]) {
    const progress = new CommunityProgress({ getItem: () => raw, setItem: () => {} });
    expect(progress.eligible).toBe(false);
  }
  const progress = new CommunityProgress({
    getItem: (key) => (key.endsWith("threads") ? JSON.stringify(ids) : null),
    setItem: () => {
      throw new Error("Storage unavailable");
    },
  });
  expect(progress.eligible).toBe(false);
  progress.suppress();
  expect(progress.suppressed).toBe(true);
});

test("notifies the mounted invitation when the threshold is crossed and retains only five IDs", () => {
  const saved = storage();
  const progress = new CommunityProgress(saved);
  let eligible = false;
  let changes = 0;
  const stop = progress.subscribe(() => {
    changes++;
    eligible = progress.eligible;
  });
  for (let i = 0; i < 10; i++) progress.record(crypto.randomUUID());
  expect(eligible).toBe(true);
  expect(changes).toBe(5);
  expect(JSON.parse(saved.getItem("tidy:community:threads") ?? "[]")).toHaveLength(5);
  stop();
});
