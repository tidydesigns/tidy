import { useEffect, useState } from "react";
import { Button } from "@tidy/ui/button";
import { Icon } from "@tidy/editor/components/ui/icon";
import type { DesktopAPI } from "../../shared/contracts";
import type { AppUpdateState } from "../../shared/app-updates";

export function AppUpdate({ api }: { api: DesktopAPI | undefined }) {
  const [state, setState] = useState<AppUpdateState>({ status: "unsupported" });
  const [error, setError] = useState(false);
  useEffect(() => {
    if (!api) return;
    let received = false;
    let active = true;
    const unsubscribe = api.onUpdate((value) => {
      received = true;
      setError(false);
      setState(value);
    });
    void api
      .updateState()
      .then((value) => {
        if (active && !received) setState(value);
      })
      .catch(() => {});
    return () => {
      active = false;
      unsubscribe();
    };
  }, [api]);

  const preview = import.meta.env.DEV && state.status === "unsupported";
  if (!preview && ["unsupported", "idle"].includes(state.status)) return null;
  const installing = state.status === "installing";
  const busy = ["checking", "downloading", "installing"].includes(state.status);
  const retry = state.status === "error";
  const installError = error || state.error === "install";
  const message = installError
    ? "Couldn’t restart to update. Click to retry."
    : retry
      ? state.error === "download"
        ? "Couldn’t download the update. Click to retry."
        : "Couldn’t check for updates. Click to retry."
      : null;
  const label = preview
    ? "Update available (development preview)"
    : (message ??
      (installing
        ? "Restarting to update…"
        : state.status === "checking"
          ? "Checking for updates…"
          : state.status === "downloading"
            ? `Downloading Tidy ${state.version}…`
            : `Restart to update to Tidy ${state.version}`));
  return (
    <footer className="sidebar-update">
      <Button
        className="app-update-button"
        aria-label={label}
        title={label}
        aria-busy={busy}
        disabled={busy}
        onClick={() => {
          if (preview || !api) return;
          setError(false);
          if (retry) {
            setState({ status: "checking" });
            void api.checkUpdates().catch(() => {
              setState({ status: "error", error: "check" });
            });
            return;
          }
          // Disable synchronously so repeated clicks cannot start a second install.
          setState((current) => ({ ...current, status: "installing" }));
          void api.installUpdate().catch(() => {
            setState((current) => ({ ...current, status: "ready" }));
            setError(true);
          });
        }}
      >
        <Icon name="update" size={18} className={busy ? "app-update-spinning" : ""} />
        {!busy && !retry && !installError && <span className="app-update-dot" />}
      </Button>
      <span className="sr-only" role="status">
        {label}
      </span>
      {message && (
        <span className="app-update-error" role="alert">
          {message}
        </span>
      )}
    </footer>
  );
}
