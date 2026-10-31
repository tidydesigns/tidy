import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Button } from "@tidy/ui/button";
import type { TerminalAPI, TerminalWatch } from "../../../../shared/contracts/terminal";

type Instance = Awaited<ReturnType<typeof import("./terminal-runtime").createTerminal>>;

export function TerminalSurface({
  api,
  projectId,
  terminalId,
  active,
  focusOnActivate,
  onTitle,
  copy,
}: {
  api: TerminalAPI;
  projectId: string;
  terminalId: string;
  onTitle(title: string): void;
  active: boolean;
  focusOnActivate: boolean;
  copy?(text: string): Promise<void>;
}) {
  const host = useRef<HTMLDivElement>(null);
  const instance = useRef<Instance | undefined>(undefined);
  const watch = useRef<TerminalWatch | undefined>(undefined);
  const session = useRef<string | undefined>(undefined);
  const visible = useRef(active);
  const shouldFocus = useRef(focusOnActivate);
  const titleCallback = useRef(onTitle);
  useLayoutEffect(() => {
    titleCallback.current = onTitle;
  }, [onTitle]);
  const [status, setStatus] = useState("Opening terminal…");
  const [exited, setExited] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const reconnect = useRef<() => void>(() => {});
  useLayoutEffect(() => {
    visible.current = active;
    shouldFocus.current = focusOnActivate;
    instance.current?.setActive(active);
    if (active && instance.current) {
      instance.current.fit.fit();
      if (focusOnActivate) instance.current.terminal.focus();
    }
  }, [active, focusOnActivate]);
  useEffect(() => {
    let disposed = false;
    let current: Instance | undefined;
    let stop: (() => void) | undefined;
    let observer: ResizeObserver | undefined;
    let resizeFrame = 0;
    void import("./terminal-runtime")
      .then((module) => module.createTerminal())
      .then((value) => {
        if (disposed || !host.current) {
          value.terminal.dispose();
          return;
        }
        current = value;
        instance.current = value;
        const { terminal, fit } = value;
        const previousFocus = document.activeElement;
        const ownsFocus = () =>
          visible.current &&
          shouldFocus.current &&
          (document.activeElement === document.body ||
            Boolean(document.activeElement?.closest(".terminal-dock, .terminal-launcher")));
        const focusAfterOpen = ownsFocus();
        terminal.open(host.current);
        if (!focusAfterOpen && previousFocus instanceof HTMLElement)
          previousFocus.focus({ preventScroll: true });
        value.setActive(visible.current);
        fit.fit();
        let replaying = false;
        let sequence = 0;
        let connected = false;
        terminal.attachCustomKeyEventHandler((event) => {
          if (
            (event.metaKey || (event.ctrlKey && event.shiftKey)) &&
            event.key.toLowerCase() === "c" &&
            terminal.hasSelection()
          ) {
            event.preventDefault();
            void (
              copy
                ? copy(terminal.getSelection())
                : navigator.clipboard.writeText(terminal.getSelection())
            ).catch(() => setStatus("Could not copy the selection."));
            return true;
          }
          // Keep Tidy's terminal shortcut available while the terminal has focus.
          // ghostty-web 0.4 returns true for a consumed key, unlike xterm's convention.
          return event.ctrlKey && event.code === "Backquote";
        });
        const titleListener = terminal.onTitleChange((title) => titleCallback.current(title));
        const dataListener = terminal.onData((data) => {
          if (!connected || replaying || !session.current) return;
          if (data.length > 128_000) {
            setStatus("Paste is too large. Paste fewer than 128,000 characters at a time.");
            return;
          }
          for (let offset = 0; offset < data.length;) {
            let end = Math.min(offset + 16_000, data.length);
            const last = data.charCodeAt(end - 1);
            if (end < data.length && last >= 0xd800 && last <= 0xdbff) end--;
            watch.current?.input({
              kind: "write",
              sessionId: session.current,
              data: data.slice(offset, end),
            });
            offset = end;
          }
        });
        const resizeListener = terminal.onResize(({ cols, rows }) => {
          if (connected && session.current)
            watch.current?.input({
              kind: "resize",
              sessionId: session.current,
              cols: Math.min(500, Math.max(2, cols)),
              rows: Math.min(300, Math.max(1, rows)),
            });
        });
        const attach = () => {
          watch.current?.close();
          connected = false;
          setStatus("Connecting to terminal…");
          watch.current = api.watch(
            {
              projectId,
              terminalId,
              cols: Math.min(500, Math.max(2, terminal.cols)),
              rows: Math.min(300, Math.max(1, terminal.rows)),
              resume: session.current ? { sessionId: session.current, sequence } : undefined,
            },
            (output) => {
              if (disposed) return;
              if (output.kind === "error" || output.kind === "disconnected") {
                connected = false;
                setStatus(output.message);
                return;
              }
              if (output.kind === "exit") {
                if (output.sessionId === session.current) {
                  connected = false;
                  setExited(true);
                  setStatus(
                    `Shell exited${output.exitCode === null ? "" : ` (${output.exitCode})`}.`,
                  );
                }
                return;
              }
              if (output.kind === "snapshot") {
                session.current = output.sessionId;
                sequence = output.sequence;
                replaying = true;
                if (output.reset) {
                  terminal.reset();
                  terminal.resize(output.cols, output.rows);
                }
                // Parsing is synchronous. Credits acknowledge parsed bytes, not a future animation frame.
                if (output.data) terminal.write(output.data);
                replaying = false;
                queueMicrotask(() =>
                  watch.current?.input({
                    kind: "ack",
                    sessionId: output.sessionId,
                    sequence: output.sequence,
                  }),
                );
                connected = !output.exited;
                setExited(output.exited);
                setStatus(
                  output.exited
                    ? `Shell exited${output.exitCode === null ? "" : ` (${output.exitCode})`}.`
                    : "",
                );
                if (visible.current) {
                  fit.fit();
                  if (ownsFocus()) terminal.focus();
                }
              } else {
                if (output.sessionId !== session.current || output.sequence <= sequence) return;
                if (output.sequence !== sequence + 1) {
                  connected = false;
                  setStatus("Terminal output was interrupted. Reconnect to continue.");
                  return;
                }
                sequence = output.sequence;
                terminal.write(output.data);
                watch.current?.input({
                  kind: "ack",
                  sessionId: output.sessionId,
                  sequence: output.sequence,
                });
              }
            },
          );
        };
        reconnect.current = attach;
        attach();
        observer = new ResizeObserver(() => {
          cancelAnimationFrame(resizeFrame);
          resizeFrame = requestAnimationFrame(() => {
            if (visible.current) fit.fit();
          });
        });
        observer.observe(host.current);
        stop = () => {
          titleListener.dispose();
          dataListener.dispose();
          resizeListener.dispose();
        };
      })
      .catch(() => {
        if (!disposed) setStatus("Could not load the terminal. Try reconnecting.");
      });
    return () => {
      disposed = true;
      observer?.disconnect();
      cancelAnimationFrame(resizeFrame);
      stop?.();
      watch.current?.close();
      watch.current = undefined;
      current?.terminal.dispose();
      instance.current = undefined;
    };
  }, [api, projectId, terminalId, attempt, copy]);
  return (
    <div
      id={`terminal-panel-${terminalId}`}
      className="terminal-session"
      role="tabpanel"
      aria-labelledby={`terminal-tab-${terminalId}`}
      hidden={!active}
    >
      <div ref={host} className="terminal-surface" aria-label="Project terminal" />
      {status && (
        <div className="terminal-status" role="status">
          <span>{status}</span>
          <Button
            className="quiet-button"
            disabled={restarting}
            onClick={() => {
              if (exited) {
                const id = session.current;
                setRestarting(true);
                setStatus("Starting a new shell…");
                void (id ? api.end({ projectId, terminalId, sessionId: id }) : Promise.resolve())
                  .then(() => {
                    session.current = undefined;
                    setAttempt((value) => value + 1);
                  })
                  .catch(() =>
                    setStatus("Could not restart the shell. Check the machine connection."),
                  )
                  .finally(() => setRestarting(false));
              } else if (instance.current) reconnect.current();
              else setAttempt((value) => value + 1);
            }}
          >
            {exited ? "New shell" : "Reconnect"}
          </Button>
        </div>
      )}
    </div>
  );
}
