import type { ThreadSummary } from "../contracts/desktop";
import { describeHarnessFailure } from "./harness-failure";

export function isLimitedThread(
  thread: Pick<ThreadSummary, "status" | "doneAt" | "parentThreadId" | "error" | "errorKind">,
) {
  if (thread.status !== "failed" || thread.doneAt || thread.parentThreadId) return false;
  const kind = describeHarnessFailure(thread.error ?? "", thread.errorKind).kind;
  return kind === "usage-limit" || kind === "rate-limit" || kind === "billing";
}

export const recoveryPrompt =
  "Continue the unfinished request from where the provider usage or rate limit interrupted it. " +
  "Inspect the current files, completed tool results, and external state before retrying an interrupted action. " +
  "Do not repeat completed actions or assume an interruption rolled back their effects. " +
  "Keep the original scope and permissions. If the request is already complete, report its result.";
