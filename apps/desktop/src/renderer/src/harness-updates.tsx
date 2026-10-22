import { useEffect, useRef, useState } from "react";
import { Button } from "@tidy/ui/button";
import { Toast, showToast } from "@tidy/ui/toast";
import type { DesktopAPI } from "../../shared/contracts";
import { harnessNames, type HarnessUpdateState } from "../../shared/harness-updates";

const dismissedKey = (id: string) => `tidy:harness-update-dismissed:${id}`;
function dismissedVersion(id: string) {
  try {
    return localStorage.getItem(dismissedKey(id));
  } catch {
    return null;
  }
}

/** Persistent actionable notices share the app's bottom-right notification viewport. */
export function HarnessUpdateNotices({ api }: { api: DesktopAPI | undefined }) {
  const [entries, setEntries] = useState<HarnessUpdateState[]>([]);
  const [dismissed, setDismissed] = useState<Record<string, string>>({});
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const previous = useRef(new Map<string, string>());
  useEffect(() => {
    if (!api) return;
    let active = true;
    let received = false;
    const receive = (value: HarnessUpdateState[]) => {
      if (!active) return;
      for (const entry of value) {
        if (entry.status === "updated" && previous.current.get(entry.id) === "installing")
          showToast(`${harnessNames[entry.id]} updated to ${entry.installedVersion}.`, "success");
        previous.current.set(entry.id, entry.status);
      }
      setEntries(value);
    };
    const unsubscribe = api.onHarnessUpdates((value) => {
      received = true;
      receive(value);
    });
    void api
      .harnessUpdates()
      .then((value) => {
        if (!received) receive(value);
      })
      .catch(() => {});
    return () => {
      active = false;
      unsubscribe();
    };
  }, [api]);

  return entries.map((entry) => {
    const busy = ["queued", "installing"].includes(entry.status);
    if (["current", "updated"].includes(entry.status)) return null;
    const dismissal = `${entry.latestVersion}:${busy ? "busy" : entry.status}`;
    if (
      dismissed[entry.id] === dismissal ||
      (entry.status === "available" && dismissedVersion(entry.id) === entry.latestVersion)
    )
      return null;
    const name = harnessNames[entry.id];
    const message =
      entry.status === "error"
        ? (entry.message ?? `Couldn’t update ${name}.`)
        : entry.status === "queued"
          ? `${name} will update when its active Tidy runs finish.`
          : entry.status === "installing"
            ? `Updating ${name} to ${entry.latestVersion}…`
            : `${name} ${entry.latestVersion} is available. You have ${entry.installedVersion}.`;
    return (
      <Toast
        key={entry.id}
        message={message}
        tone={entry.status === "error" ? "error" : "info"}
        onDismiss={() => {
          // Dismissing progress hides the notice, not the explicitly requested installation.
          setDismissed((current) => ({ ...current, [entry.id]: dismissal }));
          if (entry.status === "available") {
            try {
              localStorage.setItem(dismissedKey(entry.id), entry.latestVersion);
            } catch {}
          }
        }}
      >
        <div className="harness-update-actions">
          {entry.canInstall ? (
            <Button
              className="harness-update-install"
              disabled={busy || pending[entry.id]}
              aria-label={`${entry.status === "error" ? "Retry updating" : "Update"} ${name}`}
              aria-busy={busy || Boolean(pending[entry.id])}
              onClick={() => {
                if (!api || busy || pending[entry.id]) return;
                setPending((current) => ({ ...current, [entry.id]: true }));
                // Clear a previous dismissal so an error or a queued install stays visible.
                setDismissed((current) => ({ ...current, [entry.id]: "" }));
                try {
                  localStorage.removeItem(dismissedKey(entry.id));
                } catch {}
                void api
                  .installHarnessUpdate(entry.id)
                  .catch(() => {
                    showToast(`Couldn’t start the ${name} update. Try again.`);
                  })
                  .finally(() => setPending((current) => ({ ...current, [entry.id]: false })));
              }}
            >
              {entry.status === "queued"
                ? "Waiting for idle…"
                : busy
                  ? "Installing…"
                  : entry.status === "error"
                    ? "Retry"
                    : "Update"}
            </Button>
          ) : (
            <span>{entry.message}</span>
          )}
        </div>
      </Toast>
    );
  });
}
