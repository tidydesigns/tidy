import { expect, test } from "bun:test";
import { harnessUsageSchema } from "../../shared/contracts/harness-usage";
import {
  parseClaudeAccount,
  parseClaudeLimit,
  parseCodexUsage,
  parseOpenCodeUsage,
} from "./usage-protocol";
import { claudeAccountUsage, observeUsage, observedUsage, usageScope } from "./usage-state";
import { readCodexUsage } from "./harness-usage";

const window = { usedPercent: 40, windowDurationMins: 300, resetsAt: 2_000_000_000 };
const account = {
  account: {
    type: "chatgpt",
    planType: "plus",
    email: "private@example.invalid",
    secret: "do-not-expose",
    workspaceName: "Design studio",
  },
};
test("Codex keeps independent buckets, authoritative reset counts and optional detail rows", () => {
  const value = parseCodexUsage(
    {
      rateLimits: {
        primary: window,
        credits: { hasCredits: true, unlimited: false, balance: "120.5" },
      },
      rateLimitsByLimitId: {
        codex: {
          primary: window,
          secondary: { ...window, usedPercent: 93, windowDurationMins: 10080 },
        },
        other: { limitName: "Separate allowance", primary: { ...window, windowDurationMins: 60 } },
      },
      rateLimitResetCredits: {
        availableCount: 8,
        credits: [{ id: "reset", title: null, expiresAt: null, secret: "do-not-expose" }],
      },
    },
    account,
  );
  expect(harnessUsageSchema.parse(value)).toEqual(value);
  expect(value.account).toEqual({
    plan: "plus",
    workspace: "Design studio",
    billing: "subscription",
  });
  expect(value.windows).toHaveLength(3);
  expect(value.windows[1].name).toBe("Weekly limit");
  expect(value.resets?.availableCount).toBe(8);
  expect(value.resets?.items).toHaveLength(1);
  expect(value.resets?.items?.[0].expiresAt).toBeNull();
  expect(value.credits?.balance).toBe("120.5");
  expect(value.state).toBe("warning");
  expect(JSON.stringify(value)).not.toContain("private@example");
  expect(JSON.stringify(value)).not.toContain("do-not-expose");
});
test("unknown Codex limits, credits and reset details are never fabricated as zero or unlimited", () => {
  const value = parseCodexUsage(undefined, { account: { type: "apiKey" } });
  expect(value.windows).toEqual([]);
  expect(value.resets).toBeUndefined();
  expect(value.credits).toBeUndefined();
  expect(value.usagePage).toBe("api");
  expect(value.state).toBe("unknown");
  expect(
    parseCodexUsage({ rateLimits: {}, rateLimitResetCredits: { availableCount: 3, credits: null } })
      .resets,
  ).toEqual({ availableCount: 3, items: undefined });
  expect(
    parseCodexUsage({
      ordinaryUsageAllowed: false,
      rateLimits: { primary: { ...window, usedPercent: 0 } },
    }).state,
  ).toBe("limited");
  expect(
    parseCodexUsage({ rateLimits: { primary: { ...window, resetsAt: 1e100 } } }).windows,
  ).toEqual([]);
});
test("Claude preserves plan metadata and reports precisely the window it supplies", () => {
  expect(
    parseClaudeAccount({
      account: {
        subscriptionType: "max",
        email: "private@example.invalid",
        organization: "Studio",
        tokenSource: "oauth",
      },
    }),
  ).toEqual({ plan: "max", workspace: "Studio", billing: "subscription" });
  const value = parseClaudeLimit({
    type: "rate_limit_event",
    rate_limit_info: { status: "allowed_warning", utilization: 0.92, resetsAt: window.resetsAt },
  });
  expect(value?.windows[0]).toMatchObject({ name: "Reported limit", usedPercent: 92 });
  expect(value?.windows[0].windowMinutes).toBeUndefined();
  expect(value?.state).toBe("warning");
  expect(
    parseClaudeLimit({
      type: "rate_limit_event",
      rate_limit_info: { status: "allowed", utilization: 92 },
    }),
  ).toBeUndefined();
});
test("Claude observations stay local to their workspace and clear when the authenticated account changes", () => {
  const cwd = `/synthetic/${crypto.randomUUID()}`;
  const init = {
    account: { email: "a@example.invalid", subscriptionType: "max", tokenSource: "oauth" },
  };
  claudeAccountUsage(init, cwd);
  observeUsage("claude", cwd, {
    type: "rate_limit_event",
    rate_limit_info: { status: "rejected", utilization: 1, resetsAt: window.resetsAt },
  });
  expect(claudeAccountUsage(init, cwd).windows[0].usedPercent).toBe(100);
  expect(observedUsage("claude", cwd + "/other")).toBeUndefined();
  expect(
    claudeAccountUsage({ account: { ...init.account, email: "b@example.invalid" } }, cwd).windows,
  ).toEqual([]);
});
test("usage reads preserve last-known Codex figures after a transient failure without breaking model discovery", async () => {
  const cwd = `/synthetic/${crypto.randomUUID()}`;
  const request = async (method: string) =>
    method === "account/read" ? account : { rateLimits: { primary: window } };
  await readCodexUsage(request, cwd);
  const failing = async (method: string) => {
    if (method === "account/read") return account;
    throw new Error("offline");
  };
  await expect(readCodexUsage(failing, cwd)).rejects.toThrow("refresh");
  expect((await readCodexUsage(failing, cwd, true)).windows[0].usedPercent).toBe(40);
});
test("OpenCode converts millisecond resets, separates shared budgets and avoids inventing a Go tier", () => {
  const meter = { percent: 30, limited: false, resetsAt: 2_000_000_000_000 };
  const value = parseOpenCodeUsage({
    workspace: { name: "Studio" },
    go: { rolling: meter, weekly: { ...meter, percent: 95 }, monthly: meter },
    budgets: [{ id: "budget", limit: 20, spent: 5, resetsAt: meter.resetsAt, shared: true }],
  });
  expect(harnessUsageSchema.parse(value)).toEqual(value);
  expect(value.windows).toHaveLength(4);
  expect(value.windows[0].resetsAt).toBe(2_000_000_000);
  expect(value.windows[3]).toMatchObject({
    name: "Shared budget",
    usedPercent: 25,
    spentUSD: 5,
    limitUSD: 20,
  });
  expect(value.account?.plan).toBe("OpenCode Go");
  expect(value.state).toBe("warning");
  expect(() => parseOpenCodeUsage({})).toThrow("supported usage");
});

test("late observations from an older authenticated connection cannot restore another account's usage", () => {
  const cwd = `/synthetic/${crypto.randomUUID()}`;
  const init = (email: string) => ({
    account: { email, subscriptionType: "max", tokenSource: "oauth" },
  });
  claudeAccountUsage(init("first@example.invalid"), cwd);
  const oldScope = usageScope("claude", cwd)!;
  claudeAccountUsage(init("second@example.invalid"), cwd);
  observeUsage(
    "claude",
    cwd,
    { type: "rate_limit_event", rate_limit_info: { status: "rejected", utilization: 1 } },
    oldScope,
  );
  expect(observedUsage("claude", cwd)?.windows).toEqual([]);
  observeUsage(
    "claude",
    cwd,
    { type: "rate_limit_event", rate_limit_info: { status: "allowed", utilization: 0.2 } },
    usageScope("claude", cwd),
  );
  expect(observedUsage("claude", cwd)?.windows[0].usedPercent).toBe(20);
});
test("unknown Claude limit categories stay bounded and status-only events don't re-date old percentages", () => {
  const cwd = `/synthetic/${crypto.randomUUID()}`;
  for (let i = 0; i < 120; i++)
    observeUsage("claude", cwd, {
      type: "rate_limit_event",
      rate_limit_info: { status: "allowed", utilization: 0.3, rateLimitType: `unknown-${i}` },
    });
  const previous = observedUsage("claude", cwd)!;
  expect(previous.windows).toHaveLength(1);
  expect(harnessUsageSchema.safeParse(previous).success).toBe(true);
  observeUsage("claude", cwd, { type: "rate_limit_event", rate_limit_info: { status: "allowed" } });
  expect(observedUsage("claude", cwd)?.updatedAt).toBe(previous.updatedAt);
});
