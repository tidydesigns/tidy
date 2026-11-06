import { expect, test } from "bun:test";
import { createBrowserInputBuffer } from "./browser-input-buffer";
import type { BrowserInputEnvelope } from "../../../../shared/contracts/browser";

function fixture() {
  const sent: BrowserInputEnvelope[] = [];
  const callbacks = new Map<number, () => void>();
  let frame = 0;
  const buffer = createBrowserInputBuffer({
    send: (input) => sent.push(input),
    schedule: (callback) => {
      callbacks.set(++frame, callback);
      return frame;
    },
    cancel: (frame) => {
      callbacks.delete(frame);
    },
  });
  return { buffer, sent, callbacks };
}
const wheel = (deltaY: number): BrowserInputEnvelope => ({
  tabId: "tab",
  viewId: "view",
  input: { kind: "wheel", x: 10, y: 20, deltaX: 0, deltaY, modifiers: 0 },
});

test("trackpad bursts cross the transport once per frame and flush before typing", () => {
  const { buffer, sent, callbacks } = fixture();
  for (let i = 0; i < 500; i++) buffer.send(wheel(2));
  expect(sent).toHaveLength(0);
  expect(callbacks.size).toBe(1);
  const text: BrowserInputEnvelope = { ...wheel(0), input: { kind: "text", text: "after" } };
  buffer.send(text);
  expect(sent).toEqual([wheel(1000), text]);
  expect(callbacks.size).toBe(0);
});

test("buffer cancels motion on control or view cleanup and keeps direction changes", () => {
  const { buffer, sent, callbacks } = fixture();
  buffer.send(wheel(3));
  buffer.clear();
  expect(callbacks.size).toBe(0);
  buffer.send(wheel(5));
  buffer.send(wheel(-2));
  expect(sent).toEqual([wheel(5)]);
  for (const callback of callbacks.values()) callback();
  expect(sent).toEqual([wheel(5), wheel(-2)]);
  expect(callbacks.size).toBe(0);
});

test("wheel input crossing scroll regions is flushed at its original position", () => {
  const { buffer, sent, callbacks } = fixture();
  const other = wheel(5);
  if (other.input.kind !== "wheel") throw new Error("Expected wheel input.");
  other.input.x = 200;
  buffer.send(wheel(3));
  buffer.send(other);
  expect(sent).toEqual([wheel(3)]);
  for (const callback of callbacks.values()) callback();
  expect(sent).toEqual([wheel(3), other]);
});
