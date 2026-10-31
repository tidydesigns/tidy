import { expect, test } from "bun:test";
import { createElement, act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type {
  RepositoryChanges,
  RepositoryFile,
} from "../../../../shared/contracts/repository-files";
import { useRepositoryFiles, type RepositoryAPI } from "./use-repository-files";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function repositoryProbe(api: RepositoryAPI) {
  const window = new Window({ url: "https://fixture.invalid" });
  const globals = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({
    window,
    document: window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    globals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const root = createRoot(document.createElement("div"));
  const expanded = new Set<string>();
  let state: ReturnType<typeof useRepositoryFiles> | undefined;
  function Probe({
    selected,
    active,
    continuous,
  }: {
    selected: string;
    active: boolean;
    continuous: boolean;
  }) {
    state = useRepositoryFiles({
      api,
      projectId: "fixture",
      active,
      selected,
      expanded,
      continuous,
    });
    return null;
  }
  return {
    get current() {
      return state;
    },
    render: (selected = "a", active = true, continuous = false) =>
      act(async () => root.render(createElement(Probe, { selected, active, continuous }))),
    async close() {
      try {
        await act(async () => root.unmount());
        await window.happyDOM.close();
      } finally {
        for (const [key, descriptor] of globals) {
          if (descriptor) Object.defineProperty(globalThis, key, descriptor);
          else Reflect.deleteProperty(globalThis, key);
        }
      }
    },
  };
}

test("keeps the first preview and rejects stale content before React commits refresh", async () => {
  const status = deferred<RepositoryChanges>();
  const refreshedStatus = deferred<RepositoryChanges>();
  const oldFile = deferred<RepositoryFile>();
  let changeReads = 0;
  const previousPaths: (string | undefined)[] = [];
  const fresh: RepositoryFile = { kind: "text", view: "file", comparison: "head", text: "NEW" };
  let directoryReads = 0,
    fileReads = 0;
  const api: RepositoryAPI = {
    repositoryDirectory: async () => {
      directoryReads++;
      return { entries: [], limited: false };
    },
    repositoryChanges: () => (++changeReads === 1 ? status.promise : refreshedStatus.promise),
    repositoryFile: (_project, _path, previousPath) => {
      previousPaths.push(previousPath);
      return ++fileReads === 1 ? oldFile.promise : Promise.resolve(fresh);
    },
    onEvent: () => () => {},
  };
  const probe = repositoryProbe(api);
  try {
    await probe.render();
    expect(fileReads).toBe(1);
    expect(directoryReads).toBe(1);
    await act(async () => {
      status.resolve({ repository: true, head: "head", changes: [] });
      await status.promise;
    });
    expect(fileReads).toBe(1);
    expect(previousPaths).toEqual([undefined]);
    await act(async () => {
      const refresh = probe.current?.refresh([]);
      refreshedStatus.resolve({
        repository: true,
        head: "head",
        changes: [{ path: "a", previousPath: "old", status: "renamed" }],
      });
      await refreshedStatus.promise;
      await Promise.resolve();
      oldFile.resolve({ kind: "text", view: "file", comparison: "head", text: "OLD" });
      await oldFile.promise;
      await refresh;
    });
    expect(fileReads).toBe(2);
    expect(probe.current?.file?.content).toEqual(fresh);
    expect(previousPaths).toEqual([undefined, "old"]);
  } finally {
    await probe.close();
  }
});

for (const status of ["failed", "renamed", "unrelated"] as const)
  test(`initial ${status} status only rereads a file when its comparison changes`, async () => {
    const content: RepositoryFile = {
      kind: "text",
      text: "available",
      view: "file",
      comparison: "none",
    };
    let reads = 0;
    const api: RepositoryAPI = {
      repositoryDirectory: async () => ({ entries: [], limited: false }),
      repositoryChanges: async () => {
        if (status === "failed") throw new Error("");
        return {
          repository: true,
          head: "head",
          changes:
            status === "renamed" || status === "unrelated"
              ? [
                  {
                    path: status === "renamed" ? "a" : "b",
                    previousPath: "old",
                    status: "renamed" as const,
                  },
                ]
              : [],
        };
      },
      repositoryFile: async (_project, _path, previousPath) => {
        reads++;
        return status === "renamed" && previousPath !== "old"
          ? { ...content, text: "wrong baseline" }
          : content;
      },
      onEvent: () => () => {},
    };
    const probe = repositoryProbe(api);
    try {
      await probe.render();
      expect(reads).toBe(status === "renamed" ? 2 : 1);
      expect(probe.current?.file?.content).toEqual(content);
      expect(probe.current?.error).toBe(status === "failed" ? "Could not read Git changes." : "");
    } finally {
      await probe.close();
    }
  });

for (const folderFailed of [false, true])
  test(`cached file recovery preserves folder errors (${folderFailed})`, async () => {
    const content: RepositoryFile = {
      kind: "text",
      text: "available",
      view: "file",
      comparison: "none",
    };
    const reads: string[] = [];
    const api: RepositoryAPI = {
      repositoryDirectory: async () => {
        if (folderFailed) throw new Error("The folder could not be opened.");
        return { entries: [], limited: false };
      },
      repositoryChanges: async () => ({ repository: false, head: null, changes: [] }),
      repositoryFile: async (_project, path) => {
        reads.push(path);
        if (path === "missing") throw new Error("The file could not be opened.");
        return content;
      },
      onEvent: () => () => {},
    };
    const probe = repositoryProbe(api);
    try {
      await probe.render("available");
      await probe.render("missing");
      expect(probe.current?.error).toBe("The file could not be opened.");
      await probe.render("available");
      expect(probe.current?.file?.content).toEqual(content);
      expect(probe.current?.error).toBe(folderFailed ? "The folder could not be opened." : "");
      expect(reads).toEqual(["available", "missing"]);
    } finally {
      await probe.close();
    }
  });

test("scoped refreshes retain unrelated reads and caches while HEAD changes invalidate them", async () => {
  const pending = deferred<RepositoryFile>();
  const reads = new Map<string, number>();
  let head = "first";
  let filtered = false;
  const content: RepositoryFile = {
    kind: "text",
    view: "file",
    comparison: "head",
    text: "available",
  };
  const api: RepositoryAPI = {
    repositoryDirectory: async () => ({ entries: [], limited: false }),
    repositoryChanges: async () => ({
      repository: true,
      head,
      changes: filtered
        ? [{ path: "src/a", previousPath: null, status: "modified", filtered: true }]
        : [],
    }),
    repositoryFile: async (_project, path) => {
      const count = (reads.get(path) ?? 0) + 1;
      reads.set(path, count);
      return path === "src/a" && count === 1 ? pending.promise : content;
    },
    onEvent: () => () => {},
  };
  const probe = repositoryProbe(api);
  try {
    await probe.render("src/a");
    for (let index = 0; index < 3; index++)
      await act(async () => {
        await probe.current?.refresh(["other"]);
      });
    await act(async () => {
      pending.resolve(content);
      await pending.promise;
    });
    expect(probe.current?.file?.content).toEqual(content);
    expect(reads.get("src/a")).toBe(1);
    await probe.render("other/b");
    await probe.render("src/a");
    await act(async () => {
      await probe.current?.refresh(["other"]);
    });
    expect(reads.get("src/a")).toBe(1);
    await probe.render("other/b");
    expect(reads.get("other/b")).toBe(2);
    await act(async () => {
      await probe.current?.refresh(["other"]);
    });
    expect(reads.get("other/b")).toBe(3);
    await probe.render("src/a");
    expect(reads.get("src/a")).toBe(1);
    await act(async () => {
      await probe.current?.refresh();
    });
    expect(reads.get("src/a")).toBe(2);
    head = "second";
    await act(async () => {
      await probe.current?.refresh(["other"]);
    });
    expect(reads.get("src/a")).toBe(3);
    filtered = true;
    await act(async () => {
      await probe.current?.refresh(["other"]);
    });
    expect(reads.get("src/a")).toBe(4);
    expect(probe.current?.changes?.changes[0].filtered).toBe(true);
    await probe.render("src/a", false);
    await probe.render("src/a");
    expect(reads.get("src/a")).toBe(5);
  } finally {
    await probe.close();
  }
});

test("continuous review owns changed-file reads and receives background invalidations", async () => {
  const status = deferred<RepositoryChanges>();
  let reads = 0;
  const api: RepositoryAPI = {
    repositoryDirectory: async () => ({ entries: [], limited: false }),
    repositoryChanges: () => status.promise,
    repositoryFile: async () => {
      reads++;
      return { kind: "text", view: "file", comparison: "head", text: "available" };
    },
    onEvent: () => () => {},
  };
  const probe = repositoryProbe(api);
  try {
    await probe.render("changed", true, true);
    expect(reads).toBe(0);
    await act(async () => {
      status.resolve({
        repository: true,
        head: "head",
        changes: [{ path: "changed", previousPath: null, status: "modified" }],
      });
      await status.promise;
    });
    expect(reads).toBe(0);
    const before = probe.current?.contentRevision.id ?? 0;
    await act(async () => {
      await probe.current?.refresh(["changed"]);
    });
    expect(probe.current?.contentRevision.id).toBeGreaterThan(before);
    expect(probe.current?.contentRevision.paths).toEqual(["changed"]);
    expect(reads).toBe(0);
    await probe.render("unchanged", true, true);
    expect(reads).toBe(1);
    expect(probe.current?.file?.path).toBe("unchanged");
  } finally {
    await probe.close();
  }
});
