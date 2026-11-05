import { useEffect, useRef, useState } from "react";
import { Button } from "@tidy/ui/button";
import { HarnessIcon } from "@tidy/ui/harness-icon";
import { Icon } from "@tidy/editor/components/ui/icon";
import type { DesktopAPI } from "../../../../shared/contracts/desktop";
import {
  harnessNames,
  type HarnessUpdateState,
} from "../../../../shared/contracts/harness-updates";

const snoozeDuration = 24 * 60 * 60_000;
const dismissedKey = (id: string) => `tidy:harness-update-snoozed:${id}`;
/** A changed release, installed version or outcome should surface independently. */
const noticeKey = (entry: HarnessUpdateState) =>
  `${entry.installedVersion}:${entry.latestVersion}:${entry.status === "installing" || entry.status === "queued" ? "busy" : entry.status}`;
type Snooze = { key: string; until: number };
type RequestError = { release: string; message: string };
const releaseKey = (entry: HarnessUpdateState) =>
  `${entry.installedVersion}:${entry.latestVersion}`;

/** Ignore old permanent dismissals and malformed/unbounded browser storage. */
export function harnessUpdateSnoozed(
  entry: HarnessUpdateState,
  stored: string | null,
  now: number,
) {
  try {
    const value = JSON.parse(stored ?? "null") as Snooze | null;
    return Boolean(
      value &&
      value.key === noticeKey(entry) &&
      Number.isFinite(value.until) &&
      value.until > now &&
      value.until <= now + snoozeDuration,
    );
  } catch {
    return false;
  }
}

function storedSnooze(id: string) {
  try {
    return localStorage.getItem(dismissedKey(id));
  } catch {
    return null;
  }
}

/** A single quiet notice keeps each provider and its progress in the same row. */
export function HarnessUpdateNotices({
  api,
}: {
  api: Pick<DesktopAPI, "harnessUpdates" | "onHarnessUpdates" | "installHarnessUpdate"> | undefined;
}) {
  const [entries, setEntries] = useState<HarnessUpdateState[]>([]);
  const [dismissed, setDismissed] = useState<Record<string, Snooze>>({});
  const [now, setNow] = useState(Date.now);
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const [errors, setErrors] = useState<Record<string, RequestError>>({});
  const [completed, setCompleted] = useState<Record<string, string>>({});
  const previous = useRef(new Map<string, HarnessUpdateState>());
  const panel = useRef<HTMLElement | null>(null);
  const pendingRequests = useRef(new Set<string>());
  const progressFocus = useRef<string | null>(null);
  useEffect(() => {
    if (!api) return;
    let active = true;
    let revision = 0;
    let loading = false;
    let retry: number;
    const receive = (value: HarnessUpdateState[]) => {
      if (!active) return;
      for (const entry of value) {
        if (
          entry.status === "updated" &&
          (["queued", "installing"].includes(previous.current.get(entry.id)?.status ?? "") ||
            pendingRequests.current.has(entry.id))
        )
          setCompleted((current) => ({ ...current, [entry.id]: entry.latestVersion }));
      }
      setErrors((current) => {
        const next = { ...current };
        for (const id of Object.keys(next)) {
          const entry = value.find((entry) => entry.id === id);
          if (!entry || entry.status !== "available" || next[id].release !== releaseKey(entry))
            delete next[id];
        }
        return next;
      });
      previous.current = new Map(value.map((entry) => [entry.id, entry]));
      setEntries(value);
    };
    const unsubscribe = api.onHarnessUpdates((value) => {
      revision++;
      receive(value);
    });
    // Reconnect reads recover a lost initial IPC response without adding a discovery endpoint.
    const read = () => {
      if (!active || loading) return;
      loading = true;
      window.clearTimeout(retry);
      const requested = revision;
      void api
        .harnessUpdates()
        .then((value) => {
          if (requested === revision) receive(value);
        })
        .catch(() => {
          if (active) retry = window.setTimeout(read, 60_000);
        })
        .finally(() => {
          loading = false;
        });
    };
    const resume = () => {
      setNow(Date.now());
      if (!document.hidden) read();
    };
    read();
    window.addEventListener("focus", resume);
    window.addEventListener("online", resume);
    document.addEventListener("visibilitychange", resume);
    return () => {
      active = false;
      window.clearTimeout(retry);
      window.removeEventListener("focus", resume);
      window.removeEventListener("online", resume);
      document.removeEventListener("visibilitychange", resume);
      unsubscribe();
    };
  }, [api]);

  useEffect(() => {
    // Schedule only the next snooze expiry; idle renderers need no polling clock.
    const expirations = entries.flatMap((entry) => {
      const stored = storedSnooze(entry.id);
      const persisted = harnessUpdateSnoozed(entry, stored, now)
        ? (JSON.parse(stored!) as Snooze).until
        : 0;
      return [persisted, dismissed[entry.id]?.until ?? 0].filter((until) => until > now);
    });
    if (!expirations.length) return;
    const timer = window.setTimeout(
      () => setNow(Date.now()),
      Math.max(0, Math.min(...expirations) - Date.now()),
    );
    return () => window.clearTimeout(timer);
  }, [entries, dismissed, now]);

  const notices = entries
    .map((entry): HarnessUpdateState =>
      errors[entry.id]?.release === releaseKey(entry) &&
      ["available", "error"].includes(entry.status)
        ? { ...entry, status: "error", message: errors[entry.id].message }
        : entry,
    )
    .filter((entry) => {
      if (entry.status === "current" && !entry.checkError) return false;
      if (
        entry.status === "updated" &&
        completed[entry.id] !== entry.latestVersion &&
        !entry.checkError
      )
        return false;
      return (
        !(dismissed[entry.id]?.key === noticeKey(entry) && dismissed[entry.id].until > now) &&
        !harnessUpdateSnoozed(entry, storedSnooze(entry.id), now)
      );
    });
  const allComplete = notices.length > 0 && notices.every((entry) => entry.status === "updated");
  useEffect(() => {
    if (!allComplete) return;
    // Keep the batch together until it finishes, then quietly clear its confirmations.
    let timer: number;
    const clear = () => {
      if (document.hidden || panel.current?.matches(":hover, :focus-within")) {
        timer = window.setTimeout(clear, 1000);
        return;
      }
      setCompleted({});
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
          aria-label="Remind me tomorrow about harness updates"
          title="Remind me tomorrow"
          onClick={() => {
            const until = Date.now() + snoozeDuration;
            const snoozes = Object.fromEntries(
              notices.map((entry) => [entry.id, { key: noticeKey(entry), until }]),
            );
            setDismissed((current) => ({ ...current, ...snoozes }));
            for (const entry of notices) {
              try {
                localStorage.setItem(dismissedKey(entry.id), JSON.stringify(snoozes[entry.id]));
              } catch {}
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
          const checkError = entry.status === "check-error";
          const detail =
            checkError || entry.status === "current"
              ? entry.installedVersion
                ? `Version ${entry.installedVersion}`
                : "Version unavailable"
              : queued
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
                            : checkError || entry.status === "current"
                              ? "Update check unavailable"
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
                    if (!api || pendingRequests.current.has(entry.id)) return;
                    pendingRequests.current.add(entry.id);
                    if (event.currentTarget === document.activeElement)
                      progressFocus.current = entry.id;
                    setPending((current) => ({ ...current, [entry.id]: true }));
                    setErrors((current) => {
                      const next = { ...current };
                      delete next[entry.id];
                      return next;
                    });
                    setDismissed((current) => {
                      const next = { ...current };
                      delete next[entry.id];
                      return next;
                    });
                    try {
                      localStorage.removeItem(dismissedKey(entry.id));
                    } catch {}
                    void api
                      .installHarnessUpdate(entry.id)
                      .catch(() => {
                        // A lost reply cannot replace confirmed progress or a different release.
                        const current = previous.current.get(entry.id);
                        if (
                          !current ||
                          releaseKey(current) !== releaseKey(entry) ||
                          ["queued", "installing", "updated"].includes(current.status)
                        )
                          return;
                        setErrors((current) => ({
                          ...current,
                          [entry.id]: {
                            release: releaseKey(entry),
                            message: "Couldn’t start the update. Try again.",
                          },
                        }));
                      })
                      .finally(() => {
                        pendingRequests.current.delete(entry.id);
                        setPending((current) => ({ ...current, [entry.id]: false }));
                      });
                  }}
                >
                  {error ? "Retry" : "Update"}
                </Button>
              ) : null}
              {error ||
              (!entry.canInstall && !checkError && (!entry.checkError || entry.message)) ? (
                <p className="harness-update-error" role={error ? "alert" : undefined}>
                  {entry.message ?? "Use your package manager to update."}
                </p>
              ) : null}
              {entry.checkError ? <p className="harness-update-error">{entry.checkError}</p> : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
