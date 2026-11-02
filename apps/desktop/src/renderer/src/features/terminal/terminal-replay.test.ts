import { expect, test } from "bun:test";
import { TerminalReplay } from "./terminal-replay";

test("replays ordered output and resizes, including output received during a theme change", () => {
  const replay = new TerminalReplay();
  replay.reset(80, 24);
  replay.write("before");
  replay.resize(120, 30);
  const snapshot = replay.capture()!;
  replay.write("after");
  expect(snapshot).toMatchObject({
    cols: 80,
    rows: 24,
    events: [{ data: "before" }, { cols: 120, rows: 30 }, { data: "after" }],
  });
  expect(replay.valid(snapshot)).toBe(true);
  replay.reset(90, 20);
  expect(replay.valid(snapshot)).toBe(false);
  expect(replay.capture()?.events).toEqual([]);
});

test("bounds retained output and metadata and never splits a surrogate pair between chunks", () => {
  const replay = new TerminalReplay(32_000);
  replay.reset(80, 24);
  replay.write("x".repeat(15_999) + "😀" + "tail");
  const events = replay.capture()!.events;
  expect(events).toEqual([{ data: "x".repeat(15_999) }, { data: "😀tail" }]);
  replay.write("x".repeat(32_000));
  expect(replay.capture()).toBeUndefined();
  replay.reset(80, 24);
  for (let index = 0; index < 8194; index++) replay.resize(80 + (index % 2), 24);
  expect(replay.capture()).toBeUndefined();
});
