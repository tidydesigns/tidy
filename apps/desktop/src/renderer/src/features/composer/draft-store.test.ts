import { expect, test } from "bun:test";
import { DraftStore } from "./draft-store";
import type { Draft } from "./machine-context";
const draft: Draft = { text: "Implement this design", harness: "codex", designIds: [] };

test("background reference completions survive machine navigation and notify only the affected machine", () => {
  const store = new DraftStore();
  let local = 0,
    remote = 0;
  store.subscribe("local", () => local++);
  const unsubscribe = store.subscribe("remote", () => remote++);
  store.update("remote", { "project:new": draft });
  unsubscribe();
  store.update("remote", (current) => ({
    ...current,
    "project:new": { ...current["project:new"], text: "User kept typing" },
  }));
  let resumed = 0;
  store.subscribe("remote", () => resumed++);
  store.update("remote", (current) => ({
    ...current,
    "project:new": { ...current["project:new"], designIds: ["imported"] },
  }));
  expect(store.get("remote")["project:new"]).toMatchObject({
    text: "User kept typing",
    designIds: ["imported"],
  });
  expect(store.get("local")).toEqual({});
  expect({ local, remote, resumed }).toEqual({ local: 0, remote: 1, resumed: 1 });
});

test("drafts and selections stay separate for each project, thread, and machine", () => {
  const store = new DraftStore();
  store.update("local", { "one:new": { ...draft, text: "Local" } });
  store.update("remote", {
    "one:new": draft,
    "two:new": { ...draft, text: "Other project" },
    "one:thread": { ...draft, text: "Follow-up" },
  });
  store.update("remote", (current) => ({
    ...current,
    "one:new": { ...current["one:new"], designIds: ["reference"] },
  }));
  expect(store.get("local")["one:new"].text).toBe("Local");
  expect(store.get("remote")["two:new"].text).toBe("Other project");
  expect(store.get("remote")["one:thread"].text).toBe("Follow-up");
  const snapshot = store.get("remote");
  store.update("remote", (current) => current);
  expect(store.get("remote")).toBe(snapshot);
});
