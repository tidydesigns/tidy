import { expect, test } from "bun:test";
import { VideoTaskQueue } from "./video-task-queue";

test("transfer admission prioritizes visible recordings, cancels queued work, and releases failed tasks", async () => {
  const queue = new VideoTaskQueue(1);
  const gate = Promise.withResolvers<void>();
  const abort = new AbortController();
  const signal = new AbortController().signal;
  const order: string[] = [];
  const first = queue.run({ signal, task: () => gate.promise });
  const low = queue.run({
    signal,
    priority: () => false,
    task: async () => {
      order.push("offscreen");
    },
  });
  const cancelled = queue.run({
    signal: abort.signal,
    task: async () => {
      order.push("cancelled");
    },
  });
  const visible = queue.run({
    signal,
    task: async () => {
      order.push("visible");
      throw new Error("unavailable");
    },
  });
  const completion = Promise.allSettled([first, low, cancelled, visible]);
  abort.abort();
  gate.resolve();
  const results = await completion;
  expect(results.map((result) => result.status)).toEqual([
    "fulfilled",
    "fulfilled",
    "rejected",
    "rejected",
  ]);
  expect(order).toEqual(["visible", "offscreen"]);
});

test("a cancelled active transfer releases admission without waiting for an unresponsive host", async () => {
  const queue = new VideoTaskQueue(1);
  const pending = Promise.withResolvers<void>();
  const controller = new AbortController();
  const stalled = queue.run({ signal: controller.signal, task: () => pending.promise });
  const results = Promise.allSettled([stalled]);
  await Promise.resolve();
  controller.abort();
  const resumed = await queue.run({
    signal: new AbortController().signal,
    task: async () => "next recording",
  });
  expect(resumed).toBe("next recording");
  expect((await results)[0].status).toBe("rejected");
  pending.resolve();
});
