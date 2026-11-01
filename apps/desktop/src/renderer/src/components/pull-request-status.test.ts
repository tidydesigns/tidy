import { expect, spyOn, test } from "bun:test";
import { PullRequestStatus, pullRequestStatus } from "./pull-request-status";
import type { DesktopAPI } from "../../../shared/contracts/desktop";

const url = "https://github.com/owner/repo/pull/42";

test("sidebar and preview share one lookup and observe the same state changes", async () => {
  let calls = 0;
  const pending = Promise.withResolvers<"open">();
  const api: Pick<DesktopAPI, "pullRequestState"> = {
    pullRequestState: async () => {
      calls++;
      return pending.promise;
    },
  };
  const sidebar = pullRequestStatus({ api, projectId: "project", url });
  const preview = pullRequestStatus({ api, projectId: "project", url });
  expect(preview).toBe(sidebar);
  let observed: ReturnType<typeof preview.read> | undefined;
  const unsubscribe = preview.subscribe(() => {
    observed = preview.read();
  });
  const refresh = sidebar.refresh();
  await preview.refresh();
  expect(calls).toBe(1);
  pending.resolve("open");
  await refresh;
  expect(preview.read()).toEqual({ state: "open", checking: false });
  expect(observed).toEqual(preview.read());
  unsubscribe();
});

test("refreshes adopt remote state changes and keep the last known state on transient failure", async () => {
  let time = 0;
  let calls = 0;
  const status = new PullRequestStatus({
    url,
    projectId: "project",
    now: () => time,
    api: {
      pullRequestState: async () => {
        calls++;
        if (calls === 1) return "draft";
        if (calls === 2) return "merged";
        throw new Error("Offline");
      },
    },
  });
  await status.refresh();
  expect(status.read().state).toBe("draft");
  await status.refresh();
  expect(calls).toBe(1);
  time = 60_001;
  await status.refresh();
  expect(status.read().state).toBe("merged");
  time += 60_001;
  await status.refresh();
  expect(status.read()).toEqual({ state: "merged", checking: false });
});

test("background checks preserve the visible snapshot and only notify on a status change", async () => {
  let time = 0;
  let next = Promise.withResolvers<"open" | "merged">();
  let calls = 0;
  const status = new PullRequestStatus({
    url,
    projectId: "project",
    initialState: "open",
    now: () => time,
    api: {
      pullRequestState: () => {
        calls++;
        return next.promise;
      },
    },
  });
  const initial = status.read();
  let notifications = 0;
  status.subscribe(() => {
    notifications++;
  });
  const refresh = status.refresh();
  await status.refresh();
  expect(calls).toBe(1);
  expect(status.read()).toBe(initial);
  next.resolve("open");
  await refresh;
  expect(status.read()).toBe(initial);
  expect(notifications).toBe(0);

  time = 60_001;
  next = Promise.withResolvers<"open" | "merged">();
  const changed = status.refresh();
  expect(status.read()).toBe(initial);
  next.resolve("merged");
  await changed;
  expect(status.read().state).toBe("merged");
  expect(notifications).toBe(1);
});

test("a new renderer restores known status before refreshing and isolates machines and projects", async () => {
  let saved = "";
  const storage = {
    getItem: () => saved || null,
    setItem: (_key: string, value: string) => {
      saved = value;
    },
  };
  const original = pullRequestStatus({
    api: { pullRequestState: async () => "merged" },
    projectId: "project",
    url,
    storage,
  });
  await original.refresh();
  const api: Pick<DesktopAPI, "pullRequestState"> = { pullRequestState: async () => null };
  const restored = pullRequestStatus({ api, projectId: "project", url, storage: { ...storage } });
  expect(restored.read()).toEqual({ state: "merged", checking: false });
  const visible = restored.read();
  await restored.refresh();
  expect(restored.read()).toBe(visible);
  expect(pullRequestStatus({ api, projectId: "other", url, storage }).read().state).toBeNull();
  expect(
    pullRequestStatus({ api, projectId: "project", url, scope: "remote", storage }).read().state,
  ).toBeNull();
});

test("corrupt or blocked storage does not prevent status lookups", async () => {
  for (const storage of [
    { getItem: () => '{"bad":"data"}', setItem: () => {} },
    {
      getItem: () => {
        throw new Error("Blocked");
      },
      setItem: () => {
        throw new Error("Blocked");
      },
    },
  ]) {
    const status = pullRequestStatus({
      api: { pullRequestState: async () => "open" },
      projectId: "project",
      url,
      storage,
    });
    expect(status.read().state).toBeNull();
    await status.refresh();
    expect(status.read().state).toBe("open");
  }
});

test("persistent status storage retains at most 256 entries", async () => {
  let saved = "";
  const storage = {
    getItem: () => saved || null,
    setItem: (_key: string, value: string) => {
      saved = value;
    },
  };
  const api: Pick<DesktopAPI, "pullRequestState"> = { pullRequestState: async () => "open" };
  for (let number = 1; number <= 260; number++) {
    await pullRequestStatus({
      api,
      projectId: "project",
      url: `https://github.com/owner/repo/pull/${number}`,
      storage,
    }).refresh();
  }
  const entries: unknown = JSON.parse(saved);
  expect(entries).toHaveLength(256);
  expect(entries).not.toContainEqual([
    JSON.stringify(["", "project", "https://github.com/owner/repo/pull/1"]),
    "open",
  ]);
});

test("status persistence retries failed writes and skips unchanged successful results", async () => {
  const clock = spyOn(Date, "now").mockReturnValue(0);
  let saved = "";
  let writes = 0;
  let state: "merged" | "open" = "merged";
  const storage = {
    getItem: () => saved || null,
    setItem: (_key: string, value: string) => {
      writes++;
      if (writes === 1) throw new Error("Storage temporarily unavailable");
      saved = value;
    },
  };
  const status = pullRequestStatus({
    api: { pullRequestState: async () => state },
    projectId: "project",
    url,
    storage,
  });
  try {
    await status.refresh();
    expect(status.read().state).toBe("merged");
    expect(saved).toBe("");
    clock.mockReturnValue(60_001);
    await status.refresh();
    expect(writes).toBe(2);
    const reopened = pullRequestStatus({
      api: { pullRequestState: async () => null },
      projectId: "project",
      url,
      storage: { ...storage },
    });
    expect(reopened.read().state).toBe("merged");
    clock.mockReturnValue(120_002);
    await status.refresh();
    expect(writes).toBe(2);
    state = "open";
    clock.mockReturnValue(180_003);
    await status.refresh();
    expect(writes).toBe(3);
    expect(status.read().state).toBe("open");
  } finally {
    clock.mockRestore();
  }
});
