import { expect, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import { useRepositorySearch } from "./use-repository-search";
import type { RepositoryAPI } from "./use-repository-files";
import type { RepositorySearch } from "../../../../shared/contracts/repository-search";

test("ignores stale searches and cancels queued searches when cleared or unmounted", async () => {
  const window = new Window();
  const globals = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({
    window,
    document: window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    globals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const requests = new Map<string, (result: RepositorySearch) => void>();
  const api: RepositoryAPI = {
    repositoryDirectory: async () => ({ entries: [], limited: false }),
    repositoryChanges: async () => ({ repository: false, head: null, changes: [] }),
    repositoryFile: async () => ({ kind: "unavailable", reason: "missing" }),
    repositorySearch: (_project, query) =>
      new Promise((resolve) => {
        requests.set(query, resolve);
      }),
    onEvent: () => () => {},
  };
  let state: ReturnType<typeof useRepositorySearch> | undefined;
  function Probe({ query }: { query: string }) {
    state = useRepositorySearch(api, "fixture", query, true, 0);
    return null;
  }
  const root = createRoot(document.createElement("div"));
  const render = (query: string) => act(async () => root.render(createElement(Probe, { query })));
  const settle = () =>
    act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 210));
    });
  try {
    await render("old");
    await settle();
    await render("new");
    await settle();
    const fresh: RepositorySearch = {
      entries: [{ path: "new.txt", name: "new.txt", kind: "file" }],
      limited: false,
    };
    await act(async () => {
      requests.get("new")!(fresh);
    });
    await act(async () => {
      requests.get("old")!({ entries: [], limited: true });
    });
    expect(state?.entries).toEqual(fresh.entries);
    expect(state?.limited).toBe(false);
    await render("cancelled");
    await render("");
    expect(state?.entries).toEqual([]);
    await render("unmounted");
    await act(async () => root.unmount());
    await settle();
    expect([...requests.keys()]).toEqual(["old", "new"]);
  } finally {
    await act(async () => root.unmount());
    await window.happyDOM.close();
    for (const [key, descriptor] of globals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
