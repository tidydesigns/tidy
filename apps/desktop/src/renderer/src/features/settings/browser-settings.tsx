import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@tidy/ui/button";
import { SelectMenu } from "@tidy/ui/select-menu";
import type { BrowserStreamingState } from "../../../../shared/contracts/browser-streaming";
import type { WorkspaceMachine } from "../../../../shared/remote";

function StreamingChoice({ machine, active }: { machine: string; active: boolean }) {
  const api = useMemo(
    () =>
      machine === "local"
        ? window.tidy?.browser?.streaming
        : window.tidyMachines?.workspace(machine).api.browser?.streaming,
    [machine],
  );
  const [state, setState] = useState<BrowserStreamingState>();
  const [error, setError] = useState("");
  const revision = useRef(0);
  useEffect(() => {
    if (!active || !api) return;
    const version = ++revision.current;
    void api.state().then(
      (value) => {
        if (version === revision.current) {
          setState(value);
          setError("");
        }
      },
      (cause: unknown) => {
        if (version === revision.current)
          setError(cause instanceof Error ? cause.message : "Could not read browser settings.");
      },
    );
    return () => {
      revision.current++;
    };
  }, [api, active]);

  function choose() {
    if (!api || !state) return;
    const next = { ...state, enabled: !state.enabled };
    const version = ++revision.current;
    setState(next);
    setError("");
    void api.choose({ enabled: next.enabled }).then(
      (value) => {
        if (version === revision.current) setState(value);
      },
      (cause: unknown) => {
        if (version !== revision.current) return;
        setError(cause instanceof Error ? cause.message : "Could not change browser streaming.");
        void api.state().then(
          (value) => {
            if (version === revision.current) setState(value);
          },
          () => {
            if (version === revision.current) setState(undefined);
          },
        );
      },
    );
  }

  return (
    <>
      <div className="completion-row">
        <div>
          <span>Voxl streaming</span>
          <p>Experimental video streaming with JPEG fallback.</p>
        </div>
        <Button
          role="switch"
          aria-label="Voxl streaming"
          aria-checked={state?.enabled ?? false}
          disabled={!api || !state || (!state.supported && !state.enabled)}
          className="completion-switch disabled:cursor-default disabled:opacity-50"
          onClick={choose}
        >
          <span />
        </Button>
      </div>
      <p className="thread-naming-note">
        Applies to new browser sessions on this machine. Existing sessions keep their current mode.
        Open the browser in a new thread to test the change.
      </p>
      <p className="thread-naming-note">
        Requires a Linux host with Voxl, Xvfb, xrandr, Openbox and full Chrome installed. If video
        is interrupted, JPEG keeps the browser usable while video reconnects.
      </p>
      {state && !state.supported && (
        <p className="thread-naming-note">
          Video streaming is unavailable on this host’s operating system.
        </p>
      )}
      {!api && (
        <p className="thread-naming-note">Browser streaming settings require the desktop app.</p>
      )}
      {error && (
        <p className="settings-browser-error" role="alert">
          {error}
        </p>
      )}
    </>
  );
}

export function BrowserSettings({ active }: { active: boolean }) {
  const [machine, setMachine] = useState("local");
  const [machines, setMachines] = useState<WorkspaceMachine[]>([]);
  const [error, setError] = useState("");
  useEffect(() => {
    const bridge = window.tidyMachines;
    if (!active || !bridge) return;
    let current = true;
    let generation = 0;
    const read = () => {
      const version = ++generation;
      void bridge.list().then(
        (value) => {
          if (current && version === generation) {
            setMachines(value ?? []);
            setError("");
          }
        },
        () => {
          if (current && version === generation) setError("Could not refresh connected machines.");
        },
      );
    };
    const unsubscribe = bridge.onChanged(read);
    read();
    return () => {
      current = false;
      unsubscribe();
    };
  }, [active]);
  const connected = machines.filter(
    (item) => item.id !== "local" && item.status?.kind === "connected",
  );
  const selected = machine === "local" || connected.some((item) => item.id === machine);
  return (
    <section className="settings-browser" aria-label="Browser streaming settings">
      {(connected.length > 0 || machine !== "local") && (
        <div className="settings-appearance-row">
          <span>Machine</span>
          <SelectMenu
            value={machine}
            label="Browser host machine"
            size="sm"
            className="settings-browser-machine"
            renderOptionLabel={(option) => (
              <span className="settings-browser-machine-label">{option.label}</span>
            )}
            options={[
              { value: "local", label: "This machine" },
              ...connected.map((item) => ({ value: item.id, label: item.label })),
              ...(!selected ? [{ value: machine, label: "Disconnected machine" }] : []),
            ]}
            onChange={setMachine}
          />
        </div>
      )}
      {selected ? (
        <StreamingChoice key={machine} machine={machine} active={active} />
      ) : (
        <p className="thread-naming-note">Reconnect this machine to change its browser settings.</p>
      )}
      {error && (
        <p className="settings-browser-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
