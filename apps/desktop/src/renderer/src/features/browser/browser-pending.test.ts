import { expect, test } from "bun:test";
import { emptyBrowserState, type BrowserState } from "../../../../shared/contracts/browser";
import { projectBrowserState, confirmBrowserState, type BrowserPending } from "./browser-pending";

const tab = (id: string): BrowserState["tabs"][number] => ({
  id,
  viewId: id,
  title: id,
  url: `https://${id}.test/`,
  loading: false,
  error: null,
  canGoBack: false,
  canGoForward: false,
  width: 1280,
  height: 800,
});
const state: BrowserState = {
  ...emptyBrowserState,
  tabs: [tab("a"), tab("b"), tab("c")],
  activeTabId: "a",
};
const pending = (): BrowserPending => ({
  closed: new Set(),
  selected: null,
  navigation: new Map(),
});

test("older metadata cannot reopen an optimistic close or undo the next tab selection", () => {
  const value = pending();
  value.closed.add("a");
  value.selected = "c";
  const projected = confirmBrowserState(state, value);
  expect(projected.tabs.map((tab) => tab.id)).toEqual(["b", "c"]);
  expect(projected.activeTabId).toBe("c");
  value.closed.delete("a");
  expect(projectBrowserState(state, value).activeTabId).toBe("c");
});

test("only a matching host navigation clears the local pending address", () => {
  const value = pending();
  value.navigation.set("a", { id: "navigation", url: "http://localhost:3000/" });
  expect(confirmBrowserState(state, value).tabs[0].url).toBe("http://localhost:3000/");
  expect(value.navigation.size).toBe(1);
  confirmBrowserState(
    {
      ...state,
      tabs: state.tabs.map((tab) =>
        tab.id === "a" ? { ...tab, url: "http://localhost:3000/" } : tab,
      ),
    },
    value,
  );
  expect(value.navigation.size).toBe(0);
});

test("confirmed closes and a restarted host clear obsolete optimistic operations", () => {
  const value = pending();
  value.closed.add("a");
  value.selected = "b";
  value.navigation.set("c", { id: "navigation", url: "http://localhost:3000/" });
  expect(confirmBrowserState(emptyBrowserState, value).activeTabId).toBeNull();
  expect(value.closed.size).toBe(0);
  expect(value.selected).toBeNull();
  expect(value.navigation.size).toBe(0);
});
