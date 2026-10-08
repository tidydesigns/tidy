import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { AuthGuardStore, type RateRule } from "../auth/guard-store";
import { consumePersonalAttempts, PERSONAL_ATTEMPTS } from "./personal-budget";
import { consumeLinearAttempts } from "../linear/attempt-budget";
import { consumeGitHubOAuthAttempts, GitHubOAuthBudgetError } from "../github/oauth-budget";
import { consumeFileManagementBudget } from "../design/file-management-budget";
import { consumeClipboardBudget } from "../design/clipboard-budget";
import { consumeImageBudget } from "../design/image-budget";
import { consumeFeedbackBudget } from "../feedback/upload-budget";
import {
  consumeCommentBudget,
  consumeInvitationBudget,
  MutationBudgetError,
} from "./mutation-budget";
const databases: Database[] = [];
test("GitHub OAuth hourly budgets share account and workspace counters across minute resets", async () => {
  const actor = limiter();
  const consumeActor = (scope: string, key: string, rule: RateRule) =>
    actor.consume(`${scope}:${key}`, rule);
  for (let minute = 0; minute < 10; minute++) {
    for (let n = 0; n < 10; n++)
      await consumeGitHubOAuthAttempts("one", `workspace-${minute}-${n}`, consumeActor);
    actor.advance(60_001);
  }
  await expect(consumeGitHubOAuthAttempts("one", "new", consumeActor)).rejects.toBeInstanceOf(
    GitHubOAuthBudgetError,
  );
  await consumeGitHubOAuthAttempts("other", "new", consumeActor);
  actor.advance(3_600_001);
  await consumeGitHubOAuthAttempts("one", "new", consumeActor);
  const workspace = limiter();
  const consumeWorkspace = (scope: string, key: string, rule: RateRule) =>
    workspace.consume(`${scope}:${key}`, rule);
  for (let minute = 0; minute < 10; minute++) {
    for (let n = 0; n < 30; n++)
      await consumeGitHubOAuthAttempts(`user-${minute}-${n}`, "shared", consumeWorkspace);
    workspace.advance(60_001);
  }
  await expect(
    consumeGitHubOAuthAttempts("new", "shared", consumeWorkspace),
  ).rejects.toBeInstanceOf(GitHubOAuthBudgetError);
  await consumeGitHubOAuthAttempts("new", "other", consumeWorkspace);
});
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});
function limiter() {
  let now = 0;
  const db = new Database(":memory:");
  databases.push(db);
  const store = new AuthGuardStore({
    exec(query: string, ...bindings: (string | number | null)[]) {
      const rows = db.prepare(query).all(...bindings);
      return { toArray: () => rows };
    },
  } as unknown as SqlStorage);
  return {
    advance: (ms: number) => {
      now += ms;
    },
    consume: async (key: string, rule: RateRule) => store.consume(key, rule, now),
  };
}

test("feedback hourly ceilings survive minute resets for one account and across accounts", async () => {
  const actorGuard = limiter();
  const actorConsume = (scope: string, key: string, rule: RateRule) =>
    actorGuard.consume(`${scope}:${key}`, rule);
  for (let minute = 0; minute < 8; minute++) {
    for (let count = 0; count < 5; count++) await consumeFeedbackBudget("one", actorConsume);
    actorGuard.advance(60_001);
  }
  await expect(consumeFeedbackBudget("one", actorConsume)).rejects.toBeInstanceOf(
    MutationBudgetError,
  );
  await consumeFeedbackBudget("two", actorConsume);
  const globalGuard = limiter();
  const globalConsume = (scope: string, key: string, rule: RateRule) =>
    globalGuard.consume(`${scope}:${key}`, rule);
  for (let count = 0; count < 200; count++) {
    await consumeFeedbackBudget(`account-${count}`, globalConsume);
    if (count % 30 === 29) globalGuard.advance(60_001);
  }
  await expect(consumeFeedbackBudget("fresh-account", globalConsume)).rejects.toBeInstanceOf(
    MutationBudgetError,
  );
  globalGuard.advance(3_600_001);
  await consumeFeedbackBudget("fresh-account", globalConsume);
});

test("comment attempts share atomic actor budgets across files and action kinds", async () => {
  const guard = limiter();
  const attempts = await Promise.allSettled(
    Array.from({ length: 80 }, () => consumeCommentBudget("actor", guard.consume)),
  );
  expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(60);
  expect(
    attempts
      .filter((attempt) => attempt.status === "rejected")
      .every((attempt) => (attempt as PromiseRejectedResult).reason instanceof MutationBudgetError),
  ).toBe(true);
  guard.advance(60_001);
  await consumeCommentBudget("actor", guard.consume);
});

test("multiple actors share the organization ceiling", async () => {
  const guard = limiter();
  const attempts = await Promise.allSettled(
    Array.from({ length: 320 }, (_, index) =>
      consumeCommentBudget(`actor-${index}`, guard.consume),
    ),
  );
  expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(300);
});

test("hourly actor allowance survives minute-window resets and guard errors fail closed", async () => {
  const guard = limiter();
  for (let minute = 0; minute < 10; minute++) {
    for (let count = 0; count < 60; count++) await consumeCommentBudget("actor", guard.consume);
    guard.advance(60_001);
  }
  await expect(consumeCommentBudget("actor", guard.consume)).rejects.toBeInstanceOf(
    MutationBudgetError,
  );
  await expect(
    consumeCommentBudget("actor", async () => {
      throw new Error("guard unavailable");
    }),
  ).rejects.toThrow("guard unavailable");
});

test("invitation budgets bound one inviter and the shared workspace independently of comments", async () => {
  const guard = limiter();
  const attempts = await Promise.allSettled(
    Array.from({ length: 20 }, () => consumeInvitationBudget("actor", guard.consume)),
  );
  expect(attempts.filter((result) => result.status === "fulfilled")).toHaveLength(10);
  const others = await Promise.allSettled(
    Array.from({ length: 25 }, (_, index) =>
      consumeInvitationBudget(`other-${index}`, guard.consume),
    ),
  );
  expect(others.filter((result) => result.status === "fulfilled")).toHaveLength(20);
  await consumeCommentBudget("actor", guard.consume);
  await expect(
    consumeInvitationBudget("actor", async () => {
      throw new Error("guard unavailable");
    }),
  ).rejects.toThrow("guard unavailable");
});

test("OAuth registration shares a global attempt budget and fails closed", async () => {
  const { consumeRegistrationBudget } = await import("../auth/client-registration-budget");
  const guard = limiter();
  const attempts = await Promise.allSettled(
    Array.from({ length: 80 }, () => consumeRegistrationBudget(guard.consume)),
  );
  expect(attempts.filter((result) => result.status === "fulfilled")).toHaveLength(60);
  guard.advance(60_001);
  await consumeRegistrationBudget(guard.consume);
  await expect(
    consumeRegistrationBudget(async () => {
      throw new Error("guard unavailable");
    }),
  ).rejects.toThrow("guard unavailable");
});

test("clipboard attempts share account ceilings across destination workspaces", async () => {
  const guard = limiter();
  const consume = (scope: string, key: string, rule: RateRule) =>
    guard.consume(`${scope}:${key}`, rule);
  const results = await Promise.allSettled(
    Array.from({ length: 20 }, (_, index) =>
      consumeClipboardBudget("same-actor", `org-${index}`, consume),
    ),
  );
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(10);
  expect(
    results
      .filter((r) => r.status === "rejected")
      .every((r) => (r as PromiseRejectedResult).reason instanceof MutationBudgetError),
  ).toBe(true);
  guard.advance(60_001);
  await consumeClipboardBudget("same-actor", "another", consume);
});

test("clipboard hourly account and workspace limits survive minute resets", async () => {
  const actor = limiter();
  const consume = (scope: string, key: string, rule: RateRule) =>
    actor.consume(`${scope}:${key}`, rule);
  for (let minute = 0; minute < 6; minute++) {
    for (let count = 0; count < 10; count++)
      await consumeClipboardBudget("same", `org-${minute}`, consume);
    actor.advance(60_001);
  }
  await expect(consumeClipboardBudget("same", "fresh-org", consume)).rejects.toBeInstanceOf(
    MutationBudgetError,
  );
  await consumeClipboardBudget("other", "fresh-org", consume);
  const workspace = limiter();
  const shared = (scope: string, key: string, rule: RateRule) =>
    workspace.consume(`${scope}:${key}`, rule);
  for (let minute = 0; minute < 10; minute++) {
    for (let count = 0; count < 30; count++)
      await consumeClipboardBudget(`actor-${minute}-${count}`, "shared", shared);
    workspace.advance(60_001);
  }
  await expect(consumeClipboardBudget("new-actor", "shared", shared)).rejects.toBeInstanceOf(
    MutationBudgetError,
  );
  await consumeClipboardBudget("new-actor", "separate", shared);
  workspace.advance(3_600_001);
  await consumeClipboardBudget("new-actor", "shared", shared);
});

for (const kind of ["thumbnail", "read"] as const) {
  test(`${kind} account attempts span workspaces and hourly windows`, async () => {
    const guard = limiter(),
      consume = (scope: string, key: string, rule: RateRule) =>
        guard.consume(`${scope}:${key}`, rule);
    const perMinute = kind === "thumbnail" ? 60 : 240,
      hourly = kind === "thumbnail" ? 1000 : 6000;
    for (let count = 0; count < hourly; count++) {
      if (count && count % perMinute === 0) guard.advance(60_001);
      await consumeImageBudget(kind, "one", `workspace-${Math.floor(count / perMinute)}`, consume);
    }
    guard.advance(60_001);
    await expect(consumeImageBudget(kind, "one", "fresh", consume)).rejects.toBeInstanceOf(
      MutationBudgetError,
    );
    await consumeImageBudget(kind, "two", "fresh", consume);
    // Read and publication budgets do not consume each other's account capacity.
    await consumeImageBudget(kind === "read" ? "thumbnail" : "read", "one", "fresh", consume);
    guard.advance(3_600_001);
    await consumeImageBudget(kind, "one", "fresh", consume);
  });
  test(`${kind} workspace hourly attempts span actors and expire`, async () => {
    const guard = limiter(),
      consume = (scope: string, key: string, rule: RateRule) =>
        guard.consume(`${scope}:${key}`, rule);
    const perMinute = kind === "thumbnail" ? 300 : 1200,
      hourly = kind === "thumbnail" ? 5000 : 30000;
    for (let count = 0; count < hourly; count++) {
      if (count && count % perMinute === 0) guard.advance(60_001);
      await consumeImageBudget(kind, `actor-${count % 10}`, "shared", consume);
    }
    guard.advance(60_001);
    await expect(consumeImageBudget(kind, "fresh-actor", "shared", consume)).rejects.toBeInstanceOf(
      MutationBudgetError,
    );
    await consumeImageBudget(kind, "fresh-actor", "other", consume);
    guard.advance(3_600_001);
    await consumeImageBudget(kind, "fresh-actor", "shared", consume);
  });
}

test("file management hourly attempts span organizations, actors and operation kinds; expiry releases rate capacity", async () => {
  const account = limiter(),
    workspace = limiter();
  const accountConsume = (scope: string, key: string, rule: RateRule) =>
    account.consume(`${scope}:${key}`, rule);
  const workspaceConsume = (scope: string, key: string, rule: RateRule) =>
    workspace.consume(`${scope}:${key}`, rule);
  for (let minute = 0; minute < 10; minute++) {
    for (let index = 0; index < 20; index++)
      await consumeFileManagementBudget("actor", `org-${minute}`, accountConsume);
    account.advance(60_001);
  }
  await expect(
    consumeFileManagementBudget("actor", "fresh", accountConsume),
  ).rejects.toBeInstanceOf(MutationBudgetError);
  await consumeFileManagementBudget("another", "fresh", accountConsume);
  for (let minute = 0; minute < 10; minute++) {
    for (let index = 0; index < 100; index++)
      await consumeFileManagementBudget(`actor-${index}`, "shared", workspaceConsume);
    workspace.advance(60_001);
  }
  await expect(
    consumeFileManagementBudget("fresh", "shared", workspaceConsume),
  ).rejects.toBeInstanceOf(MutationBudgetError);
  account.advance(3_600_001);
  workspace.advance(3_600_001);
  await consumeFileManagementBudget("actor", "fresh", accountConsume);
  await consumeFileManagementBudget("fresh", "shared", workspaceConsume);
});

for (const kind of ["read", "write", "oauth"] as const)
  test(`Linear ${kind} ceilings persist across minute resets and across actors`, async () => {
    const { LINEAR_LIMITS } = await import("./resource-limits");
    const limits = LINEAR_LIMITS.attempts[kind],
      guard = limiter();
    const consume = (scope: string, key: string, rule: RateRule) =>
      guard.consume(`${scope}:${key}`, rule);
    for (let i = 0; i < limits.accountHour; i++) {
      if (i > 0 && i % limits.accountMinute === 0) guard.advance(60_001);
      await consumeLinearAttempts(kind, "actor", "org", consume);
    }
    guard.advance(60_001);
    await expect(
      consumeLinearAttempts(kind, "actor", "different-org", consume),
    ).rejects.toMatchObject({ status: 429 });
    const shared = limiter(),
      sharedConsume = (scope: string, key: string, rule: RateRule) =>
        shared.consume(`${scope}:${key}`, rule);
    const attempts = await Promise.allSettled(
      Array.from({ length: limits.workspaceMinute + 10 }, (_, i) =>
        consumeLinearAttempts(kind, `actor${i}`, "org", sharedConsume),
      ),
    );
    expect(attempts.filter((x) => x.status === "fulfilled")).toHaveLength(limits.workspaceMinute);
  });

for (const kind of Object.keys(PERSONAL_ATTEMPTS) as (keyof typeof PERSONAL_ATTEMPTS)[])
  test(`personal ${kind} hourly attempts survive minute resets and isolate actors`, async () => {
    const guard = limiter(),
      limits = PERSONAL_ATTEMPTS[kind];
    const consume = (scope: string, key: string, rule: RateRule) =>
      guard.consume(`${scope}:${key}`, rule);
    for (let n = 0; n < limits.hour; n++) {
      if (n > 0 && n % limits.minute === 0) guard.advance(60_001);
      await consumePersonalAttempts(kind, "actor", consume);
    }
    guard.advance(60_001);
    await expect(consumePersonalAttempts(kind, "actor", consume)).rejects.toMatchObject({
      status: 429,
    });
    await consumePersonalAttempts(kind, "another-actor", consume);
    guard.advance(3_600_001);
    await consumePersonalAttempts(kind, "actor", consume);
  });
