import { expect, test } from "bun:test";
import { createPreviewPointerGesture, gestureMoved } from "./pointer";

test("a canvas click tolerates pointer jitter and opens", () => {
  const gesture = createPreviewPointerGesture();
  expect(gesture.start(1, 100, 100, false)).toBe(false);
  expect(gesture.move(1, 102, 101)).toBeUndefined();
  expect(gesture.finish(1, false)).toBe(false);
});

test("a normal drag suppresses opening even after returning to the starting point", () => {
  const gesture = createPreviewPointerGesture();
  gesture.start(1, 100, 100, false);
  expect(gesture.move(1, 150, 120)).toEqual({ x: 0, y: 0 });
  gesture.move(1, 100, 100);
  expect(gesture.finish(1, false)).toBe(true);
});

test("Space drag pans by accumulated deltas and never opens on release", () => {
  const gesture = createPreviewPointerGesture();
  expect(gesture.start(1, 100, 100, true)).toBe(true);
  expect(gesture.move(1, 102, 101)).toBeUndefined();
  expect(gesture.move(1, 120, 110)).toEqual({ x: 20, y: 10 });
  expect(gesture.move(1, 125, 108)).toEqual({ x: 5, y: -2 });
  expect(gesture.finish(1, false)).toBe(true);
  gesture.start(2, 0, 0, true);
  expect(gesture.finish(2, false)).toBe(true);
});

test("cancellation and capture loss suppress the gesture without poisoning the next click", () => {
  const gesture = createPreviewPointerGesture();
  gesture.start(1, 0, 0, false);
  expect(gesture.move(2, 100, 100)).toBeUndefined();
  expect(gesture.finish(2, false)).toBeUndefined();
  expect(gesture.finish(1, true)).toBe(true);
  expect(gesture.finish(1, true)).toBeUndefined();
  gesture.start(3, 0, 0, false);
  expect(gesture.finish(3, false)).toBe(false);
});

test("click tolerance distinguishes jitter from a completed drag", () => {
  expect(gestureMoved(2, 2)).toBe(false);
  expect(gestureMoved(3, 4)).toBe(true);
  expect(gestureMoved(-6, 0)).toBe(true);
});
