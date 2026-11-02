import { expect, spyOn, test } from "bun:test";
import { createElement, act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type {
  RepositoryChanges,
  RepositoryDirectory,
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
    expanded,
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

test("refreshes file navigation while Git status is still pending", async () => {
  const pendingStatus = deferred<RepositoryChanges>();
  let statusReads = 0;
  let directoryReads = 0;
  const api: RepositoryAPI = {
    repositoryDirectory: async () => {
      directoryReads++;
      return { entries: [], limited: false };
    },
    repositoryChanges: () =>
      ++statusReads === 1
        ? Promise.resolve({ repository: true, head: "head", changes: [] })
        : pendingStatus.promise,
    repositoryFile: async () => ({ kind: "unavailable", reason: "missing" }),
    onEvent: () => () => {},
  };
  const probe = repositoryProbe(api);
  try {
    await probe.render("");
    const before = directoryReads;
    let refreshed: Promise<void> | undefined;
    await act(async () => {
      refreshed = probe.current?.refresh();
    });
    expect(directoryReads).toBeGreaterThan(before);
    expect(probe.current?.directories.has("")).toBe(true);
    await act(async () => {
      pendingStatus.resolve({ repository: true, head: "head", changes: [] });
      await refreshed;
    });
  } finally {
    await probe.close();
  }
});

test("keeps Git failures separate from available navigation and file content", async () => {
  const api: RepositoryAPI = {
    repositoryDirectory: async () => ({ entries: [], limited: false }),
    repositoryChanges: async () => {
      throw new Error("Git unavailable");
    },
    repositoryFile: async () => ({ kind: "text", view: "file", comparison: "head", text: "hello" }),
    onEvent: () => () => {},
  };
  const probe = repositoryProbe(api);
  try {
    await probe.render("readme.md", true, true);
    expect(probe.current?.changesError).toBe("Git unavailable");
    expect(probe.current?.directoryError).toBe("");
    expect(probe.current?.fileError).toBe("");
    expect(probe.current?.directories.has("")).toBe(true);
    expect(probe.current?.file?.path).toBe("readme.md");
    expect(probe.current?.refreshing).toBe(false);
  } finally {
    await probe.close();
  }
});

test("folder and file failures survive status polling and recover on retry", async () => {
  let available = false;
  let poll: (() => void) | undefined;
  const clock = spyOn(Date, "now").mockReturnValue(1000);
  const interval = spyOn(globalThis, "setInterval").mockImplementation(((callback: () => void) => {
    poll = callback;
    return 0;
  }) as typeof setInterval);
  const api: RepositoryAPI = {
    repositoryDirectory: async () => {
      if (!available) throw new Error("Folder unavailable");
      return { entries: [], limited: false };
    },
    repositoryChanges: async () => ({ repository: true, head: "head", changes: [] }),
    repositoryFile: async () => {
      if (!available) throw new Error("File unavailable");
      return { kind: "text", view: "file", comparison: "head", text: "recovered" };
    },
    onEvent: () => () => {},
  };
  const probe = repositoryProbe(api);
  try {
    await probe.render("readme.md");
    expect(probe.current?.directoryError).toBe("Folder unavailable");
    expect(probe.current?.fileError).toBe("File unavailable");
    expect(probe.current?.changesError).toBe("");
    clock.mockReturnValue(16000);
    await act(async () => poll?.());
    expect(probe.current?.directoryError).toBe("Folder unavailable");
    expect(probe.current?.fileError).toBe("File unavailable");
    available = true;
    await act(async () => {
      await probe.current?.refresh();
    });
    expect(probe.current?.directoryError).toBe("");
    expect(probe.current?.fileError).toBe("");
    expect(probe.current?.directories.has("")).toBe(true);
    expect(probe.current?.file?.path).toBe("readme.md");
  } finally {
    await probe.close();
    interval.mockRestore();
    clock.mockRestore();
  }
});

test("queues visible folder preloads beyond the concurrent request limit", async () => {
  const paths = Array.from({ length: 8 }, (_, index) => `folder-${index}`);
  const pending = new Map(paths.map((path) => [path, deferred<RepositoryDirectory>()]));
  const reads: string[] = [];
  const api: RepositoryAPI = {
    repositoryDirectory: async (_project, path) => {
      if (!path)
        return {
          entries: paths.map((path) => ({ path, name: path, kind: "directory" as const })),
          limited: false,
        };
      reads.push(path);
      return pending.get(path)!.promise;
    },
    repositoryChanges: async () => ({ repository: true, head: "head", changes: [] }),
    repositoryFile: async () => ({ kind: "unavailable", reason: "missing" }),
    onEvent: () => () => {},
  };
  const probe = repositoryProbe(api);
  try {
    await probe.render("");
    await act(async () => {
      paths.forEach((path) => void probe.current?.preload(path));
    });
    expect(reads).toHaveLength(4);
    await act(async () => {
      paths
        .slice(0, 4)
        .forEach((path) => pending.get(path)!.resolve({ entries: [], limited: false }));
    });
    expect(reads).toEqual(paths);
    await act(async () => {
      paths.slice(4).forEach((path) => pending.get(path)!.resolve({ entries: [], limited: false }));
    });
    expect(paths.every((path) => probe.current?.directories.has(path))).toBe(true);
  } finally {
    await probe.close();
  }
});

test("unchanged status polls retain previews and folders, with a full missed-event fallback", async () => {
  let directoryReads = 0;
  let fileReads = 0;
  let statusReads = 0;
  let poll: (() => void) | undefined;
  const clock = spyOn(Date, "now").mockReturnValue(1000);
  const interval = spyOn(globalThis, "setInterval");
  interval.mockImplementation(((callback: () => void) => {
    poll = callback;
    return 0;
  }) as typeof setInterval);
  const api: RepositoryAPI = {
    repositoryDirectory: async (_project, path) => {
      directoryReads++;
      return {
        entries: path ? [] : [{ path: "src", name: "src", kind: "directory" }],
        limited: false,
      };
    },
    repositoryChanges: async () => {
      statusReads++;
      return { repository: true, head: "head", changes: [] };
    },
    repositoryFile: async () => {
      fileReads++;
      return { kind: "text", view: "file", comparison: "none", text: "available" };
    },
    onEvent: () => () => {},
  };
  const probe = repositoryProbe(api);
  try {
    probe.expanded.add("src");
    await probe.render("a");
    expect(directoryReads).toBe(2);
    for (let index = 0; index < 3; index++) {
      clock.mockReturnValue(16000 + index * 15000);
      await act(async () => poll?.());
    }
    expect(statusReads).toBe(4);
    expect(directoryReads).toBe(2);
    expect(fileReads).toBe(1);
    expect(probe.current?.contentRevision.id).toBe(0);
    clock.mockReturnValue(61000);
    await act(async () => poll?.());
    expect(directoryReads).toBe(4);
    expect(fileReads).toBe(2);
    expect(probe.current?.contentRevision.id).toBe(1);
  } finally {
    await probe.close();
    interval.mockRestore();
    clock.mockRestore();
  }
});

test("bounded preview requests discard queued obsolete selections", async () => {
  const pending = Array.from({ length: 4 }, () => deferred<RepositoryFile>());
  const reads: string[] = [];
  const content: RepositoryFile = { kind: "text", text: "ready", view: "file", comparison: "none" };
  const api: RepositoryAPI = {
    repositoryDirectory: async () => ({ entries: [], limited: false }),
    repositoryChanges: async () => ({ repository: false, head: null, changes: [] }),
    repositoryFile: async (_project, path) => {
      reads.push(path);
      return pending[Number(path)]?.promise ?? content;
    },
    onEvent: () => () => {},
  };
  const probe = repositoryProbe(api);
  try {
    for (const path of ["0", "1", "2", "3", "obsolete", "latest"]) await probe.render(path);
    expect(reads).toEqual(["0", "1", "2", "3"]);
    await act(async () => {
      pending[0].resolve(content);
      await pending[0].promise;
    });
    expect(reads).toEqual(["0", "1", "2", "3", "latest"]);
    expect(probe.current?.file?.path).toBe("latest");
    await act(async () => pending.slice(1).forEach((request) => request.resolve(content)));
    expect(probe.current?.file?.path).toBe("latest");
  } finally {
    await act(async () => pending.forEach((request) => request.resolve(content)));
    await probe.close();
  }
});

test("folder failures survive unrelated success and clear only as each folder recovers", async () => {
  const failed = new Set(["a", "b"]);
  const api: RepositoryAPI = {
    repositoryDirectory: async (_project, path) => {
      if (failed.has(path)) throw new Error(`Unavailable: ${path}`);
      return {
        entries: path
          ? []
          : ["a", "b", "good"].map((name) => ({ path: name, name, kind: "directory" as const })),
        limited: false,
      };
    },
    repositoryChanges: async () => ({ repository: true, head: "head", changes: [] }),
    repositoryFile: async () => ({ kind: "unavailable", reason: "missing" }),
    onEvent: () => () => {},
  };
  const probe = repositoryProbe(api);
  try {
    await probe.render("");
    await act(async () => {
      await probe.current?.preload("a");
      await probe.current?.preload("b");
      await probe.current?.preload("good");
    });
    expect(probe.current?.directoryError).toBe("Unavailable: b");
    failed.delete("b");
    await act(async () => probe.current?.refresh(["b"]));
    expect(probe.current?.directoryError).toBe("Unavailable: a");
    failed.delete("a");
    await act(async () => probe.current?.refresh(["a"]));
    expect(probe.current?.directoryError).toBe("");
  } finally {
    await probe.close();
  }
});

test("status reconciliation reloads each cached parent once and skips unopened parents", async () => {
  const reads: string[] = [];
  let changes: RepositoryChanges["changes"] = [];
  const api: RepositoryAPI = {
    repositoryDirectory: async (_project, path) => {
      reads.push(path);
      return {
        entries: path ? [] : [{ path: "src", name: "src", kind: "directory" }],
        limited: false,
      };
    },
    repositoryChanges: async () => ({ repository: true, head: "head", changes }),
    repositoryFile: async () => ({ kind: "unavailable", reason: "missing" }),
    onEvent: () => () => {},
  };
  const probe = repositoryProbe(api);
  try {
    probe.expanded.add("src");
    await probe.render("");
    reads.length = 0;
    changes = ["src/a", "src/b", "unopened/c"].map((path) => ({
      path,
      previousPath: null,
      status: "added",
    }));
    await act(async () => probe.current?.refresh([], true));
    expect(reads).toEqual(["src"]);
    expect(probe.current?.contentRevision.paths).toEqual(["src/a", "src/b", "unopened/c"]);
  } finally {
    await probe.close();
  }
});
