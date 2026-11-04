import { expect, test } from "bun:test";
import {
  defaultWorktreePreferences,
  type WorktreePreferences,
  type WorktreeStorage,
} from "../../../../shared/contracts/worktree-settings";
import type { DesktopAPI } from "../../../../shared/contracts/desktop";

async function moduleFor(name: string, api: Partial<DesktopAPI>) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: { tidy: api } });
  const store = (await import(
    new URL(`./worktree-preferences.ts?${name}`, import.meta.url).href
  )) as typeof import("./worktree-preferences");
  return {
    store,
    restore() {
      if (previous) Object.defineProperty(globalThis, "window", previous);
      else Reflect.deleteProperty(globalThis, "window");
    },
  };
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

test("rapid preference edits stay optimistic and serialize persistence without reverting newer choices", async () => {
  const first = Promise.withResolvers<WorktreePreferences>();
  const writes: WorktreePreferences[] = [];
  const f = await moduleFor("ordered-writes", {
    worktreePreferences: async () => defaultWorktreePreferences,
    setWorktreePreferences: (preferences) => {
      writes.push(preferences);
      return writes.length === 1 ? first.promise : Promise.resolve(preferences);
    },
  });
  try {
    await f.store.loadWorktreePreferences();
    f.store.changeWorktreePreferences({ naming: "prompt" });
    f.store.changeWorktreePreferences({ branchPrefix: "fix/" });
    expect(f.store.currentWorktreePreferences().preferences.branchPrefix).toBe("fix/");
    await tick();
    expect(writes).toHaveLength(1);
    first.reject(new Error("Fixture write failed"));
    await tick();
    expect(writes).toHaveLength(2);
    expect(writes[1]).toMatchObject({ naming: "prompt", branchPrefix: "fix/" });
    expect(f.store.currentWorktreePreferences().preferences).toEqual(writes[1]);
  } finally {
    f.restore();
  }
});

test("consecutive failed edits return to the last persisted preferences", async () => {
  const f = await moduleFor("failed-writes", {
    worktreePreferences: async () => defaultWorktreePreferences,
    setWorktreePreferences: async () => {
      throw new Error("Fixture unavailable");
    },
  });
  try {
    await f.store.loadWorktreePreferences();
    f.store.changeWorktreePreferences({ naming: "prompt" });
    f.store.changeWorktreePreferences({ branchPrefix: "fix/" });
    await tick();
    expect(f.store.currentWorktreePreferences().preferences).toEqual(defaultWorktreePreferences);
  } finally {
    f.restore();
  }
});

test("a stale inventory refresh cannot resurrect a removed worktree", async () => {
  const scan = Promise.withResolvers<WorktreeStorage>();
  const entry = {
    id: "0a496b5e-c43d-46d1-a3bd-b34879fe279c",
    projectId: "7cb6cd47-784c-4bae-95a6-f22fc61b5756",
    projectName: "Fixture",
    title: "Fixture work",
    branch: "feat/fixture",
    path: "/fixture/worktree",
    bytes: 100,
    busy: false,
    hasChanges: false,
  };
  let scans = 0;
  const f = await moduleFor("inventory-removal", {
    worktreeStorage: async () =>
      ++scans === 1 ? { preferences: defaultWorktreePreferences, entries: [entry] } : scan.promise,
    removeWorktree: async () => {},
  });
  try {
    await f.store.refreshWorktreeStorage();
    const stale = f.store.refreshWorktreeStorage();
    await f.store.removeStoredWorktree(entry);
    expect(f.store.currentWorktreeStorage().entries).toHaveLength(0);
    scan.resolve({ preferences: defaultWorktreePreferences, entries: [entry] });
    await stale;
    expect(f.store.currentWorktreeStorage().entries).toHaveLength(0);
  } finally {
    f.restore();
  }
});
