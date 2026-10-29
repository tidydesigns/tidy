import { expect, test } from "bun:test";
import { CanvasRefresh } from "./canvas-refresh";

function fixture() {
  const reads: ReturnType<typeof Promise.withResolvers<number>>[] = [];
  const applied: number[] = [];
  const state = { writes: 0, generation: 0 };
  const refresh = new CanvasRefresh({
    read() {
      const read = Promise.withResolvers<number>();
      reads.push(read);
      return read.promise;
    },
    apply: (value) => applied.push(value),
    blocked: () => state.writes > 0,
    generation: () => state.generation,
  });
  return { refresh, reads, applied, state };
}

test("continuous file events publish completed snapshots and share one trailing read", async () => {
  const { refresh, reads, applied } = fixture();
  const pending = refresh.request();
  for (let index = 0; index < 100; index++) expect(refresh.request()).toBe(pending);
  expect(reads).toHaveLength(1);
  reads[0].resolve(1);
  await Promise.resolve();
  expect(applied).toEqual([1]);
  expect(reads).toHaveLength(2);
  refresh.request();
  reads[1].resolve(2);
  await Promise.resolve();
  expect(applied).toEqual([1, 2]);
  reads[2].resolve(3);
  await pending;
  expect(applied).toEqual([1, 2, 3]);
  await refresh.resume();
  expect(reads).toHaveLength(3);
});

test("queued local writes prevent a stale read from undoing the next edit", async () => {
  const { refresh, reads, applied, state } = fixture();
  const pending = refresh.request();
  state.writes++;
  state.generation++;
  refresh.request();
  reads[0].resolve(1);
  await pending;
  expect(applied).toEqual([]);
  expect(reads).toHaveLength(1);
  state.writes--;
  const resumed = refresh.resume();
  reads[1].resolve(2);
  await resumed;
  expect(applied).toEqual([2]);
});

test("a write completed during a read still invalidates it and resumes immediately", async () => {
  const { refresh, reads, applied, state } = fixture();
  const pending = refresh.request();
  state.generation++;
  reads[0].resolve(1);
  await Promise.resolve();
  expect(applied).toEqual([]);
  expect(reads).toHaveLength(2);
  reads[1].resolve(2);
  await pending;
  expect(applied).toEqual([2]);
});

test("a write finishing between drain exit and cleanup resumes the queued read", async () => {
  const { refresh, reads, applied, state } = fixture();
  const pending = refresh.request();
  state.writes++;
  state.generation++;
  reads[0].resolve(1);
  // Let drain observe the write and exit, but resume before its cleanup runs.
  await Promise.resolve();
  expect(applied).toEqual([]);
  state.writes--;
  expect(refresh.resume()).toBe(pending);
  await Promise.resolve();
  expect(reads).toHaveLength(2);
  reads[1].resolve(2);
  await pending;
  expect(applied).toEqual([2]);
});

test("a read restarted during cleanup propagates failure without retrying in a loop", async () => {
  const { refresh, reads, applied, state } = fixture();
  const pending = refresh.request();
  state.writes++;
  state.generation++;
  reads[0].resolve(1);
  await Promise.resolve();
  state.writes--;
  refresh.resume();
  await Promise.resolve();
  expect(reads).toHaveLength(2);
  reads[1].reject(new Error("Invalid JSON"));
  await expect(pending).rejects.toThrow("Invalid JSON");
  expect(reads).toHaveLength(2);
  expect(applied).toEqual([]);
  const repaired = refresh.request();
  reads[2].resolve(3);
  await repaired;
  expect(applied).toEqual([3]);
});

test("partial file failures wait for another event and then recover", async () => {
  const { refresh, reads, applied } = fixture();
  const pending = refresh.request();
  reads[0].reject(new Error("Invalid JSON"));
  await expect(pending).rejects.toThrow("Invalid JSON");
  expect(reads).toHaveLength(1);
  const retried = refresh.request();
  reads[1].resolve(2);
  await retried;
  expect(applied).toEqual([2]);
});

test("a repair event during a failing read is not lost", async () => {
  const { refresh, reads, applied } = fixture();
  const pending = refresh.request();
  refresh.request();
  reads[0].reject(new Error("Partial file"));
  await Promise.resolve();
  expect(reads).toHaveLength(2);
  reads[1].resolve(2);
  await pending;
  expect(applied).toEqual([2]);
});
