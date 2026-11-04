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
  progress.record(first);
  progress.record(first);
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

test("read-only, unavailable, malformed, or duplicate storage never causes a popup", () => {
  const ids = Array.from({ length: 5 }, () => crypto.randomUUID());
  for (const raw of ["{", JSON.stringify([ids[0], ids[0], ids[0], ids[0], ids[0]])]) {
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
