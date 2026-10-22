import { useEffect, useRef, useState } from "react";
import { Button } from "@tidy/ui/button";
import { HarnessIcon } from "@tidy/ui/harness-icon";
import { Icon } from "@tidy/editor/components/ui/icon";
import type { DesktopAPI } from "../../shared/contracts";
import { harnessNames, type HarnessUpdateState } from "../../shared/harness-updates";

const dismissedKey = (id: string) => `tidy:harness-update-dismissed:${id}`;
const noticeKey = (entry: HarnessUpdateState) =>
  `${entry.latestVersion}:${entry.status === "installing" || entry.status === "queued" ? "busy" : entry.status}`;
function dismissedVersion(id: string) {
  try {
    return localStorage.getItem(dismissedKey(id));
  } catch {
    return null;
  }
}

/** A single quiet notice keeps each provider and its progress in the same row. */
export function HarnessUpdateNotices({ api }: { api: DesktopAPI | undefined }) {
  const [entries, setEntries] = useState<HarnessUpdateState[]>([]);
  const [dismissed, setDismissed] = useState<Record<string, string>>({});
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [completed, setCompleted] = useState<Record<string, string>>({});
  const previous = useRef(new Map<string, string>());
  const panel = useRef<HTMLElement | null>(null);
  const progressFocus = useRef<string | null>(null);
  useEffect(() => {
    if (!api) return;
    let active = true;
    let received = false;
    const receive = (value: HarnessUpdateState[]) => {
      if (!active) return;
      for (const entry of value) {
        if (entry.status === "updated" && previous.current.get(entry.id) === "installing")
          setCompleted((current) => ({ ...current, [entry.id]: entry.latestVersion }));
        previous.current.set(entry.id, entry.status);
      }
      setErrors((current) => {
        const next = { ...current };
        for (const entry of value) if (entry.status !== "available") delete next[entry.id];
        return next;
      });
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

  const notices = entries
    .map((entry): HarnessUpdateState =>
      errors[entry.id] ? { ...entry, status: "error", message: errors[entry.id] } : entry,
    )
    .filter((entry) => {
      if (entry.status === "current") return false;
      if (entry.status === "updated" && completed[entry.id] !== entry.latestVersion) return false;
      return (
        dismissed[entry.id] !== noticeKey(entry) &&
        !(entry.status === "available" && dismissedVersion(entry.id) === entry.latestVersion)
      );
    });
  const allComplete = notices.length > 0 && notices.every((entry) => entry.status === "updated");
  useEffect(() => {
    if (!allComplete) return;
    // Keep the batch together until it finishes, then quietly clear its confirmations.
    let timer: ReturnType<typeof setTimeout>;
    const clear = () => {
      if (document.hidden || panel.current?.matches(":hover, :focus-within")) {
        timer = window.setTimeout(clear, 1000);
        return;
      }
      setDismissed((current) => ({
        ...current,
        ...Object.fromEntries(entries.map((entry) => [entry.id, noticeKey(entry)])),
      }));
    };
    timer = window.setTimeout(clear, 5000);
    return () => window.clearTimeout(timer);
  }, [allComplete, entries]);

  if (!notices.length) return null;
  return (
    <section
      ref={panel}
      className="tidy-toast harness-update-notice"
      aria-label="Harness updates"
      data-canvas-control
      onPointerDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <header className="harness-update-header">
        <span>Harness updates</span>
        <Button
          className="harness-update-dismiss"
          aria-label="Dismiss harness updates"
          onClick={() => {
            setDismissed((current) => ({
              ...current,
              ...Object.fromEntries(notices.map((entry) => [entry.id, noticeKey(entry)])),
            }));
            for (const entry of notices) {
              if (entry.status === "available") {
                try {
                  localStorage.setItem(dismissedKey(entry.id), entry.latestVersion);
                } catch {}
              }
            }
          }}
        >
          <Icon name="xmark" size={14} />
        </Button>
      </header>
      <ul className="harness-update-list">
        {notices.map((entry) => {
          const name = harnessNames[entry.id];
          const isPending = Boolean(pending[entry.id]);
          const installing = entry.status === "installing";
          const queued = entry.status === "queued";
          const starting = isPending && !["queued", "installing", "updated"].includes(entry.status);
          const updated = entry.status === "updated";
          const error = entry.status === "error";
          const detail = queued
            ? entry.waitReason === "installer"
              ? "Next in line"
              : "After its active responses"
            : updated
              ? `Version ${entry.installedVersion}`
              : `${entry.installedVersion} → ${entry.latestVersion}`;
          return (
            <li
              key={entry.id}
              className="harness-update-row"
              data-harness={entry.id}
              data-state={entry.status}
            >
              <span className="harness-update-mark">
                <HarnessIcon harness={entry.id} size={21} />
              </span>
              <div className="harness-update-copy" role="status" aria-atomic="true">
                <span className="harness-update-name">{name}</span>
                <span className="harness-update-detail">{detail}</span>
                <span className="sr-only">
                  {starting
                    ? "Starting update"
                    : installing
                      ? "Updating"
                      : queued
                        ? "Queued"
                        : updated
                          ? "Updated"
                          : error
                            ? "Update failed"
                            : "Update available"}
                </span>
              </div>
              {starting || installing || queued || updated ? (
                <span
                  className="harness-update-state"
                  data-complete={updated || undefined}
                  tabIndex={-1}
                  aria-label={`${name}: ${starting ? "Starting" : installing ? "Updating" : updated ? "Updated" : "Queued"}`}
                  ref={(element) => {
                    if (element && progressFocus.current === entry.id) {
                      progressFocus.current = null;
                      element.focus();
                    }
                  }}
                >
                  {starting || installing ? (
                    <span className="harness-update-spinner" aria-hidden="true" />
                  ) : updated ? (
                    <Icon name="check" size={14} />
                  ) : null}
                  {starting ? "Starting" : installing ? "Updating" : updated ? "Updated" : "Queued"}
                </span>
              ) : entry.canInstall ? (
                <Button
                  className="harness-update-install"
                  aria-label={`${error ? "Retry updating" : "Update"} ${name}`}
                  onClick={(event) => {
                    if (!api || pending[entry.id]) return;
                    if (event.currentTarget === document.activeElement)
                      progressFocus.current = entry.id;
                    setPending((current) => ({ ...current, [entry.id]: true }));
                    setErrors((current) => ({ ...current, [entry.id]: "" }));
                    setDismissed((current) => ({ ...current, [entry.id]: "" }));
                    try {
                      localStorage.removeItem(dismissedKey(entry.id));
                    } catch {}
                    void api
                      .installHarnessUpdate(entry.id)
                      .catch(() => {
                        setErrors((current) => ({
                          ...current,
                          [entry.id]: "Couldn’t start the update. Try again.",
                        }));
                      })
                      .finally(() => setPending((current) => ({ ...current, [entry.id]: false })));
                  }}
                >
                  {error ? "Retry" : "Update"}
                </Button>
              ) : null}
              {error || !entry.canInstall ? (
                <p className="harness-update-error" role={error ? "alert" : undefined}>
                  {entry.message ?? "Use your package manager to update."}
                </p>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
