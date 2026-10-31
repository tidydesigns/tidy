import { expect, test } from "bun:test";
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
