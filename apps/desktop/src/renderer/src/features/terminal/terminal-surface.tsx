import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Button } from "@tidy/ui/button";
import type { ITheme } from "ghostty-web";
import { TerminalReplay } from "./terminal-replay";
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
  const currentTheme = useRef(theme);
  const refreshTheme = useRef<() => void>(() => {});
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
  useLayoutEffect(() => {
    currentTheme.current = theme;
    refreshTheme.current();
  }, [theme, active]);
  useEffect(() => {
    let disposed = false;
    let current: Instance | undefined;
    let stop: (() => void) | undefined;
    let observer: ResizeObserver | undefined;
    let resizeFrame = 0;
    let generation = 0;
    let renderedTheme: ITheme;
    let buildingTheme: ITheme | undefined;
    const replay = new TerminalReplay();
    const staged = new Set<Instance>();
    void import("./terminal-runtime")
      .then((module) => {
        renderedTheme = currentTheme.current;
        return module.createTerminal(renderedTheme);
      })
      .then((value) => {
        if (disposed || !host.current) {
          value.terminal.dispose();
          return;
        }
        current = value;
        instance.current = value;
        let { terminal, fit } = value;
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
        let parsed = false;
        let sequence = 0;
        let connected = false;
        let attached = false;
        const bind = () => {
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
            replay.resize(cols, rows);
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
          return () => {
            titleListener.dispose();
            dataListener.dispose();
            resizeListener.dispose();
          };
        };
        stop = bind();
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
                  // A fresh renderer is already empty. Resetting it would free
                  // and recreate its WASM terminal immediately after open().
                  if (parsed) terminal.reset();
                  parsed = false;
                  terminal.resize(output.cols, output.rows);
                  replay.reset(output.cols, output.rows);
                }
                // Parsing is synchronous. Credits acknowledge parsed bytes, not a future animation frame.
                if (output.data) {
                  replay.write(output.data);
                  terminal.write(output.data);
                  parsed = true;
                }
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
                replay.write(output.data);
                terminal.write(output.data);
                parsed = true;
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
        // Ghostty 0.4 palettes are immutable. Rebuild a renderer locally, in
        // short chunks, while the existing terminal keeps receiving input/output.
        // Hidden tabs do no work until activated; the PTY stream stays attached.
        const rebuild = async () => {
          const nextTheme = currentTheme.current;
          if (buildingTheme && buildingTheme !== nextTheme) {
            generation++;
            buildingTheme = undefined;
          }
          if (!visible.current || renderedTheme === nextTheme || buildingTheme === nextTheme)
            return;
          const token = ++generation;
          const snapshot = replay.capture();
          if (!snapshot) {
            // The cache exceeded its cap. Use the normal bounded host snapshot.
            setAttempt((value) => value + 1);
            return;
          }
          buildingTheme = nextTheme;
          let replacement: Instance | undefined;
          let element: HTMLDivElement | undefined;
          try {
            const { createTerminal } = await import("./terminal-runtime");
            replacement = await createTerminal(nextTheme, snapshot);
            staged.add(replacement);
            if (disposed || token !== generation || !host.current) return;
            element = document.createElement("div");
            element.className = "terminal-renderer";
            element.style.visibility = "hidden";
            host.current.append(element);
            const next = replacement.terminal;
            next.options.fontSize = currentFontSize.current;
            replacement.setActive(false);
            const focus = next.focus;
            next.focus = () => {};
            next.open(element);
            next.focus = focus;
            next.resize(snapshot.cols, snapshot.rows);
            let index = 0;
            let started = performance.now();
            while (index < snapshot.events.length) {
              if (disposed || token !== generation || !visible.current || !replay.valid(snapshot))
                return;
              const event = snapshot.events[index++];
              if ("data" in event) next.write(event.data);
              else next.resize(event.cols, event.rows);
              if (performance.now() - started >= 5) {
                await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
                started = performance.now();
              }
            }
            if (disposed || token !== generation || !visible.current || !replay.valid(snapshot))
              return;
            const old = current!;
            const focused = Boolean(old.terminal.element?.contains(document.activeElement));
            const offset = old.terminal.viewportY;
            const selection = old.terminal.getSelectionPosition();
            stop?.();
            current = replacement;
            instance.current = replacement;
            terminal = next;
            fit = replacement.fit;
            renderedTheme = nextTheme;
            staged.delete(replacement);
            replacement = undefined;
            const oldElement = old.terminal.element;
            old.terminal.dispose();
            if (oldElement !== host.current) oldElement?.remove();
            stop = bind();
            current.setActive(visible.current);
            element.style.visibility = "";
            if (terminal.options.fontSize !== currentFontSize.current)
              terminal.options.fontSize = currentFontSize.current;
            fit.fit();
            terminal.scrollToLine(offset);
            if (selection) {
              const { start, end } = selection;
              terminal.select(
                start.x,
                start.y,
                (end.y - start.y) * terminal.cols + end.x - start.x,
              );
            }
            terminal.renderer?.render(terminal.wasmTerm!, true, terminal.viewportY, terminal);
            if (focused) terminal.focus();
            element = undefined;
          } catch {
            if (!disposed && token === generation) {
              generation++;
              buildingTheme = undefined;
              setAttempt((value) => value + 1);
            }
          } finally {
            if (replacement) {
              staged.delete(replacement);
              replacement.terminal.dispose();
            }
            element?.remove();
            if (token === generation) {
              buildingTheme = undefined;
              if (!disposed && renderedTheme !== currentTheme.current) refreshTheme.current();
            }
          }
        };
        refreshTheme.current = () => {
          void rebuild();
        };
        refreshTheme.current();
      })
      .catch(() => {
        if (!disposed) setStatus("Could not load the terminal. Try reconnecting.");
      });
    return () => {
      disposed = true;
      generation++;
      refreshTheme.current = () => {};
      for (const value of staged) value.terminal.dispose();
      staged.clear();
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
      const oldElement = current?.terminal.element;
      current?.terminal.dispose();
      if (oldElement !== host.current) oldElement?.remove();
      if (preview.current) host.current?.append(preview.current);
      instance.current = undefined;
    };
  }, [api, projectId, terminalId, threadId, threadProjectId, attempt, copy]);
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
