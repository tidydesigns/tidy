import { useState } from "react";
import { Button } from "@tidy/ui/button";
import type { CloudAPI, CloudState } from "../../shared/cloud-sync";

export function SyncStatus({
  api,
  state,
  projectId,
  designId,
  onKeepBoth,
}: {
  api?: CloudAPI;
  state?: CloudState;
  projectId: string;
  designId: string;
  onKeepBoth?: () => Promise<void>;
}) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const binding = state?.bindings.find((b) => b.projectId === projectId && b.designId === designId);
  const label = !binding
    ? "On this computer"
    : binding.status === "synced"
      ? "Synced"
      : binding.status === "syncing"
        ? "Syncing…"
        : binding.status === "offline"
          ? "Offline · saved locally"
          : binding.status === "conflict"
            ? "Conflicting edits"
            : "Sync paused";
  return (
    <details className="sync-status" data-canvas-control>
      <summary>
        <span className={`sync-dot sync-${binding?.status ?? "local"}`} />
        {label}
      </summary>
      <div className="sync-details">
        <p>
          {!binding
            ? "This design is stored on this computer."
            : binding.status === "synced"
              ? "Changes are synced. This design is available offline."
              : binding.status === "syncing"
                ? "Changes are saved locally and syncing in the background."
                : binding.status === "offline"
                  ? "Your changes are safe on this computer. Sync resumes automatically when you reconnect."
                  : binding.status === "conflict"
                    ? "Both copies changed. Your local edits are safe; automatic sync is paused."
                    : "Your local changes are safe. Sign in again to reconnect, or check your workspace access."}
        </p>
        {binding?.status === "paused" && (
          <Button
            className="quiet-button"
            onClick={() =>
              void api?.signIn().catch(() => setError("Could not reconnect. Try again."))
            }
          >
            Reconnect
          </Button>
        )}
        {binding?.status === "conflict" && onKeepBoth && (
          <Button
            className="quiet-button"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              setError("");
              void onKeepBoth()
                .catch(() =>
                  setError(
                    "Could not keep both copies. Your local edits are safe; try again when online.",
                  ),
                )
                .finally(() => setBusy(false));
            }}
          >
            {busy ? "Keeping both…" : "Keep both copies"}
          </Button>
        )}
        {binding?.message && binding.status === "paused" && <p>{binding.message}</p>}
        {error && <p role="alert">{error}</p>}
      </div>
    </details>
  );
}
