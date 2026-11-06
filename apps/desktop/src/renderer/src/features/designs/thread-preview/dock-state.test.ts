import { expect, test } from "bun:test";
import {
  activateCanvas,
  discoverCanvases,
  parseCanvasDock,
  revealCanvas,
  toggleCanvas,
} from "./dock-state";

test("introduces one floating canvas, then adds stable canvas entries without stealing focus", () => {
  const first = discoverCanvases(parseCanvasDock(null), ["first", "second"]);
  expect(first.ids).toEqual(["first", "second"]);
  expect(first.openIds).toEqual(["first"]);
  const next = discoverCanvases(first, ["third", "second", "first"]);
  expect(next.ids).toEqual(["first", "second", "third"]);
  expect(next.openIds).toEqual(["first"]);
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

test("accepts legacy widths and retains independent heights without trusting invalid dimensions", () => {
  const stored = {
    ids: ["legacy", "sized", "invalid"],
    openIds: ["sized"],
    geometry: {
      legacy: { x: 20, y: 30, width: 300 },
      sized: { x: 40, y: 50, width: 350, height: 410 },
      invalid: { x: 0, y: 0, width: 300, height: -1 },
    },
  };
  const restored = parseCanvasDock(JSON.stringify(stored));
  expect(restored.geometry.legacy).toEqual(stored.geometry.legacy);
  expect(restored.geometry.sized).toEqual(stored.geometry.sized);
  expect(restored.geometry.invalid).toBeUndefined();
  expect(parseCanvasDock(JSON.stringify(toggleCanvas(restored, "sized"))).geometry).toEqual(
    restored.geometry,
  );
});

test("consumed reveals survive thread remounts while new reveals reopen the canvas", () => {
  const reveal = { id: "request-1", designId: "first" };
  const first = revealCanvas(parseCanvasDock(null), reveal);
  expect(first.openIds).toEqual(["first"]);
  const docked = toggleCanvas(first, "first");
  const remounted = parseCanvasDock(JSON.stringify(docked));
  expect(revealCanvas(remounted, reveal)).toBe(remounted);
  expect(remounted.openIds).toEqual([]);
  expect(revealCanvas(remounted, { ...reveal, id: "request-2" }).openIds).toEqual(["first"]);
});

test("late summaries repair a persisted dock while preserving dismissed windows and legacy geometry", () => {
  const ids = Array.from({ length: 20 }, (_, index) => `design-${index + 1}`);
  const geometry = { "design-1": { x: 30, y: 42, width: 360 } };
  const restored = parseCanvasDock(
    JSON.stringify({ ids: ids.filter((id) => id !== "design-19"), geometry }),
  );
  expect(restored.openIds).toEqual([]);
  const repaired = discoverCanvases(restored, ids);
  expect(new Set(repaired.ids)).toEqual(new Set(ids));
  expect(repaired.openIds).toEqual([]);
  expect(repaired.geometry).toEqual(geometry);
  expect(discoverCanvases(repaired, ids)).toBe(repaired);
});

test("a batch of automatic reveals leaves only the latest preview floating", () => {
  let state = parseCanvasDock(null);
  for (let index = 1; index <= 20; index++) {
    state = revealCanvas(state, { id: `request-${index}`, designId: `design-${index}` });
    expect(state.openIds).toEqual([`design-${index}`]);
  }
  const restored = parseCanvasDock(JSON.stringify(state));
  expect(restored.ids).toHaveLength(20);
  expect(restored.autoOpenedId).toBe("design-20");
  expect(revealCanvas(restored, { id: "request-21", designId: "another" }).openIds).toEqual([
    "another",
  ]);
});

test("automatic reveals preserve previews explicitly opened or interacted with", () => {
  let state = discoverCanvases(parseCanvasDock(null), ["first", "manual", "third"]);
  state = toggleCanvas(state, "manual");
  state = revealCanvas(state, { id: "request-1", designId: "third" });
  expect(state.openIds).toEqual(["manual", "third"]);
  state = activateCanvas(state, "third");
  expect(state.autoOpenedId).toBeUndefined();
  state = revealCanvas(parseCanvasDock(JSON.stringify(state)), {
    id: "request-2",
    designId: "fourth",
  });
  expect(state.openIds).toEqual(["manual", "third", "fourth"]);
  expect(activateCanvas(state, "missing")).toBe(state);
});

test("revealing a manually opened preview does not make it disposable", () => {
  let state = discoverCanvases(parseCanvasDock(null), ["first", "manual"]);
  state = toggleCanvas(state, "manual");
  state = revealCanvas(state, { id: "request-1", designId: "manual" });
  expect(state.openIds).toEqual(["manual"]);
  expect(state.autoOpenedId).toBeUndefined();
  expect(revealCanvas(state, { id: "request-2", designId: "third" }).openIds).toEqual([
    "manual",
    "third",
  ]);
});

test("legacy open windows are retained and invalid automatic-window identities are discarded", () => {
  const legacy = { ids: ["first", "second"], openIds: ["first", "second"], geometry: {} };
  const restored = parseCanvasDock(JSON.stringify(legacy));
  expect(revealCanvas(restored, { id: "request", designId: "third" }).openIds).toEqual([
    "first",
    "second",
    "third",
  ]);
  for (const autoOpenedId of ["missing", 123, null]) {
    expect(parseCanvasDock(JSON.stringify({ ...legacy, autoOpenedId }))).toEqual(restored);
  }
  expect(
    parseCanvasDock(JSON.stringify({ ...legacy, openIds: [], autoOpenedId: "first" })).autoOpenedId,
  ).toBeUndefined();
});
