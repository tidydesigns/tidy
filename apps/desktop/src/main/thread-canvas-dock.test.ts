import { expect, test } from "bun:test";
import { discoverCanvases, parseCanvasDock } from "../shared/thread-canvas-dock";

test("introduces one floating canvas, then adds stable dock slots without stealing focus", () => {
  const first = discoverCanvases(parseCanvasDock(null), ["first", "second"]);
  expect(first.ids).toEqual(["first", "second"]);
  expect(first.floatingId).toBe("first");
  const next = discoverCanvases(first, ["third", "second", "first"]);
  expect(next.ids).toEqual(["first", "second", "third"]);
  expect(next.floatingId).toBe("first");
});

test("docking survives persistence and updates never reopen a docked canvas", () => {
  const state = { ids: ["first"], geometry: { first: { x: 30, y: 42, width: 360 } } };
  const restored = parseCanvasDock(JSON.stringify(state));
  expect(restored).toEqual({ ...state, floatingId: undefined });
  const next = discoverCanvases(restored, ["second", "first"]);
  expect(next.floatingId).toBeUndefined();
  expect(next.geometry.first).toEqual(state.geometry.first);
  expect(discoverCanvases(next, ["first", "second"])).toBe(next);
});

test("restores the selected window and discards invalid stored geometry", () => {
  const restored = parseCanvasDock(
    JSON.stringify({
      ids: ["first", "second", "first", null, 5],
      floatingId: "second",
      geometry: { first: { x: "bad", y: 0, width: 300 }, second: { x: 12, y: 18, width: 280 } },
    }),
  );
  expect(restored.ids).toEqual(["first", "second"]);
  expect(restored.floatingId).toBe("second");
  expect(restored.geometry).toEqual({ second: { x: 12, y: 18, width: 280 } });
  expect(parseCanvasDock('{"ids":["first"],"floatingId":"missing"}').floatingId).toBeUndefined();
  for (const invalid of [null, "broken", "null", "[]", '{"ids":"first"}']) {
    expect(parseCanvasDock(invalid)).toEqual({ ids: [], geometry: {} });
  }
});
