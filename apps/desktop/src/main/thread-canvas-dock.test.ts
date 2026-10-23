import { expect, test } from "bun:test";
import { discoverCanvases, parseCanvasDock, toggleCanvas } from "../shared/thread-canvas-dock";

test("introduces one floating canvas, then adds stable canvas entries without stealing focus", () => {
  const first = discoverCanvases(parseCanvasDock(null), ["first", "second"]);
  expect(first.ids).toEqual(["first", "second"]);
  expect(first.openIds).toEqual(["first"]);
  const next = discoverCanvases(first, ["third", "second", "first"]);
  expect(next.ids).toEqual(["first", "second", "third"]);
  expect(next.openIds).toEqual(["first"]);
});

test("docking survives persistence and updates never reopen a docked canvas", () => {
  const state = { ids: ["first"], geometry: { first: { x: 30, y: 42, width: 360 } } };
  const restored = parseCanvasDock(JSON.stringify(state));
  expect(restored).toEqual({ ...state, openIds: [] });
  const next = discoverCanvases(restored, ["second", "first"]);
  expect(next.openIds).toEqual([]);
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
  expect(restored.openIds).toEqual(["second"]);
  expect(restored.geometry).toEqual({ second: { x: 12, y: 18, width: 280 } });
  expect(parseCanvasDock('{"ids":["first"],"floatingId":"missing"}').openIds).toEqual([]);
  for (const invalid of [null, "broken", "null", "[]", '{"ids":"first"}']) {
    expect(parseCanvasDock(invalid)).toEqual({ ids: [], openIds: [], geometry: {} });
  }
});

test("opens and docks several canvases independently and restores them after navigation", () => {
  let state = discoverCanvases(parseCanvasDock(null), ["first", "second", "third"]);
  state = toggleCanvas(state, "second");
  state = toggleCanvas(state, "third");
  expect(state.openIds).toEqual(["first", "second", "third"]);
  state = toggleCanvas(state, "second");
  expect(state.openIds).toEqual(["first", "third"]);
  expect(parseCanvasDock(JSON.stringify(state)).openIds).toEqual(["first", "third"]);
  expect(toggleCanvas(state, "missing")).toBe(state);
  expect(
    parseCanvasDock(JSON.stringify({ ...state, openIds: ["third", "third", "missing"] })).openIds,
  ).toEqual(["third"]);
  expect(
    parseCanvasDock(JSON.stringify({ ...state, openIds: [], floatingId: "first" })).openIds,
  ).toEqual([]);
});
