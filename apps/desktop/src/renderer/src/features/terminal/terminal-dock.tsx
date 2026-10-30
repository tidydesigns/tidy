import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Button } from "@tidy/ui/button";
import { showToast } from "@tidy/ui/toast";
import type { Project, DesktopAPI } from "../../../../shared/contracts/desktop";
import type { TerminalAPI, TerminalWatch } from "../../../../shared/contracts/terminal";

type Instance = Awaited<ReturnType<typeof import("./terminal-runtime").createTerminal>>;

function TerminalSurface({
  api,
  projectId,
  active,
  copy,
  onEnd,
}: {
  api: TerminalAPI;
  projectId: string;
  active: boolean;
  copy?(text: string): Promise<void>;
  onEnd(): void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const instance = useRef<Instance | undefined>(undefined);
  const watch = useRef<TerminalWatch | undefined>(undefined);
  const session = useRef<string | undefined>(undefined);
  const visible = useRef(active);
  const [status, setStatus] = useState("Opening terminal…");
  const [exited, setExited] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const reconnect = useRef<() => void>(() => {});
  useLayoutEffect(() => {
    visible.current = active;
    if (active && instance.current) {
      instance.current.fit.fit();
      instance.current.terminal.focus();
    }
  }, [active]);
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
        terminal.open(host.current);
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
                const replayed = () => {
                  replaying = false;
                  if (disposed) return;
                  // watch() may deliver its initial snapshot synchronously in a local adapter.
                  queueMicrotask(() =>
                    watch.current?.input({
                      kind: "ack",
                      sessionId: output.sessionId,
                      sequence: output.sequence,
                    }),
                  );
                };
                // ghostty-web 0.4 cannot write an empty buffer (its WASM allocator returns a sentinel).
                if (output.data) terminal.write(output.data, replayed);
                else replayed();
                connected = !output.exited;
                setExited(output.exited);
                setStatus(
                  output.exited
                    ? `Shell exited${output.exitCode === null ? "" : ` (${output.exitCode})`}.`
                    : "",
                );
                if (visible.current) {
                  fit.fit();
                  terminal.focus();
                }
              } else {
                if (output.sessionId !== session.current || output.sequence <= sequence) return;
                if (output.sequence !== sequence + 1) {
                  connected = false;
                  setStatus("Terminal output was interrupted. Reconnect to continue.");
                  return;
                }
                sequence = output.sequence;
                terminal.write(output.data, () => {
                  if (!disposed)
                    watch.current?.input({
                      kind: "ack",
                      sessionId: output.sessionId,
                      sequence: output.sequence,
                    });
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
  }, [api, projectId, attempt, copy]);
  return (
    <div className="terminal-session" hidden={!active}>
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
                void (id ? api.end({ projectId, sessionId: id }) : Promise.resolve())
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
      <Button
        className="terminal-end quiet-button"
        title="End terminal session"
        aria-label="End terminal session"
        onClick={() => {
          if (session.current)
            void api
              .end({ projectId, sessionId: session.current })
              .catch(() =>
                showToast("Could not end the terminal. Reopen it when the machine reconnects."),
              );
          onEnd();
        }}
      >
        ×
      </Button>
    </div>
  );
}

export function TerminalDock({
  api,
  projects,
  project,
  available,
  active,
}: {
  api: DesktopAPI;
  projects: Project[];
  project?: Project;
  available: boolean;
  active: boolean;
}) {
  const [sessions, setSessions] = useState<Project[]>([]);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [height, setHeight] = useState(280);
  useEffect(() => {
    setExpanded((current) =>
      Object.keys(current).every((id) => projects.some((project) => project.id === id))
        ? current
        : Object.fromEntries(
            Object.entries(current).filter(([id]) => projects.some((project) => project.id === id)),
          ),
    );
    setSessions((current) =>
      current.every((session) => projects.some((project) => project.id === session.id))
        ? current
        : current.filter((session) => projects.some((project) => project.id === session.id)),
    );
  }, [projects]);
  const toggle = useRef<HTMLButtonElement>(null);
  const valid = project && !project.cloud && available && Boolean(api.terminal);
  const open = Boolean(valid && expanded[project.id]);
  const show = () => {
    if (!valid) return;
    if (open) toggle.current?.focus();
    setExpanded((current) => ({ ...current, [project.id]: !current[project.id] }));
    setSessions((current) =>
      current.some((item) => item.id === project.id) ? current : [...current, project],
    );
  };
  const showRef = useRef(show);
  useLayoutEffect(() => {
    showRef.current = show;
  });
  useEffect(() => {
    const key = (event: globalThis.KeyboardEvent) => {
      if (
        active &&
        event.ctrlKey &&
        !event.altKey &&
        !event.shiftKey &&
        !event.metaKey &&
        event.code === "Backquote"
      ) {
        event.preventDefault();
        showRef.current();
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [active]);
  return (
    <div
      className={`terminal-dock ${open ? "terminal-dock-open" : ""}`}
      hidden={!valid}
      style={{ height: open ? `min(${height}px, 65vh)` : undefined }}
    >
      {open && (
        <div
          className="terminal-resize"
          role="separator"
          tabIndex={0}
          aria-label="Resize terminal"
          aria-orientation="horizontal"
          aria-valuemin={140}
          aria-valuemax={Math.floor(window.innerHeight * 0.65)}
          aria-valuenow={height}
          onKeyDown={(event) => {
            if (event.key === "ArrowUp" || event.key === "ArrowDown") {
              event.preventDefault();
              setHeight((value) =>
                Math.max(
                  140,
                  Math.min(window.innerHeight * 0.65, value + (event.key === "ArrowUp" ? 24 : -24)),
                ),
              );
            }
          }}
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            const target = event.currentTarget;
            const startY = event.clientY;
            const startHeight = target.parentElement!.getBoundingClientRect().height;
            target.setPointerCapture(event.pointerId);
            const move = (next: PointerEvent) =>
              setHeight(
                Math.max(
                  140,
                  Math.min(window.innerHeight * 0.65, startHeight + startY - next.clientY),
                ),
              );
            const end = () => {
              target.removeEventListener("pointermove", move);
              target.removeEventListener("pointerup", end);
              target.removeEventListener("pointercancel", end);
            };
            target.addEventListener("pointermove", move);
            target.addEventListener("pointerup", end);
            target.addEventListener("pointercancel", end);
          }}
        />
      )}
      <div className="terminal-toolbar">
        <Button
          ref={toggle}
          className="quiet-button terminal-toggle"
          aria-expanded={open}
          aria-controls="workspace-terminal"
          title="Terminal (Ctrl+`)"
          onClick={show}
        >
          <svg
            width="15"
            height="15"
            viewBox="0 0 20 20"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            aria-hidden="true"
          >
            <path d="m4 5 5 5-5 5m7 0h5" />
          </svg>
          Terminal <span aria-hidden="true">{open ? "⌄" : "⌃"}</span>
        </Button>
        {open && <span className="terminal-project">{project?.name}</span>}
      </div>
      <div id="workspace-terminal" className="terminal-sessions" hidden={!open}>
        {api.terminal &&
          sessions.map((item) => (
            <TerminalSurface
              key={item.id}
              api={api.terminal!}
              projectId={item.id}
              active={open && item.id === project?.id}
              copy={api.browser?.copy}
              onEnd={() => {
                setSessions((current) => current.filter((value) => value.id !== item.id));
                setExpanded((current) => ({ ...current, [item.id]: false }));
                toggle.current?.focus();
              }}
            />
          ))}
      </div>
    </div>
  );
}
