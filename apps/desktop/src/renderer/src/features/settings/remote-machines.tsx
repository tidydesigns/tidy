import { useEffect, useRef, useState } from "react";
import { Button } from "@tidy/ui/button";
import {
  remoteTargetSchema,
  type ConnectionStatus,
  type MachineBridge,
  type RemoteBridge,
  type WorkspaceMachine,
} from "../../../../shared/remote";

function statusLabel(status: ConnectionStatus | null): string {
  if (!status) return "Waiting to connect";
  switch (status.kind) {
    case "preparing":
      return {
        checking: "Checking remote machine…",
        installing: "Installing backend…",
        starting: "Starting backend…",
        connecting: "Connecting…",
        syncing: "Syncing workspace…",
      }[status.phase];
    case "connected":
      return "Connected";
    case "authentication":
      return "Authentication required";
    case "verification":
      return "Verify your connection";
    case "reconnecting":
      return "Reconnecting…";
    case "offline":
      return "Offline";
    case "blocked":
      return "Connection needs attention";
    case "closed":
      return "Disconnected";
  }
}

function RemoteMachineRow({
  machine,
  remote,
  onRemove,
}: {
  machine: WorkspaceMachine;
  remote: RemoteBridge;
  onRemove(): Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const status = machine.status;
  async function perform(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to update this connection.");
    } finally {
      setBusy(false);
    }
  }
  const message = status && "message" in status ? status.message : null;
  return (
    <li className="remote-machine">
      <div className="remote-machine-heading">
        <div>
          <h2>{machine.label}</h2>
          <p className="remote-machine-status" role="status">
            <span className="remote-status-dot" data-connected={status?.kind === "connected"} />
            {statusLabel(status)}
          </p>
        </div>
        <div className="settings-account-actions">
          {(!status || ["offline", "blocked", "closed"].includes(status.kind)) && (
            <Button
              className="secondary-button"
              disabled={busy}
              onClick={() => void perform(() => remote.retry())}
            >
              Retry
            </Button>
          )}
          <Button
            className="secondary-button"
            disabled={busy}
            onClick={() => void perform(onRemove)}
          >
            Remove
          </Button>
        </div>
      </div>
      {message && <p className="remote-machine-detail">{message}</p>}
      {status?.kind === "connected" && status.warning && (
        <p className="remote-machine-detail">{status.warning}</p>
      )}
      {status?.kind === "verification" && (
        <div className="remote-machine-prompt">
          <p>Continue in your browser to verify SSH access.</p>
          <div className="settings-account-actions">
            <Button
              className="secondary-button"
              disabled={busy}
              onClick={() => void perform(() => remote.verify(status.requestId))}
            >
              Verify in browser
            </Button>
            <Button
              className="secondary-button"
              disabled={busy}
              onClick={() => void perform(() => remote.cancelVerification(status.requestId))}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}
      {status?.kind === "authentication" && (
        <form
          key={status.promptId}
          className="remote-machine-prompt"
          onSubmit={(event) => {
            event.preventDefault();
            const form = event.currentTarget;
            const answer = new FormData(form).get("answer");
            if (typeof answer !== "string") return;
            form.reset();
            void perform(() => remote.authenticate({ promptId: status.promptId, answer }));
          }}
        >
          <label htmlFor={`remote-answer-${machine.id}`}>{status.question}</label>
          <div className="remote-connect-fields">
            <input
              id={`remote-answer-${machine.id}`}
              name="answer"
              type={status.secret ? "password" : "text"}
              autoComplete="off"
              required
              disabled={busy}
            />
            <Button type="submit" className="secondary-button" disabled={busy}>
              Continue
            </Button>
            <Button
              type="button"
              className="secondary-button"
              disabled={busy}
              onClick={() =>
                void perform(() => remote.authenticate({ promptId: status.promptId, answer: null }))
              }
            >
              Cancel
            </Button>
          </div>
        </form>
      )}
      {error && (
        <p className="remote-error" role="alert">
          {error}
        </p>
      )}
    </li>
  );
}

export function RemoteMachines({
  machines,
  remote,
}: {
  machines: MachineBridge;
  remote: RemoteBridge;
}) {
  const [items, setItems] = useState<WorkspaceMachine[]>([]);
  const [target, setTarget] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const removing = useRef(new Set<string>());
  const refresh = useRef<() => Promise<void>>(async () => {});
  useEffect(() => {
    let generation = 0;
    let active = true;
    refresh.current = async () => {
      const request = ++generation;
      try {
        const next = await machines.list();
        if (active && request === generation)
          setItems(
            (next ?? []).filter((item) => item.id !== "local" && !removing.current.has(item.id)),
          );
      } catch (cause) {
        if (active && request === generation)
          setError(cause instanceof Error ? cause.message : "Unable to load connections.");
      }
    };
    const unsubscribe = machines.onChanged(() => void refresh.current());
    void refresh.current();
    return () => {
      active = false;
      unsubscribe();
    };
  }, [machines]);

  return (
    <section className="settings-remote" aria-label="Remote connection setup">
      <p className="remote-intro">
        Connect to a desktop or server over SSH. Tidy installs and starts its backend automatically.
      </p>
      <form
        className="remote-connect"
        onSubmit={(event) => {
          event.preventDefault();
          const parsed = remoteTargetSchema.safeParse(target);
          if (!parsed.success) {
            setError("Enter an SSH alias or user@hostname.");
            return;
          }
          setConnecting(true);
          setError(null);
          void remote
            .connect(parsed.data)
            .then(() => {
              setTarget((current) => (current === target ? "" : current));
              return refresh.current();
            })
            .catch((cause: unknown) => {
              setError(
                cause instanceof Error ? cause.message : "Unable to connect to this machine.",
              );
            })
            .finally(() => setConnecting(false));
        }}
      >
        <label htmlFor="remote-destination">SSH destination</label>
        <div className="remote-connect-fields">
          <input
            id="remote-destination"
            value={target}
            onChange={(event) => setTarget(event.target.value)}
            placeholder="user@home-desktop"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            maxLength={253}
            required
          />
          <Button
            type="submit"
            className="secondary-button"
            disabled={connecting || !target.trim()}
          >
            {connecting ? "Connecting…" : "Connect"}
          </Button>
        </div>
      </form>
      {error && (
        <p className="remote-error" role="alert">
          {error}
        </p>
      )}
      <details className="remote-requirements">
        <summary>Before you connect</summary>
        <ol>
          <li>Install Tailscale on both machines and sign in to the same network.</li>
          <li>
            Enable SSH access on the remote machine. Confirm you can reach it with{" "}
            <code>ssh user@hostname</code>.
          </li>
          <li>
            Install and sign in to your coding agent on the remote machine, where your repositories
            live.
          </li>
        </ol>
        <p>
          You do not need to install the Tidy desktop app on the remote machine. Keep that machine
          awake and online.
        </p>
      </details>
      {items.length > 0 && (
        <ul className="remote-machines-list">
          {items.map((machine) => (
            <RemoteMachineRow
              key={machine.id}
              machine={machine}
              remote={machines.workspace(machine.id).remote}
              onRemove={async () => {
                removing.current.add(machine.id);
                setItems((current) => current.filter((item) => item.id !== machine.id));
                try {
                  await remote.forget(machine.id);
                } catch (cause) {
                  setError(
                    cause instanceof Error ? cause.message : "Unable to remove this connection.",
                  );
                } finally {
                  removing.current.delete(machine.id);
                  await refresh.current();
                }
              }}
            />
          ))}
        </ul>
      )}
    </section>
  );
}
