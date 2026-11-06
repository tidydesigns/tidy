import { expect, test } from "bun:test";
import { BrowserInputQueue } from "./input-queue";
import type { BrowserInput, BrowserInputEnvelope } from "../../shared/contracts/browser";

const envelope = (input: BrowserInput): BrowserInputEnvelope => ({
  tabId: "tab",
  viewId: "view",
  input,
});
const move = (x: number, buttons = 0): Extract<BrowserInput, { kind: "mouse" }> => ({
  kind: "mouse",
  action: "move",
  x,
  y: 0,
  buttons,
  button: "none",
  clickCount: 0,
  modifiers: 0,
});
const wheel = (deltaY: number): Extract<BrowserInput, { kind: "wheel" }> => ({
  kind: "wheel",
  x: 10,
  y: 20,
  deltaX: 0,
  deltaY,
  modifiers: 0,
});

function fixture() {
  const blocked = Promise.withResolvers<void>();
  const started = Promise.withResolvers<void>();
  const idle = Promise.withResolvers<void>();
  const sent: BrowserInputEnvelope[] = [];
  const queue = new BrowserInputQueue({
    dispatch: async (input) => {
      if (!sent.length) {
        sent.push(input);
        started.resolve();
        await blocked.promise;
      } else sent.push(input);
      if (input.input.kind === "release-keys") idle.resolve();
    },
    failed: (error) => {
      throw error;
    },
  });
  queue.push(envelope(move(0)));
  return { queue, sent, blocked, started, idle };
}

test("slow dispatch coalesces hundreds of trackpad events without losing travel or clicks", async () => {
  const { queue, sent, blocked, idle } = fixture();
  for (let i = 1; i <= 500; i++) expect(queue.push(envelope(move(i)))).toBe(true);
  const click: BrowserInput = { ...move(500), kind: "mouse", action: "down", button: "left" };
  queue.push(envelope(click));
  for (let i = 0; i < 500; i++) expect(queue.push(envelope(wheel(2)))).toBe(true);
  queue.push(envelope(wheel(-8)));
  queue.push(envelope({ kind: "text", text: "after scroll" }));
  queue.push(envelope({ kind: "release-keys" }));
  blocked.resolve();
  await idle.promise;
  expect(sent.map(({ input }) => input)).toEqual([
    move(0),
    move(500),
    click,
    wheel(1000),
    wheel(-8),
    { kind: "text", text: "after scroll" },
    { kind: "release-keys" },
  ]);
});

test("coalescing preserves view, control generation, drag buttons and wheel modifiers", async () => {
  const { queue, sent, blocked, idle } = fixture();
  queue.push(envelope(move(1)), 1);
  queue.push(envelope(move(2)), 2);
  queue.push({ ...envelope(move(3)), viewId: "next-view" }, 2);
  queue.push(envelope(move(4, 1)), 2);
  queue.push(envelope(wheel(1)));
  queue.push(envelope({ ...wheel(2), kind: "wheel", modifiers: 4 }));
  queue.push(envelope({ kind: "release-keys" }));
  blocked.resolve();
  await idle.promise;
  expect(sent).toHaveLength(8);
});

test("control handoff discards queued input while keeping discrete overload bounded", async () => {
  const { queue, sent, blocked, idle } = fixture();
  for (let i = 0; i < 64; i++)
    expect(queue.push(envelope({ kind: "text", text: "old" }))).toBe(true);
  expect(queue.push(envelope({ kind: "text", text: "overflow" }))).toBe(false);
  queue.clear();
  queue.push(envelope({ kind: "text", text: "fresh" }));
  queue.push(envelope({ kind: "release-keys" }));
  blocked.resolve();
  await idle.promise;
  expect(sent.map(({ input }) => input)).toEqual([
    move(0),
    { kind: "text", text: "fresh" },
    { kind: "release-keys" },
  ]);
});

test("scroll coalescing never clamps travel beyond the protocol bound", async () => {
  const { queue, sent, blocked, idle } = fixture();
  queue.push(envelope(wheel(9000)));
  queue.push(envelope(wheel(2000)));
  queue.push(envelope({ kind: "release-keys" }));
  blocked.resolve();
  await idle.promise;
  expect(sent.slice(1, 3).map(({ input }) => input)).toEqual([wheel(9000), wheel(2000)]);
});
