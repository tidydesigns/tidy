import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Button } from "@tidy/ui/button";
import type { ITheme } from "ghostty-web";
import {
  terminalSizeLimits,
  type TerminalAPI,
  type TerminalWatch,
} from "../../../../shared/contracts/terminal";

type Instance = Awaited<ReturnType<typeof import("./terminal-runtime").createTerminal>>;

export function TerminalSurface({
  api,
  projectId,
  terminalId,
  threadId,
  threadProjectId,
  active,
  focusOnActivate,
  fontSize,
  theme,
  onTitle,
  copy,
}: {
  api: TerminalAPI;
  projectId: string;
  terminalId: string;
  threadId?: string;
  threadProjectId?: string;
  onTitle(title: string): void;
  active: boolean;
  focusOnActivate: boolean;
  fontSize: number;
  theme: ITheme;
  copy?(text: string): Promise<void>;
}) {
  const host = useRef<HTMLDivElement>(null);
  const preview = useRef<HTMLCanvasElement | undefined>(undefined);
  const scrollback = useRef(0);
  const instance = useRef<Instance | undefined>(undefined);
  const watch = useRef<TerminalWatch | undefined>(undefined);
  const session = useRef<string | undefined>(undefined);
  const visible = useRef(active);
  const currentFontSize = useRef(fontSize);
  useLayoutEffect(() => {
    currentFontSize.current = fontSize;
    const value = instance.current;
    if (active && value && value.terminal.options.fontSize !== fontSize) {
      value.terminal.options.fontSize = fontSize;
      value.fit.fit();
    }
  }, [fontSize, active]);
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
  // Ghostty 0.4 cannot update its WASM palette after open(). Recreate only the
  // renderer and replay the existing PTY; the shell and its processes stay alive.
  useEffect(() => {
    let disposed = false;
    let current: Instance | undefined;
    let stop: (() => void) | undefined;
    let observer: ResizeObserver | undefined;
    let resizeFrame = 0;
    void import("./terminal-runtime")
      .then((module) => module.createTerminal(theme))
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
        terminal.options.fontSize = currentFontSize.current;
        terminal.open(host.current);
        if (!focusAfterOpen && previousFocus instanceof HTMLElement)
          previousFocus.focus({ preventScroll: true });
        value.setActive(visible.current);
        fit.fit();
        let replaying = false;
        let sequence = 0;
        let connected = false;
        let attached = false;
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
              cols: Math.min(
                terminalSizeLimits.maxCols,
                Math.max(terminalSizeLimits.minCols, cols),
              ),
              rows: Math.min(
                terminalSizeLimits.maxRows,
                Math.max(terminalSizeLimits.minRows, rows),
              ),
            });
        });
        const attach = () => {
          watch.current?.close();
          connected = false;
          if (!preview.current) setStatus("Connecting to terminal…");
          // A fresh renderer needs the full snapshot, including after a theme
          // change. Reconnects on that renderer can resume from its last byte.
          const resume =
            attached && session.current ? { sessionId: session.current, sequence } : undefined;
          attached = true;
          watch.current = api.watch(
            {
              projectId,
              terminalId,
              threadId,
              threadProjectId,
              cols: Math.min(
                terminalSizeLimits.maxCols,
                Math.max(terminalSizeLimits.minCols, terminal.cols),
              ),
              rows: Math.min(
                terminalSizeLimits.maxRows,
                Math.max(terminalSizeLimits.minRows, terminal.rows),
              ),
              resume,
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
                if (preview.current) {
                  terminal.scrollToLine(scrollback.current);
                  terminal.renderer?.render(terminal.wasmTerm!, true, terminal.viewportY, terminal);
                  preview.current.remove();
                  preview.current = undefined;
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
      // Keep available output visible until the replacement renderer has replayed
      // its snapshot. Theme changes must not flash an empty terminal.
      const canvas = host.current?.querySelector("canvas");
      if (!preview.current && canvas) {
        preview.current = canvas;
        scrollback.current = current?.terminal.viewportY ?? 0;
        canvas.classList.add("terminal-preview");
        canvas.setAttribute("aria-hidden", "true");
      }
      current?.terminal.dispose();
      if (preview.current) host.current?.append(preview.current);
      instance.current = undefined;
    };
  }, [api, projectId, terminalId, threadId, threadProjectId, attempt, copy, theme]);
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
