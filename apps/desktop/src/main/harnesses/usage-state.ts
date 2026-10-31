import { createHash } from "node:crypto";
import { z } from "zod";
import type { HarnessId } from "../../shared/contracts/desktop";
import type { HarnessUsage } from "../../shared/contracts/harness-usage";
import { parseClaudeAccount, parseClaudeLimit, parseCodexUsage } from "./usage-protocol";

const accountScopes = new Map<string, string>();
const observations = new Map<string, HarnessUsage>();
const key = (harness: HarnessId, cwd: string) => `${harness}:${cwd}`;
/** Account identity is hashed locally solely to invalidate observations after a sign-in change. */
export function scopeUsage(harness: HarnessId, cwd: string, value: unknown) {
  const parsed = z
    .object({
      account: z
        .object({
          email: z.string().nullish(),
          organization: z.string().nullish(),
          workspaceName: z.string().nullish(),
          subscriptionType: z.string().nullish(),
          planType: z.string().nullish(),
          type: z.string().nullish(),
          apiKeySource: z.string().nullish(),
        })
        .nullable(),
    })
    .safeParse(value);
  const id = key(harness, cwd);
  if (!parsed.success) {
    observations.delete(id);
    accountScopes.delete(id);
    return;
  }
  const signature = createHash("sha256").update(JSON.stringify(parsed.data.account)).digest("hex");
  if (accountScopes.get(id) !== signature) observations.delete(id);
  accountScopes.delete(id);
  accountScopes.set(id, signature);
  if (accountScopes.size > 64) accountScopes.delete(accountScopes.keys().next().value!);
}
export function usageScope(harness: HarnessId, cwd: string) {
  return accountScopes.get(key(harness, cwd));
}
export function observedUsage(harness: HarnessId, cwd: string) {
  const value = observations.get(key(harness, cwd));
  return value && Date.now() - Date.parse(value.updatedAt) < 30 * 60_000 ? value : undefined;
}
export function rememberUsage(harness: HarnessId, cwd: string, value: HarnessUsage) {
  const id = key(harness, cwd);
  observations.delete(id);
  observations.set(id, value);
  if (observations.size > 64) observations.delete(observations.keys().next().value!);
}

/** Observe native events without persisting account details into a conversation or sync file. */
export function observeUsage(
  harness: HarnessId,
  cwd: string,
  value: Record<string, unknown>,
  scope?: string,
) {
  // A connection authenticated before an account change cannot replace the new account's data.
  if (scope !== undefined && scope !== usageScope(harness, cwd)) return;
  if (harness === "codex" && value.method === "account/updated") {
    observations.delete(key(harness, cwd));
    return;
  }
  if (harness === "codex" && value.method === "account/rateLimits/updated") {
    const next = parseCodexUsage(value.params);
    if (next.state === "unknown") return;
    const previous = observedUsage(harness, cwd);
    rememberUsage(harness, cwd, {
      ...next,
      account: previous?.account ?? next.account,
      resets: next.resets ?? previous?.resets,
    });
  }
  if (harness === "claude" && value.type === "rate_limit_event") {
    const next = parseClaudeLimit(value);
    if (!next) return;
    const previous = observedUsage(harness, cwd);
    const windows =
      previous?.windows.filter((window) => !next.windows.some((item) => item.id === window.id)) ??
      [];
    rememberUsage(harness, cwd, {
      ...previous,
      ...next,
      windows: [...windows, ...next.windows],
      updatedAt:
        next.windows.length || !previous?.windows.length ? next.updatedAt : previous.updatedAt,
      usagePage: previous?.usagePage ?? "subscription",
      note: "Claude reports limits as you work. Other account limits may also apply.",
    });
  }
}
export function claudeAccountUsage(value: unknown, cwd: string): HarnessUsage {
  scopeUsage("claude", cwd, value);
  const account = parseClaudeAccount(value);
  const previous = observedUsage("claude", cwd);
  const api = account?.billing === "api";
  const result: HarnessUsage = {
    ...(!api ? previous : undefined),
    account,
    windows: !api ? (previous?.windows ?? []) : [],
    state: !api ? (previous?.state ?? "unknown") : "unknown",
    updatedAt: !api && previous ? previous.updatedAt : new Date().toISOString(),
    usagePage: api ? "api" : "subscription",
    note: api
      ? "API usage is managed in your Claude account."
      : (previous?.note ??
        "Live limits appear when Claude reports them. See your Claude account for the full allowance."),
  };
  rememberUsage("claude", cwd, result);
  return result;
}
