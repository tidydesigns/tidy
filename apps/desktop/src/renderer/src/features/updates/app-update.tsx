import { useEffect, useId, useRef, useState } from "react";
import { Button } from "@tidy/ui/button";
import { Icon } from "@tidy/editor/components/ui/icon";
import type { DesktopAPI } from "../../../../shared/contracts/desktop";
import type { AppUpdateState } from "../../../../shared/contracts/app-updates";

/** Show update progress and restart/retry actions with hover and keyboard-focus details. */
export function AppUpdate({ api }: { api: DesktopAPI | undefined }) {
  const [state, setState] = useState<AppUpdateState>();
  const [error, setError] = useState(false);
  const revision = useRef(0);
  const tooltipId = useId();
  const [tooltipDismissed, setTooltipDismissed] = useState(false);
  useEffect(() => {
    revision.current++;
    setState(undefined);
    setError(false);
    if (!api) return;
    let received = false;
    let active = true;
    const unsubscribe = api.onUpdate((value) => {
      if (!active) return;
      revision.current++;
      received = true;
      setError(false);
      setState(value);
    });
    void api
      .updateState()
      .then((value) => {
        if (active && !received) setState(value);
      })
      .catch(() => {
        if (active && !received) setState({ status: "error", error: "check" });
      });
    return () => {
      active = false;
      revision.current++;
      unsubscribe();
    };
  }, [api]);

  const unavailable = !api || state?.status === "unsupported";
  const installing = state?.status === "installing";
  const busy = Boolean(state && ["checking", "downloading", "installing"].includes(state.status));
  const retry = state?.status === "error";
  const ready = state?.status === "ready";
  const installError = error || state?.error === "install";
  const message = installError
    ? "Couldn’t restart to update. Click to retry."
    : retry
      ? state?.error === "download"
        ? "Couldn’t download the update. Click to retry."
        : "Couldn’t check for updates. Click to retry."
      : null;
  const label = unavailable
    ? "Automatic updates aren’t available in this build."
    : (message ??
      (installing
        ? "Restarting to update…"
        : state?.status === "checking"
          ? "Checking for updates…"
          : state?.status === "downloading"
            ? `Downloading Tidy ${state.version}…`
            : ready
              ? `Restart to update to Tidy ${state.version}`
              : state
                ? "Check for updates"
                : "Updates"));
  const actionLabel = unavailable
    ? "Updates unavailable"
    : retry
      ? "Retry update check"
      : installError
        ? "Retry restart to update"
        : busy
          ? label
          : ready
            ? "Restart to update"
            : label;
  return (
    <span className="sidebar-update">
      <span
        className="app-update-control"
        data-tooltip-dismissed={tooltipDismissed}
        onPointerEnter={() => setTooltipDismissed(false)}
        onFocus={() => setTooltipDismissed(false)}
        onBlur={() => setTooltipDismissed(true)}
        onKeyDown={(event) => {
          if (event.key === "Escape") setTooltipDismissed(true);
        }}
      >
        <Button
          className="app-update-button"
          aria-label={actionLabel}
          aria-describedby={tooltipId}
          aria-busy={busy}
          aria-disabled={busy || unavailable || !state}
          data-state={busy ? "busy" : retry || installError ? "error" : ready ? "ready" : "idle"}
          onClick={() => {
            if (unavailable || busy || !state || !api) return;
            setError(false);
            if (!ready || retry) {
              const request = ++revision.current;
              setState({ status: "checking" });
              void api
                .checkUpdates()
                .then(async () => {
                  // A rate-limited native check can finish without publishing an event.
                  if (revision.current !== request) return;
                  const next = await api.updateState();
                  if (revision.current === request) setState(next);
                })
                .catch(() => {
                  if (revision.current === request) setState({ status: "error", error: "check" });
                });
              return;
            }
            // Disable synchronously so repeated clicks cannot start a second install.
            const request = ++revision.current;
            setState((current) => ({ ...current, status: "installing" }));
            void api.installUpdate().catch(() => {
              if (revision.current !== request) return;
              setState((current) => ({ ...current, status: "ready" }));
              setError(true);
            });
          }}
        >
          <Icon name="update" size={16} className={busy ? "app-update-spinning" : ""} />
          {!busy && (ready || retry || installError) && (
            <span
              className={`app-update-badge ${retry || installError ? "app-update-warning" : "app-update-ready"}`}
              aria-hidden="true"
            >
              <Icon name={retry || installError ? "warningCircle" : "checkCircle"} size={12} />
            </span>
          )}
        </Button>
        <span id={tooltipId} className="app-update-tooltip" role="tooltip">
          {label}
        </span>
      </span>
      <span className="sr-only" role="status">
        {label}
      </span>
    </span>
  );
}
