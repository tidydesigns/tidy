import { expect, spyOn, test } from "bun:test";
import type { RepositoryFile } from "../../../../shared/contracts/repository-files";
import { createFilePrefetch } from "./file-prefetch";
import type { RepositoryAPI } from "./use-repository-files";

const content: RepositoryFile = {
  kind: "text",
  text: "export const example = 1;",
  comparison: "none",
  view: "file",
};
const turn = () => new Promise((resolve) => setTimeout(resolve, 0));
function fixture() {
  const resolved: string[] = [];
  const reads: string[] = [];
  let listener: Parameters<RepositoryAPI["onEvent"]>[0] | undefined;
  let subscriptions = 0;
  const api: RepositoryAPI = {
    repositoryDirectory: async () => ({ entries: [], limited: false }),
    repositoryChanges: async () => ({ repository: false, head: null, changes: [] }),
    onEvent: (callback) => {
      subscriptions++;
      listener = callback;
      return () => {
        subscriptions--;
        listener = undefined;
      };
    },
    resolveRepositoryLink: async (_, href) => {
      resolved.push(href);
      return href.split(":")[0];
    },
    repositoryFile: async (_, path) => {
      reads.push(path);
      return content;
    },
  };
  return {
    api,
    resolved,
    reads,
    get subscriptions() {
      return subscriptions;
    },
    change(path: string) {
      listener?.({ type: "repository-change", projectId: "fixture", path });
    },
  };
}

test("hover, focus, and clicks share successful reads across line positions", async () => {
  const source = fixture();
  const cache = createFilePrefetch({ api: source.api, projectId: "fixture" });
  try {
    cache.prefetch("example.ts:2");
    cache.prefetch("example.ts:8");
    expect(await cache.resolve("example.ts:20")).toBe("example.ts");
    expect(await cache.read("example.ts")).toBe(content);
    expect(source.resolved).toEqual(["example.ts:2"]);
    expect(source.reads).toEqual(["example.ts"]);
  } finally {
    cache.dispose();
  }
});

test("prefetch skips disconnected machines and limits work while the pointer crosses links", async () => {
  const source = fixture();
  let enabled = false;
  const completions: (() => void)[] = [];
  source.api.resolveRepositoryLink = (_, href) => {
    source.resolved.push(href);
    return new Promise((resolve) => {
      completions.push(() => resolve(href));
    });
  };
  const cache = createFilePrefetch({
    api: source.api,
    projectId: "fixture",
    enabled: () => enabled,
  });
  try {
    cache.prefetch("offline.ts");
    expect(source.resolved).toEqual([]);
    enabled = true;
    for (let index = 0; index < 50; index++) cache.prefetch(`file${index}.ts`);
    await turn();
    expect(source.resolved).toEqual(["file0.ts", "file1.ts"]);
    cache.dispose();
    completions.forEach((complete) => complete());
    await turn();
    expect(source.reads).toEqual([]);
  } finally {
    cache.dispose();
  }
});

test("hover failures do not prevent a later click from retrying", async () => {
  const source = fixture();
  let failures = 1;
  source.api.repositoryFile = async (_, path) => {
    source.reads.push(path);
    if (failures--) throw new Error("Temporary read failure");
    return content;
  };
  const cache = createFilePrefetch({ api: source.api, projectId: "fixture" });
  try {
    cache.prefetch("example.ts:2");
    await turn();
    expect(await cache.read("example.ts")).toBe(content);
    expect(source.reads).toEqual(["example.ts", "example.ts"]);
  } finally {
    cache.dispose();
  }
});

test("missing previews are not cached and file changes invalidate warmed content", async () => {
  const source = fixture();
  source.api.repositoryFile = async (_, path) => {
    source.reads.push(path);
    return source.reads.length === 1 ? { kind: "unavailable", reason: "missing" } : content;
  };
  const cache = createFilePrefetch({ api: source.api, projectId: "fixture" });
  try {
    await cache.read("example.ts");
    expect(await cache.read("example.ts")).toBe(content);
    source.change("example.ts");
    expect(await cache.read("example.ts")).toBe(content);
    expect(source.reads).toHaveLength(3);
  } finally {
    cache.dispose();
  }
});

test("cache entries expire and remain separate across worktree scopes", async () => {
  const source = fixture();
  const sibling = fixture();
  const cache = createFilePrefetch({ api: source.api, projectId: "fixture" });
  const other = createFilePrefetch({ api: sibling.api, projectId: "fixture" });
  const time = spyOn(Date, "now");
  try {
    time.mockReturnValue(100);
    await cache.read("example.ts");
    await other.read("example.ts");
    expect(source.reads).toHaveLength(1);
    expect(sibling.reads).toHaveLength(1);
    time.mockReturnValue(2101);
    await cache.read("example.ts");
    expect(source.reads).toHaveLength(2);
  } finally {
    time.mockRestore();
    cache.dispose();
    other.dispose();
  }
});

test("disposal removes subscriptions and the same instance can be used after effect setup repeats", async () => {
  const source = fixture();
  const cache = createFilePrefetch({ api: source.api, projectId: "fixture" });
  await cache.read("example.ts");
  expect(source.subscriptions).toBe(1);
  cache.dispose();
  expect(source.subscriptions).toBe(0);
  await cache.read("example.ts");
  expect(source.subscriptions).toBe(1);
  expect(source.reads).toHaveLength(2);
  cache.dispose();
});

test("the preview cache retains at most six files", async () => {
  const source = fixture();
  const cache = createFilePrefetch({ api: source.api, projectId: "fixture" });
  try {
    for (let index = 0; index < 20; index++) await cache.read(`file${index}.ts`);
    await cache.read("file19.ts");
    expect(source.reads).toHaveLength(20);
    await cache.read("file0.ts");
    expect(source.reads).toHaveLength(21);
  } finally {
    cache.dispose();
  }
});

test("a click awaiting prefetched content receives fresh text if a file changes during the read", async () => {
  const source = fixture();
  let complete: ((file: RepositoryFile) => void) | undefined;
  source.api.repositoryFile = async (_, path) => {
    source.reads.push(path);
    if (source.reads.length === 1)
      return new Promise<RepositoryFile>((resolve) => {
        complete = resolve;
      });
    return { ...content, text: "Updated source" };
  };
  const cache = createFilePrefetch({ api: source.api, projectId: "fixture" });
  try {
    cache.prefetch("example.ts:2");
    await turn();
    const clicked = cache.read("example.ts");
    source.change("example.ts");
    complete?.(content);
    expect(await clicked).toMatchObject({ kind: "text", text: "Updated source" });
    expect(source.reads).toHaveLength(2);
  } finally {
    cache.dispose();
  }
});

test("repository changes in other projects leave the warmed preview available", async () => {
  const source = fixture();
  let notify: Parameters<RepositoryAPI["onEvent"]>[0] | undefined;
  source.api.onEvent = (callback) => {
    notify = callback;
    return () => {};
  };
  const cache = createFilePrefetch({ api: source.api, projectId: "fixture" });
  try {
    await cache.read("example.ts");
    notify?.({ type: "repository-change", projectId: "other", path: "example.ts" });
    await cache.read("example.ts");
    expect(source.reads).toHaveLength(1);
    notify?.({ type: "repository-change", projectId: "fixture", path: "" });
    await cache.read("example.ts");
    expect(source.reads).toHaveLength(2);
  } finally {
    cache.dispose();
  }
});

test("continuous edits stop a waiting click after one fresh read", async () => {
  const source = fixture();
  const completions: ((file: RepositoryFile) => void)[] = [];
  source.api.repositoryFile = async (_, path) => {
    source.reads.push(path);
    return new Promise<RepositoryFile>((resolve) => completions.push(resolve));
  };
  const cache = createFilePrefetch({ api: source.api, projectId: "fixture" });
  try {
    const clicked = cache.read("example.ts");
    const result = clicked.catch((cause: unknown) => cause);
    await turn();
    source.change("example.ts");
    completions[0]?.(content);
    await turn();
    source.change("example.ts");
    completions[1]?.(content);
    expect(await result).toMatchObject({
      message: "This file changed while opening. Try again.",
    });
    expect(source.reads).toHaveLength(2);
  } finally {
    cache.dispose();
  }
});

test("file viewer preparation is shared and a failed import can retry on later intent", async () => {
  const source = fixture();
  let attempts = 0;
  const cache = createFilePrefetch({
    api: source.api,
    projectId: "fixture",
    prepare: async () => {
      attempts++;
      if (attempts === 1) throw new Error("Temporary import failure");
    },
  });
  try {
    cache.prefetch("example.ts:1");
    cache.prefetch("example.ts:2");
    await turn();
    expect(attempts).toBe(1);
    cache.prefetch("example.ts:3");
    await turn();
    expect(attempts).toBe(2);
    cache.prefetch("example.ts:4");
    await turn();
    expect(attempts).toBe(2);
  } finally {
    cache.dispose();
  }
});

test("large warmed previews stay within the retained text limit", async () => {
  const source = fixture();
  source.api.repositoryFile = async (_, path) => {
    source.reads.push(path);
    return { ...content, text: "x".repeat(1024 * 1024) };
  };
  const cache = createFilePrefetch({ api: source.api, projectId: "fixture" });
  try {
    await cache.read("first.ts");
    await cache.read("second.ts");
    await cache.read("third.ts");
    await cache.read("third.ts");
    expect(source.reads).toHaveLength(3);
    await cache.read("first.ts");
    expect(source.reads).toHaveLength(4);
  } finally {
    cache.dispose();
  }
});
