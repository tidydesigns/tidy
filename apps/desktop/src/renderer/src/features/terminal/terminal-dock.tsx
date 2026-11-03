import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { terminalFont } from "./terminal-font";
import { createPortal } from "react-dom";
import { TerminalButton } from "./terminal-button";
import { terminalShortcutLabels } from "./terminal-shortcut-labels";
import {
  currentTerminalFontSize,
  subscribeTerminalFontSize,
  selectTerminalFontSize,
} from "./terminal-preferences";
import { showToast } from "@tidy/ui/toast";
import type { Project, DesktopAPI } from "../../../../shared/contracts/desktop";
import type { TerminalShortcut } from "../../../../shared/contracts/terminal";
import { terminalShortcut } from "../../../../shared/models/terminal-shortcuts";
import { useSessionState } from "../../app/session-state";
import { TerminalSurface } from "./terminal-surface";
import { currentTerminalTheme, subscribeTerminalTheme } from "./terminal-theme";
import {
  emptyTerminals,
  terminalState,
  terminalStateSchema,
  type TerminalAction,
  type TerminalState,
  type TerminalTab,
} from "./terminal-state";

function Glyph({ kind }: { kind: "terminal" | "plus" | "maximize" | "restore" | "close" }) {
  return (
    <svg
      aria-hidden="true"
      width="16"
      height="16"
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {kind === "terminal" ? (
        <>
          <rect x="2.5" y="3.5" width="15" height="13" rx="2" />
          <path d="m6 7 3 3-3 3m5 0h3" />
        </>
      ) : kind === "plus" ? (
        <path d="M10 4v12M4 10h12" />
      ) : kind === "close" ? (
        <path d="m6 6 8 8m0-8-8 8" />
      ) : kind === "maximize" ? (
        <path d="M7 3H3v4m10-4h4v4M3 13v4h4m10-4v4h-4" />
      ) : (
        <>
          <path d="M7 3v4H3m14 0h-4V3M3 13h4v4m6 0v-4h4" />
        </>
      )}
    </svg>
  );
}

function terminalHeightBounds(element: HTMLDivElement) {
  let maximum = window.innerHeight * 0.65;
  const thread = element.closest<HTMLElement>(".thread-workspace");
  if (thread) {
    const style = getComputedStyle(thread);
    let available =
      thread.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
    for (const child of thread.children) {
      if (!(child instanceof HTMLElement) || child.contains(element)) continue;
      const style = getComputedStyle(child);
      if (
        style.display === "none" ||
        style.display === "contents" ||
        style.position === "absolute" ||
        style.position === "fixed" ||
        Number(style.flexGrow) > 0
      )
        continue;
      available -=
        child.getBoundingClientRect().height +
        parseFloat(style.marginTop) +
        parseFloat(style.marginBottom);
    }
    maximum = Math.min(maximum, Math.max(0, available));
  }
  return { minimum: Math.min(140, maximum), maximum };
}

export function TerminalDock({
  api,
  projects,
  project,
  threadScope,
  available,
  ready,
  active,
  home,
  dockHome,
  fullscreen,
  onFullscreenChange,
  onOpenRemoteSettings,
}: {
  api: DesktopAPI;
  projects: Project[];
  project?: Project;
  threadScope?: { threadId: string; threadProjectId: string };
  available: boolean;
  ready: boolean;
  active: boolean;
  home: HTMLElement | null;
  dockHome: HTMLElement | null;
  fullscreen: boolean;
  onFullscreenChange(value: boolean): void;
  onOpenRemoteSettings?(): void;
}) {
  const [portalHome] = useState(() => {
    const element = document.createElement("div");
    element.className = "terminal-dock-home contents";
    return element;
  });
  useLayoutEffect(() => {
    if (!dockHome) return;
    const focused = document.activeElement;
    dockHome.append(portalHome);
    if (focused instanceof HTMLElement && portalHome.contains(focused))
      focused.focus({ preventScroll: true });
  }, [dockHome, portalHome]);
  useLayoutEffect(() => () => portalHome.remove(), [portalHome]);
  const theme = useSyncExternalStore(subscribeTerminalTheme, currentTerminalTheme);
  const fontSize = useSyncExternalStore(subscribeTerminalFontSize, currentTerminalFontSize);
  const [state, setState] = useSessionState<TerminalState>("terminals", terminalStateSchema, {});
  const latestState = useRef(state);
  const dispatch = (action: TerminalAction) => {
    const next = terminalState(latestState.current, action);
    if (next === latestState.current) return;
    latestState.current = next;
    setState(next);
  };
  const [height, setHeight] = useState(300);
  const [focusTerminal, setFocusTerminal] = useState(true);
  const dock = useRef<HTMLDivElement>(null);
  const launcher = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    const element = dock.current;
    if (!element) return;
    const update = () => {
      const separator = element.querySelector('[role="separator"]');
      const actualHeight = Math.round(element.getBoundingClientRect().height);
      if (!separator || !actualHeight) return;
      const { minimum, maximum } = terminalHeightBounds(element);
      separator.setAttribute("aria-valuenow", String(actualHeight));
      separator.setAttribute("aria-valuemin", String(Math.min(actualHeight, Math.round(minimum))));
      separator.setAttribute("aria-valuemax", String(Math.round(maximum)));
    };
    const observer = new ResizeObserver(update);
    observer.observe(element);
    const thread = element.closest(".thread-workspace");
    if (thread) {
      observer.observe(thread);
      for (const child of thread.children) observer.observe(child);
    }
    window.addEventListener("resize", update);
    update();
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", update);
    };
  }, [fullscreen, dockHome]);
  const focusReported = useRef(false);
  const valid = Boolean(project && !project.cloud && available && api.terminal);
  const current = project ? (state[project.id] ?? emptyTerminals) : emptyTerminals;
  const open = valid && current.open && active;
  const tabs = Object.values(state).flatMap((value) => value.tabs);
  const mac = navigator.platform.includes("Mac");
  const keys = terminalShortcutLabels(mac);
  useEffect(() => {
    if (!ready) return;
    dispatch({
      kind: "prune",
      projects: [...projects.map((value) => value.id), ...(project ? [project.id] : [])],
    });
  }, [projects, project, ready]);
  useLayoutEffect(() => {
    if (!open && fullscreen) onFullscreenChange(false);
  }, [open, fullscreen, onFullscreenChange]);
  useLayoutEffect(() => {
    if (!open || !focusTerminal || !current.selected) return;
    const input = document.querySelector<HTMLElement>(
      `#terminal-panel-${current.selected} textarea`,
    );
    (input ?? document.getElementById(`terminal-tab-${current.selected}`))?.focus({
      preventScroll: true,
    });
  }, [open, current.selected, focusTerminal]);

  useLayoutEffect(() => {
    if (open && current.selected)
      document
        .getElementById(`terminal-tab-${current.selected}`)
        ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [open, current.selected]);

  const hide = () => {
    if (!project) return;
    dispatch({ kind: "hide", projectId: project.id });
    onFullscreenChange(false);
    launcher.current?.focus({ preventScroll: true });
  };
  const create = () => {
    if (!valid || !project) return;
    if (tabs.length >= 8) {
      showToast("Close a terminal tab before opening another.");
      return;
    }
    setFocusTerminal(true);
    dispatch({ kind: "new", projectId: project.id, id: crypto.randomUUID(), ...threadScope });
  };
  const toggle = () => {
    if (open) hide();
    else if (!current.tabs.length) create();
    else if (project) {
      setFocusTerminal(true);
      dispatch({ kind: "show", projectId: project.id });
    }
  };
  const close = (tab: TerminalTab) => {
    const index = (state[tab.projectId]?.tabs ?? []).findIndex((value) => value.id === tab.id);
    dispatch({ kind: "close", projectId: tab.projectId, id: tab.id });
    if (tab.projectId === project?.id && current.tabs.length === 1) {
      onFullscreenChange(false);
      launcher.current?.focus();
    } else setFocusTerminal(true);
    void api.terminal?.end({ projectId: tab.projectId, terminalId: tab.id }).catch(() => {
      dispatch({ kind: "restore", projectId: tab.projectId, tab, index });
      showToast(
        "Could not close the terminal. Its tab was restored; reconnect the machine and try again.",
      );
    });
  };
  const select = (id: string, keyboardTabs = false) => {
    if (!project) return;
    setFocusTerminal(!keyboardTabs);
    dispatch({ kind: "select", projectId: project.id, id });
    if (keyboardTabs) document.getElementById(`terminal-tab-${id}`)?.focus();
    else if (id === current.selected)
      document.querySelector<HTMLElement>(`#terminal-panel-${id} textarea`)?.focus();
  };
  const shortcut = (action: TerminalShortcut) => {
    if (!valid || !active) return;
    if (document.querySelector("dialog:modal") && !dock.current?.contains(document.activeElement))
      return;
    if (action === "toggle") {
      toggle();
      return;
    }
    if (action === "new") {
      create();
      return;
    }
    if (!open) return;
    if (action.startsWith("zoom-")) {
      const size = currentTerminalFontSize();
      if (
        !selectTerminalFontSize(
          action === "zoom-reset"
            ? terminalFont.default
            : Math.max(
                terminalFont.min,
                Math.min(terminalFont.max, size + (action === "zoom-in" ? 1 : -1)),
              ),
        )
      )
        showToast("Text size changed for this session, but could not be remembered.");
      return;
    }
    if (action === "close") {
      const tab = current.tabs.find((tab) => tab.id === current.selected);
      if (tab) close(tab);
    } else if (action === "maximize") onFullscreenChange(!fullscreen);
    else {
      const index =
        action === "next" || action === "previous"
          ? (current.tabs.findIndex((tab) => tab.id === current.selected) +
              (action === "next" ? 1 : -1) +
              current.tabs.length) %
            current.tabs.length
          : Number(action.slice(-1)) - 1;
      if (current.tabs[index]) select(current.tabs[index].id);
    }
  };
  const actions = useRef(shortcut);
  useLayoutEffect(() => {
    actions.current = shortcut;
  });
  useEffect(() => {
    const reportFocus = () => {
      const focused = Boolean(
        dock.current && !dock.current.hidden && dock.current.contains(document.activeElement),
      );
      if (focused !== focusReported.current) {
        focusReported.current = focused;
        api.terminal?.focus?.(focused);
      }
    };
    const afterFocus = () => queueMicrotask(reportFocus);
    document.addEventListener("focusin", reportFocus);
    document.addEventListener("focusout", afterFocus);
    // Native handling prevents menu accelerators (especially Cmd+W) from closing the window.
    const stop = api.terminal?.onShortcut?.((action) => actions.current(action));
    api.terminal?.focus?.(false);
    focusReported.current = false;
    reportFocus();
    return () => {
      document.removeEventListener("focusin", reportFocus);
      document.removeEventListener("focusout", afterFocus);
      stop?.();
      api.terminal?.focus?.(false);
      focusReported.current = false;
    };
  }, [api, open]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.isComposing) return;
      if (
        event.target instanceof Element &&
        event.target.closest("dialog:modal") &&
        !dock.current?.contains(event.target)
      )
        return;
      const focused = Boolean(dock.current?.contains(event.target as Node));
      const action = terminalShortcut(
        {
          code: event.code,
          key: event.key,
          control: event.ctrlKey,
          meta: event.metaKey,
          alt: event.altKey,
          shift: event.shiftKey,
        },
        focused,
        mac,
      );
      if (!action || !active || !valid || (event.repeat && !action.startsWith("zoom-"))) return;
      event.preventDefault();
      event.stopPropagation();
      actions.current(action);
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, [active, valid, mac]);

  return createPortal(
    <>
      {home &&
        valid &&
        createPortal(
          <TerminalButton
            ref={launcher}
            className="terminal-launcher terminal-icon-button"
            tooltip="Toggle terminal"
            shortcut={keys.toggle}
            aria-label="Toggle terminal"
            aria-expanded={open}
            aria-controls="workspace-terminal"
            onClick={toggle}
          >
            <Glyph kind="terminal" />
          </TerminalButton>,
          home,
        )}
      <div
        ref={dock}
        id="workspace-terminal"
        className={`terminal-dock order-1 ${fullscreen ? "terminal-dock-fullscreen" : ""}`}
        hidden={!open}
        style={!fullscreen ? { height: `min(${height}px, 65vh)` } : undefined}
      >
        {!fullscreen && (
          <div
            className="terminal-resize"
            role="separator"
            tabIndex={0}
            aria-label="Resize terminal"
            aria-orientation="horizontal"
            onKeyDown={(event) => {
              if (event.key === "ArrowUp" || event.key === "ArrowDown") {
                event.preventDefault();
                const element = dock.current;
                if (!element) return;
                const { minimum, maximum } = terminalHeightBounds(element);
                setHeight(
                  Math.max(
                    minimum,
                    Math.min(
                      maximum,
                      element.getBoundingClientRect().height + (event.key === "ArrowUp" ? 24 : -24),
                    ),
                  ),
                );
              }
            }}
            onPointerDown={(event) => {
              if (event.button !== 0) return;
              const target = event.currentTarget;
              const startY = event.clientY;
              const element = dock.current;
              if (!element) return;
              const startHeight = element.getBoundingClientRect().height;
              target.setPointerCapture(event.pointerId);
              const move = (next: PointerEvent) => {
                const { minimum, maximum } = terminalHeightBounds(element);
                setHeight(
                  Math.max(minimum, Math.min(maximum, startHeight + startY - next.clientY)),
                );
              };
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
          <div
            className="terminal-tabs"
            role="tablist"
            aria-label="Terminal tabs"
            onKeyDown={(event) => {
              let index = current.tabs.findIndex((tab) => tab.id === current.selected);
              if (event.key === "ArrowRight") index = (index + 1) % current.tabs.length;
              else if (event.key === "ArrowLeft")
                index = (index - 1 + current.tabs.length) % current.tabs.length;
              else if (event.key === "Home") index = 0;
              else if (event.key === "End") index = current.tabs.length - 1;
              else return;
              event.preventDefault();
              if (current.tabs[index]) select(current.tabs[index].id, true);
            }}
          >
            {current.tabs.map((tab, index) => (
              <div
                key={tab.id}
                className={`terminal-tab-item ${current.selected === tab.id ? "terminal-tab-selected" : ""}`}
              >
                <TerminalButton
                  role="tab"
                  id={`terminal-tab-${tab.id}`}
                  className="terminal-tab"
                  aria-selected={current.selected === tab.id}
                  aria-controls={`terminal-panel-${tab.id}`}
                  tabIndex={current.selected === tab.id ? 0 : -1}
                  tooltip={tab.title}
                  shortcut={keys.tab(index)}
                  onClick={() => select(tab.id)}
                >
                  <span>{tab.title}</span>
                </TerminalButton>
                <TerminalButton
                  className="terminal-tab-close terminal-icon-button"
                  aria-label={`Close ${tab.title}`}
                  tooltip={`Close ${tab.title}`}
                  shortcut={keys.close}
                  tabIndex={current.selected === tab.id ? 0 : -1}
                  onClick={() => close(tab)}
                >
                  <Glyph kind="close" />
                </TerminalButton>
              </div>
            ))}
          </div>
          <TerminalButton
            className="terminal-icon-button"
            aria-label="New terminal tab"
            tooltip="New terminal tab"
            shortcut={`${keys.new} / ${keys.newGlobal}`}
            onClick={create}
          >
            <Glyph kind="plus" />
          </TerminalButton>
          <div className="terminal-toolbar-spacer" />
          <TerminalButton
            className="terminal-icon-button"
            aria-label={fullscreen ? "Restore terminal" : "Full screen terminal"}
            aria-pressed={fullscreen}
            tooltip={`${fullscreen ? "Restore" : "Full screen"} terminal`}
            shortcut={keys.maximize}
            onClick={() => onFullscreenChange(!fullscreen)}
          >
            <Glyph kind={fullscreen ? "restore" : "maximize"} />
          </TerminalButton>
          <TerminalButton
            className="terminal-icon-button"
            aria-label="Hide terminal"
            tooltip="Hide terminal"
            shortcut={keys.toggle}
            onClick={hide}
          >
            <Glyph kind="close" />
          </TerminalButton>
        </div>
        <div className="terminal-sessions">
          {api.terminal &&
            ready &&
            tabs.map((tab) => (
              <TerminalSurface
                key={tab.id}
                api={api.terminal!}
                onOpenRemoteSettings={onOpenRemoteSettings}
                projectId={tab.projectId}
                terminalId={tab.id}
                threadId={tab.threadId}
                threadProjectId={tab.threadProjectId}
                active={open && tab.id === current.selected && tab.projectId === project?.id}
                focusOnActivate={focusTerminal}
                fontSize={fontSize}
                theme={theme}
                copy={api.browser?.copy}
                onTitle={(title) =>
                  dispatch({ kind: "title", projectId: tab.projectId, id: tab.id, title })
                }
              />
            ))}
        </div>
      </div>
    </>,
    portalHome,
  );
}
