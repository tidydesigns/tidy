import type { Thread } from "../contracts/desktop";
import type {
  CompletionPullRequest,
  ThreadCompletion,
  ThreadDoneReason,
} from "../contracts/thread-completion";

export function threadCanAutoComplete(
  thread: Pick<Thread, "doneAt" | "status" | "queuedMessages" | "pendingApprovals" | "messages">,
) {
  return (
    !thread.doneAt &&
    ["completed", "idle", "stopped"].includes(thread.status) &&
    !thread.queuedMessages?.length &&
    !thread.pendingApprovals?.length &&
    thread.messages.length > 0
  );
}

export function threadCompletionReason(
  thread: Pick<Thread, "updatedAt" | "autoDoneAfter">,
  preferences: ThreadCompletion,
  requests: Array<CompletionPullRequest | null>,
  now = Date.now(),
): ThreadDoneReason | undefined {
  const cutoff = thread.autoDoneAfter ? Date.parse(thread.autoDoneAfter) : -Infinity;
  const reasons = requests.map((pr): ThreadDoneReason | undefined => {
    if (!pr?.endedAt || !Number.isFinite(Date.parse(pr.endedAt))) return;
    if (pr.state === "closed" && preferences.closed) return "closed";
    if (pr.state !== "merged" || !preferences.merged) return;
    if (
      preferences.target === "any" ||
      (preferences.target === "default" &&
        pr.defaultBranch !== null &&
        pr.baseBranch === pr.defaultBranch) ||
      (preferences.target === "named" && preferences.branches.includes(pr.baseBranch))
    )
      return "merged";
  });
  if (
    reasons.length &&
    requests.some(
      (pr, index) => reasons[index] && pr?.endedAt && Date.parse(pr.endedAt) > cutoff,
    ) &&
    (preferences.pullRequests === "all" ? reasons.every(Boolean) : reasons.some(Boolean))
  )
    return reasons.includes("merged") ? "merged" : "closed";
  const lastActivity = Math.max(Date.parse(thread.updatedAt), cutoff);
  if (preferences.inactiveDays && now - lastActivity >= preferences.inactiveDays * 86_400_000)
    return "inactive";
}
