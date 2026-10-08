import { consumeMutationRateLimit } from "@/lib/auth/guard-client";
import type { RateDecision, RateRule } from "@/lib/auth/guard-store";
import { GitHubRequestError } from "./request-error";

export const GITHUB_OAUTH_LIMITS = {
  statesPerUser: 100,
  statesPerUserOrganization: 20,
  accountMinute: 10,
  accountHour: 100,
  workspaceMinute: 30,
  workspaceHour: 300,
} as const;
export class GitHubOAuthBudgetError extends GitHubRequestError {
  constructor(status: 429 | 503) {
    super(
      status === 429
        ? "Too many GitHub sign-in attempts. Try again shortly."
        : "GitHub sign-in is temporarily unavailable. Try again.",
      status,
    );
  }
}
export async function consumeGitHubOAuthAttempts(
  userId: string,
  organizationId: string,
  consume: (scope: string, key: string, rule: RateRule) => Promise<RateDecision>,
) {
  for (const [scope, key, window, max] of [
    [`github-oauth-account:${userId}`, "minute", 60, GITHUB_OAUTH_LIMITS.accountMinute],
    [`github-oauth-account:${userId}`, "hour", 3600, GITHUB_OAUTH_LIMITS.accountHour],
    [`github-oauth-workspace:${organizationId}`, "minute", 60, GITHUB_OAUTH_LIMITS.workspaceMinute],
    [`github-oauth-workspace:${organizationId}`, "hour", 3600, GITHUB_OAUTH_LIMITS.workspaceHour],
  ] as const) {
    if (!(await consume(scope, key, { window, max })).allowed)
      throw new GitHubOAuthBudgetError(429);
  }
}
export async function reserveGitHubOAuthAttempts(userId: string, organizationId: string) {
  if (typeof navigator === "undefined" || navigator.userAgent !== "Cloudflare-Workers") return;
  try {
    await consumeGitHubOAuthAttempts(userId, organizationId, consumeMutationRateLimit);
  } catch (error) {
    if (error instanceof GitHubOAuthBudgetError) throw error;
    throw new GitHubOAuthBudgetError(503);
  }
}
