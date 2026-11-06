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
  let state: "closed" | "open" = "closed";
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
    expect(status.read().state).toBe("closed");
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
    expect(reopened.read().state).toBe("closed");
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

test("host completion events update both icons immediately and defeat stale in-flight responses", async () => {
  const pending = Promise.withResolvers<"open">();
  let receive:
    | ((event: import("../../../shared/contracts/desktop").DesktopEvent) => void)
    | undefined;
  let subscriptions = 0;
  let calls = 0;
  const status = new PullRequestStatus({
    projectId: "project",
    url,
    initialState: "open",
    api: {
      pullRequestState: () => {
        calls++;
        return pending.promise;
      },
      onEvent: (listener) => {
        subscriptions++;
        receive = listener;
        return () => {
          subscriptions--;
        };
      },
    },
  });
  let notifications = 0;
  const left = status.subscribe(() => notifications++);
  const right = status.subscribe(() => notifications++);
  const refresh = status.refresh();
  receive?.({ type: "pull-request-state", projectId: "other", url, state: "merged" });
  expect(status.read().state).toBe("open");
  receive?.({ type: "pull-request-state", projectId: "project", url, state: "merged" });
  expect(status.read().state).toBe("merged");
  expect(notifications).toBe(2);
  pending.resolve("open");
  await refresh;
  expect(status.read().state).toBe("merged");
  await status.refresh(true);
  expect(calls).toBe(1);
  expect(subscriptions).toBe(1);
  left();
  right();
  expect(subscriptions).toBe(0);
});

test("focus bypasses freshness and a forced refresh burst waits for one trailing request", async () => {
  let calls = 0;
  const gate = Promise.withResolvers<"open">();
  const status = new PullRequestStatus({
    projectId: "project",
    url,
    initialState: "open",
    now: () => 1,
    api: {
      pullRequestState: async (_project, _url, force) => {
        calls++;
        if (calls === 1) return gate.promise;
        expect(force).toBe(true);
        return "merged";
      },
    },
  });
  const original = status.refresh();
  const forced = Array.from({ length: 1000 }, () => status.refresh(true));
  expect(calls).toBe(1);
  gate.resolve("open");
  await original;
  await Promise.all(forced);
  expect(status.read().state).toBe("merged");
  expect(calls).toBe(2);
});

test("canonical URL variants receive scoped broadcasts and invalid destinations stay unchanged", () => {
  const listeners = new Set<
    (event: import("../../../shared/contracts/desktop").DesktopEvent) => void
  >();
  const api = {
    onEvent: (
      listener: (event: import("../../../shared/contracts/desktop").DesktopEvent) => void,
    ) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  const aliases = [
    `${url}/files?diff=split#diff-123`,
    "https://www.github.com/OWNER/REPO/pull/42/commits",
  ];
  const valid = aliases.map(
    (href) => new PullRequestStatus({ api, projectId: "project", url: href, initialState: "open" }),
  );
  const invalid = new PullRequestStatus({
    api,
    projectId: "project",
    url: "https://github.com.example.com/owner/repo/pull/42",
  });
  const stop = [...valid, invalid].map((status) => status.subscribe(() => {}));
  const emit = (projectId: string) => {
    for (const listener of listeners)
      listener({ type: "pull-request-state", projectId, url, state: "closed" });
  };
  emit("another-project");
  expect(valid.map((status) => status.read().state)).toEqual(["open", "open"]);
  emit("project");
  expect(valid.map((status) => status.read().state)).toEqual(["closed", "closed"]);
  expect(invalid.read().state).toBeNull();
  stop.forEach((unsubscribe) => unsubscribe());
  expect(listeners.size).toBe(0);
});

test("distinct PRs share one event stream per API and release it after the last subscriber", () => {
  const streams = new Set<
    (event: import("../../../shared/contracts/desktop").DesktopEvent) => void
  >();
  let opened = 0;
  let closed = 0;
  const api = {
    onEvent(listener: (event: import("../../../shared/contracts/desktop").DesktopEvent) => void) {
      opened++;
      streams.add(listener);
      return () => {
        closed++;
        streams.delete(listener);
      };
    },
  };
  const statuses = Array.from(
    { length: 256 },
    (_, index) =>
      new PullRequestStatus({
        api,
        projectId: "project",
        url: `https://github.com/owner/repo/pull/${index + 1}`,
        initialState: "open",
      }),
  );
  const stops = statuses.map((status) => status.subscribe(() => {}));
  expect(opened).toBe(1);
  expect(streams.size).toBe(1);
  for (const receive of streams)
    receive({ type: "pull-request-state", projectId: "project", url, state: "merged" });
  expect(statuses[41]!.read().state).toBe("merged");
  expect(statuses.filter((status) => status.read().state === "open")).toHaveLength(255);

  // A different host must keep its own subscription and state.
  const other = new PullRequestStatus({ api: { ...api }, projectId: "project", url });
  const stopOther = other.subscribe(() => {});
  expect(opened).toBe(2);
  expect(other.read().state).toBeNull();
  stops.slice(0, -1).forEach((stop) => stop());
  expect(closed).toBe(0);
  stops.at(-1)!();
  expect(closed).toBe(1);
  stopOther();
  expect(closed).toBe(2);
  expect(streams.size).toBe(0);

  const stopAgain = statuses[0]!.subscribe(() => {});
  expect(opened).toBe(3);
  stopAgain();
  expect(closed).toBe(3);
});
