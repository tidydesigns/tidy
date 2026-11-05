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
  const [pending, setPending] = useState(false);
  const [reading, setReading] = useState(true);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!active || !api) return;
    const version = ++revision.current;
    setReading(true);
    setPending(false);
    void api.state().then(
      (value) => {
        if (version === revision.current) {
          setState(value);
          setReading(false);
          setError("");
        }
      },
      (cause: unknown) => {
        if (version === revision.current) {
          setState(undefined);
          setReading(false);
          setError(cause instanceof Error ? cause.message : "Could not read browser settings.");
        }
      },
    );
    return () => {
      revision.current++;
    };
  }, [api, active, attempt]);

  const unavailable =
    state?.unavailableReason ??
    (state && !state.supported ? "Video streaming requires a Linux browser host." : undefined);

  function choose() {
    if (!api || !state || reading) return;
    const next = { ...state, enabled: !state.enabled };
    const version = ++revision.current;
    setState(next);
    setPending(true);
    setError("");
    void api.choose({ enabled: next.enabled }).then(
      (value) => {
        if (version === revision.current) {
          setState(value);
          setPending(false);
        }
      },
      (cause: unknown) => {
        if (version !== revision.current) return;
        setPending(false);
        setReading(true);
        setError(cause instanceof Error ? cause.message : "Could not change browser streaming.");
        void api.state().then(
          (value) => {
            if (version === revision.current) {
              setState(value);
              setReading(false);
            }
          },
          () => {
            if (version === revision.current) {
              setState(undefined);
              setReading(false);
            }
          },
        );
      },
    );
  }

  return (
    <>
      <div className="completion-row">
        <div className="min-w-0">
          <span>Browser video streaming</span>
          <p>Voxl video streaming with JPEG fallback.</p>
        </div>
        <Button
          role="switch"
          aria-label="Browser video streaming"
          aria-describedby="labs-streaming-status"
          aria-busy={pending || reading}
          aria-checked={state?.enabled ?? false}
          disabled={
            !api ||
            !state ||
            reading ||
            ((!state.supported || Boolean(unavailable)) && !state.enabled)
          }
          className="completion-switch disabled:cursor-default disabled:opacity-50"
          onClick={choose}
        >
          <span />
        </Button>
      </div>
      <p id="labs-streaming-status" className="thread-naming-note" role="status">
        {pending
          ? state?.enabled
            ? "Enabling…"
            : "Disabling…"
          : reading && api
            ? "Checking host…"
            : unavailable
              ? `Unavailable. ${state?.enabled ? "Saved preference is on. " : ""}${unavailable}`
              : state
                ? state.enabled
                  ? "Enabled for new browser sessions."
                  : "Disabled. New browser sessions use JPEG."
                : "Settings unavailable."}
      </p>
      <p className="thread-naming-note">
        Applies to new browser sessions on the selected machine. Existing sessions keep their mode.
        Open a preview in a new thread to use the change. If video cannot run, the preview shows its
        JPEG fallback status.
      </p>
      {!api && <p className="thread-naming-note">Experimental features require the desktop app.</p>}
      {error && (
        <p className="mt-4 text-xs text-(--desktop-status-danger)" role="alert">
          {error}
        </p>
      )}
      {(error || unavailable) && (
        <Button
          className="secondary-button"
          disabled={reading || pending}
          onClick={() => setAttempt((value) => value + 1)}
        >
          Check again
        </Button>
      )}
    </>
  );
}

export function LabsSettings({ active }: { active: boolean }) {
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
          if (current && version === generation) {
            setMachines([]);
            setError("Could not refresh connected machines.");
          }
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
    <section className="min-w-0 wrap-anywhere" aria-label="Experimental features">
      <p className="thread-naming-note">Try unfinished features. They may change or break.</p>
      {(connected.length > 0 || machine !== "local") && (
        <div className="flex min-h-11 flex-wrap items-center justify-between gap-3 border-b border-border pb-6 text-sm font-medium">
          <span>Machine</span>
          <SelectMenu
            value={machine}
            label="Browser host machine"
            size="sm"
            className="w-52 min-w-0 max-w-full [&_[data-ph-private]]:block [&_[data-ph-private]]:text-start [&_[data-ph-private]]:wrap-anywhere [&_[data-ph-private]]:whitespace-normal"
            triggerClassName="h-auto! min-h-8"
            renderOptionLabel={(option) => (
              <span className="block text-start wrap-anywhere whitespace-normal">
                {option.label}
              </span>
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
        <p className="mt-4 text-xs text-(--desktop-status-danger)" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
