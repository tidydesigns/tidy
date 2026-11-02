import { expect, test } from "bun:test";
import {
  defaultThreadCompletion as defaults,
  threadCompletionSchema,
  type CompletionPullRequest,
} from "../contracts/thread-completion";
import { threadCanAutoComplete, threadCompletionReason } from "./thread-completion";

const now = Date.parse("2026-11-02T12:00:00Z");
const thread = { updatedAt: "2026-10-01T12:00:00Z" };
const merged: CompletionPullRequest = {
  state: "merged",
  baseBranch: "trunk",
  defaultBranch: "trunk",
  endedAt: "2026-11-01T12:00:00Z",
};
const closed: CompletionPullRequest = { ...merged, state: "closed" };
const reason = (requests: Array<CompletionPullRequest | null>, patch = {}) =>
  threadCompletionReason(thread, { ...defaults, ...patch }, requests, now);

test("default rule uses the repository's actual default branch and requires every linked PR", () => {
  expect(reason([merged])).toBe("merged");
  expect(reason([{ ...merged, baseBranch: "qa" }])).toBeUndefined();
  expect(reason([{ ...merged, defaultBranch: null }])).toBeUndefined();
  expect(reason([merged, null])).toBeUndefined();
  expect(reason([merged, { ...merged, state: "open", endedAt: null }])).toBeUndefined();
  expect(reason([merged, { ...merged, state: "draft", endedAt: null }])).toBeUndefined();
  expect(reason([])).toBeUndefined();
  expect(reason([closed])).toBeUndefined();
});

test("named branches match exactly; any target and any PR are separate choices", () => {
  expect(reason([merged], { target: "named", branches: ["trunk"] })).toBe("merged");
  expect(reason([merged], { target: "named", branches: ["Trunk"] })).toBeUndefined();
  expect(reason([merged], { target: "named", branches: [] })).toBeUndefined();
  expect(reason([{ ...merged, baseBranch: "qa" }], { target: "any" })).toBe("merged");
  expect(reason([null, merged], { pullRequests: "any" })).toBe("merged");
  expect(reason([merged], { merged: false })).toBeUndefined();
});

test("closed PRs are opt-in and can combine with merged PRs", () => {
  expect(reason([closed], { closed: true })).toBe("closed");
  expect(reason([closed, merged], { closed: true })).toBe("merged");
  expect(reason([closed], { merged: false, closed: true })).toBe("closed");
  expect(reason([closed, merged], { merged: false, closed: true })).toBeUndefined();
});

test("inactivity is opt-in and reopening resets its clock and ignores old PR events", () => {
  expect(reason([], { inactiveDays: 30 })).toBe("inactive");
  expect(reason([], { inactiveDays: 90 })).toBeUndefined();
  const reopened = { ...thread, autoDoneAfter: "2026-11-02T11:00:00Z" };
  expect(
    threadCompletionReason(reopened, { ...defaults, inactiveDays: 7 }, [merged], now),
  ).toBeUndefined();
  expect(
    threadCompletionReason(
      reopened,
      defaults,
      [{ ...merged, endedAt: "2026-11-02T11:30:00Z" }],
      now,
    ),
  ).toBe("merged");
  expect(
    threadCompletionReason(thread, defaults, [{ ...merged, endedAt: "invalid" }], now),
  ).toBeUndefined();
  expect(
    threadCompletionReason(
      reopened,
      defaults,
      [merged, { ...merged, endedAt: "2026-11-02T11:30:00Z" }],
      now,
    ),
  ).toBe("merged");
  expect(
    threadCompletionReason(
      reopened,
      { ...defaults, pullRequests: "any" },
      [merged, { ...merged, state: "open", endedAt: null }],
      now,
    ),
  ).toBeUndefined();
});

test("active work, queued messages, approvals, failures, and empty threads stay open", () => {
  const candidate = {
    status: "completed" as const,
    messages: [{ id: "message", role: "user" as const, text: "work" }],
  };
  expect(threadCanAutoComplete(candidate)).toBe(true);
  for (const status of ["running", "failed", "interrupted"] as const)
    expect(threadCanAutoComplete({ ...candidate, status })).toBe(false);
  expect(threadCanAutoComplete({ ...candidate, doneAt: "2026-11-01T00:00:00Z" })).toBe(false);
  expect(threadCanAutoComplete({ ...candidate, messages: [] })).toBe(false);
  expect(
    threadCanAutoComplete({ ...candidate, queuedMessages: [{ id: "queued", text: "Follow up" }] }),
  ).toBe(false);
  expect(
    threadCanAutoComplete({
      ...candidate,
      pendingApprovals: [{ id: "approval", title: "Allow?", choices: ["allow", "deny"] }],
    }),
  ).toBe(false);
  expect(threadCompletionSchema.safeParse({ inactiveDays: -1 }).success).toBe(false);
  expect(threadCompletionSchema.safeParse({ target: "named", branches: ["--help"] }).success).toBe(
    false,
  );
  expect(threadCompletionSchema.safeParse({ unexpected: true }).success).toBe(false);
});
