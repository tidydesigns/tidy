import type { Thread } from "../../../../shared/contracts/desktop";

export function ThreadRecoveryNotice({ recovery }: { recovery: Thread["recovery"] }) {
  if (!recovery) return null;
  const time = recovery.retryAt
    ? new Date(recovery.retryAt).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      })
    : undefined;
  return (
    <p className="thread-activity text-xs wrap-anywhere" role="status">
      {time
        ? `Tidy paused this thread${recovery.reason === "provider" ? " while the provider is unavailable" : " during recovery"}. Retrying automatically after ${time}.`
        : recovery.reason === "provider"
          ? "Retrying this thread after a provider interruption…"
          : `Tidy paused this thread for ${recovery.reason === "update" ? "an update" : "a restart"}. Resuming…`}
    </p>
  );
}
