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

  const preview = import.meta.env.DEV && !["ready", "installing"].includes(state.status);
  if (!preview && !["ready", "installing"].includes(state.status)) return null;
  const installing = state.status === "installing";
  const label = preview
    ? "Update available (development preview)"
    : installing
      ? "Restarting to update…"
      : `Restart to update to Tidy ${state.version}`;
  return (
    <footer className="sidebar-update">
      <Button
        className="app-update-button"
        aria-label={label}
        title={label}
        disabled={installing}
        onClick={() => {
          if (preview) return;
          setError(false);
          // Disable synchronously so repeated clicks cannot start a second install.
          setState((current) => ({ ...current, status: "installing" }));
          void api?.installUpdate().catch(() => {
            setState((current) => ({ ...current, status: "ready" }));
            setError(true);
          });
        }}
      >
        <Icon name="upgrade" size={18} />
        <span className="app-update-dot" />
      </Button>
      <span className="sr-only" role="status">
        {preview
          ? "Update available (development preview)"
          : installing
            ? "Restarting to update…"
            : `Tidy ${state.version} is ready to install.`}
      </span>
      {error && (
        <span className="app-update-error" role="alert">
          Couldn’t install the update. Try again.
        </span>
      )}
    </footer>
  );
}
