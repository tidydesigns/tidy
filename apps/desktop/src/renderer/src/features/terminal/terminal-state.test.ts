import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { terminalState, terminalStateSchema, type TerminalState } from "./terminal-state";

test("project tabs retain their selection and screens when hidden, and close selects the adjacent tab", () => {
  let state: TerminalState = {};
  for (const id of ["a", "b", "c"])
    state = terminalState(state, { kind: "new", projectId: "one", id });
  state = terminalState(state, { kind: "new", projectId: "two", id: "d" });
  const other = state.two;
  state = terminalState(state, { kind: "select", projectId: "one", id: "b" });
  state = terminalState(state, { kind: "hide", projectId: "one" });
  expect(state.one).toMatchObject({ selected: "b", open: false });
  expect(state.one.tabs).toHaveLength(3);
  state = terminalState(state, { kind: "show", projectId: "one" });
  state = terminalState(state, { kind: "close", projectId: "one", id: "b" });
  expect(state.one).toMatchObject({ selected: "c", open: true });
  state = terminalState(state, { kind: "close", projectId: "one", id: "c" });
  expect(state.one.selected).toBe("a");
  state = terminalState(state, { kind: "close", projectId: "one", id: "a" });
  expect(state.one).toMatchObject({ selected: null, open: false, tabs: [] });
  expect(state.two).toBe(other);
  state = terminalState(state, { kind: "prune", projects: ["two"] });
  expect(Object.keys(state)).toEqual(["two"]);
});
test("terminal titles are bounded and unchanged shell titles do not trigger React updates", () => {
  const state = terminalState({}, { kind: "new", projectId: "one", id: "a" });
  expect(
    terminalState(state, { kind: "title", projectId: "one", id: "a", title: "Terminal 1" }),
  ).toBe(state);
  const next = terminalState(state, {
    kind: "title",
    projectId: "one",
    id: "a",
    title: "\u0007nvim " + "x".repeat(200),
  });
  expect(next.one.tabs[0].title).toHaveLength(100);
  expect(next.one.tabs[0].title.startsWith("nvim ")).toBe(true);
});

test("a failed close restores its tab without changing a newer selection or reopening a hidden panel", () => {
  let state = terminalState({}, { kind: "new", projectId: "one", id: "a" });
  const tab = state.one.tabs[0];
  state = terminalState(state, { kind: "close", projectId: "one", id: "a" });
  const hidden = terminalState(state, { kind: "restore", projectId: "one", tab, index: 0 });
  expect(hidden.one).toMatchObject({ open: false, selected: "a", tabs: [tab] });
  state = terminalState(state, { kind: "new", projectId: "one", id: "b" });
  state = terminalState(state, { kind: "restore", projectId: "one", tab, index: 0 });
  expect(state.one.selected).toBe("b");
  expect(state.one.tabs.map((t) => t.id)).toEqual(["a", "b"]);
  const removed = terminalState(state, { kind: "prune", projects: [] });
  expect(terminalState(removed, { kind: "restore", projectId: "one", tab, index: 0 })).toBe(
    removed,
  );
});

test("restored tab metadata validates project ownership, selection and bounded tab counts", () => {
  const projectId = randomUUID();
  const state = terminalState({}, { kind: "new", projectId, id: randomUUID() });
  expect(terminalStateSchema.safeParse(JSON.parse(JSON.stringify(state))).success).toBe(true);
  expect(
    terminalStateSchema.safeParse({
      ...state,
      [projectId]: { ...state[projectId], selected: randomUUID() },
    }).success,
  ).toBe(false);
  expect(
    terminalStateSchema.safeParse({
      ...state,
      [projectId]: {
        ...state[projectId],
        tabs: [{ ...state[projectId].tabs[0], projectId: randomUUID() }],
      },
    }).success,
  ).toBe(false);
  for (let i = 0; i < 16; i++)
    state[projectId].tabs.push({ id: randomUUID(), projectId, title: "Terminal" });
  expect(terminalStateSchema.safeParse(state).success).toBe(false);
});
