import { BrowserFileChooser, BrowserDownloads } from "./browser-files";
import { BrowserPageDialog } from "./browser-page-dialog";
import { BrowserGlyph, Glyph, BrowserIconButton, browserInputClass } from "./browser-controls";
import { BrowserPage } from "./browser-page";
import { useBrowserSession } from "./use-browser-session";
import type { BrowserNavigationRequest } from "./browser-navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@tidy/ui/button";
import {
  BrowserTabs,
  BrowserOptions,
  previewViewports,
  type PreviewViewport,
} from "./browser-toolbar";
import {
  browserURL,
  type BrowserAPI,
  type BrowserScope,
} from "../../../../shared/contracts/browser";
import "./browser-workspace.css";

const selectionExpression = `(() => { const el = document.activeElement; return el?.type === 'password' ? '' : el && typeof el.selectionStart === 'number' && typeof el.value === 'string' ? el.value.slice(el.selectionStart, el.selectionEnd) : window.getSelection()?.toString() || ''; })()`;

export function BrowserWorkspace({
  api,
  scope,
  open,
  active,
  connected,
  machineLabel,
  onClose,
  requestedURL,
}: {
  api: BrowserAPI;
  scope: BrowserScope;
  open: boolean;
  active: boolean;
  connected: boolean;
  machineLabel: string;
  onClose(): void;
  requestedURL?: BrowserNavigationRequest;
}) {
  const [address, setAddress] = useState("");
  const [viewport, setViewport] = useState<PreviewViewport>("responsive");
  const [expanded, setExpanded] = useState(false);
  const [downloadsOpen, setDownloadsOpen] = useState(false);
  const [consoleOpen, setConsoleOpen] = useState(false);
  const [consoleText, setConsoleText] = useState("");
  const [findOpen, setFindOpen] = useState(false);
  const [findText, setFindText] = useState("");
  const [findResult, setFindResult] = useState<"found" | "missing" | null>(null);
  const findInput = useRef<HTMLInputElement>(null);
  const findRequest = useRef(0);
  const addressInput = useRef<HTMLInputElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const surface = useRef<HTMLDivElement>(null);
  const pane = useRef<HTMLElement>(null);
  const resizing = useRef<{ pointerId: number; x: number; width: number } | null>(null);
  const keyboard = useRef<HTMLTextAreaElement>(null);
  const addressFocused = useRef(false);
  const addressTab = useRef<string | undefined>(undefined);
  const visible = open && active;
  const {
    state,
    stateRef,
    visibleRef,
    painted,
    error,
    setError,
    dismissedError,
    setDismissedError,
    disconnected,
    send,
    command,
    selectTab,
    closeTab,
    navigateURL,
  } = useBrowserSession({ api, scope, visible, canvas });
  const canInput = state.control === "you" && connected && !disconnected;
  const canNavigate =
    connected && !disconnected && (state.control === "you" || state.control === "available");
  const tab = state.tabs.find((tab) => tab.id === state.activeTabId);
  const canInteractPage = Boolean(
    canInput && tab && painted === `${tab.viewId}:${tab.width}:${tab.height}`,
  );
  const currentError = error || (state.phase.kind === "error" ? state.phase.message : tab?.error);

  useEffect(() => {
    const element = pane.current;
    if (!element) return;
    const observer = new ResizeObserver(() => {
      const separator = element.querySelector(".browser-resize-handle");
      if (!separator || !element.clientWidth) return;
      const width = Math.round(element.clientWidth);
      separator.setAttribute("aria-valuenow", String(width));
      separator.setAttribute(
        "aria-valuemax",
        String(Math.max(width, 320, (element.parentElement?.clientWidth ?? width) - 360)),
      );
      separator.setAttribute("aria-valuetext", `${width} pixels`);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    send({ kind: "visibility", visible });
    if (visible) addressInput.current?.focus();
  }, [visible, send]);

  useEffect(() => {
    if (addressTab.current !== tab?.id || !addressFocused.current)
      setAddress(tab?.url === "about:blank" ? "" : (tab?.url ?? ""));
    addressTab.current = tab?.id;
  }, [tab?.url, tab?.id]);

  useEffect(() => {
    findRequest.current++;
    setFindResult(null);
    setConsoleText("");
    setDismissedError(null);
  }, [tab?.id]);

  useEffect(() => {
    if (findOpen) {
      findInput.current?.focus();
      findInput.current?.select();
    }
  }, [findOpen]);

  useEffect(() => {
    const inactive = () => {
      send({ kind: "release-keys" });
      if (document.hidden) send({ kind: "visibility", visible: false });
      else send({ kind: "visibility", visible: visibleRef.current });
    };
    window.addEventListener("blur", inactive);
    document.addEventListener("visibilitychange", inactive);
    return () => {
      window.removeEventListener("blur", inactive);
      document.removeEventListener("visibilitychange", inactive);
    };
  }, [send]);

  useEffect(() => {
    if (!visible || !canInput || !tab || !surface.current) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let previous = "";
    const resize = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        const element = surface.current;
        if (!element) return;
        const { width, height } = previewViewports[viewport].size ?? {
          width: Math.max(320, Math.min(2560, Math.round(element.clientWidth))),
          height: Math.max(240, Math.min(1600, Math.round(element.clientHeight))),
        };
        const current = stateRef.current.tabs.find(
          (tab) => tab.id === stateRef.current.activeTabId,
        );
        if (current?.width === width && current.height === height) return;
        if (!width || !height || previous === `${width}:${height}`) return;
        previous = `${width}:${height}`;
        send({ kind: "resize", width, height });
      }, 100);
    };
    const observer = new ResizeObserver(resize);
    observer.observe(surface.current);
    resize();
    return () => {
      clearTimeout(timer);
      observer.disconnect();
    };
  }, [visible, canInput, tab?.id, tab?.width, tab?.height, viewport, send]);

  const refreshConsole = useCallback(async () => {
    const current = stateRef.current;
    const target = current.tabs.find((tab) => tab.id === current.activeTabId);
    if (!target) return;
    const result = await command({ kind: "console", tabId: target.id });
    if (stateRef.current.activeTabId === target.id) setConsoleText(result?.output ?? "");
  }, [command]);
  useEffect(() => {
    if (consoleOpen && connected && !disconnected) void refreshConsole();
  }, [consoleOpen, tab?.id, connected, disconnected, refreshConsole]);

  const creatingPreview = useRef(false);
  const [openingPreview, setOpeningPreview] = useState(false);
  const focusPreview = useRef<string | null>(null);
  const newTab = () => {
    if (!canNavigate || creatingPreview.current || stateRef.current.tabs.length >= 12) return;
    creatingPreview.current = true;
    setOpeningPreview(true);
    let focusAllowed = true;
    const cancelFocus = () => {
      focusAllowed = false;
    };
    const movedFocus = (event: FocusEvent) => {
      if (
        event.target instanceof Node &&
        event.target !== document.body &&
        !pane.current?.contains(event.target)
      )
        cancelFocus();
    };
    document.addEventListener("pointerdown", cancelFocus, { once: true });
    document.addEventListener("focusin", movedFocus);
    window.addEventListener("blur", cancelFocus, { once: true });
    void command({ kind: "open", url: "about:blank" }).then((result) => {
      document.removeEventListener("pointerdown", cancelFocus);
      document.removeEventListener("focusin", movedFocus);
      window.removeEventListener("blur", cancelFocus);
      focusPreview.current = focusAllowed ? (result?.state.activeTabId ?? null) : null;
      creatingPreview.current = false;
      setOpeningPreview(false);
    });
  };
  useEffect(() => {
    const target = focusPreview.current;
    if (openingPreview || !target) return;
    focusPreview.current = null;
    if (
      visibleRef.current &&
      stateRef.current.activeTabId === target &&
      (document.activeElement === document.body || pane.current?.contains(document.activeElement))
    )
      addressInput.current?.focus();
  }, [openingPreview]);
  const find = async (backwards = false) => {
    if (!tab || !findText.trim() || !canNavigate) return;
    const request = ++findRequest.current;
    const result = await command({ kind: "find", tabId: tab.id, text: findText, backwards });
    if (request === findRequest.current && stateRef.current.activeTabId === tab.id && result)
      setFindResult(result.output === "true" ? "found" : "missing");
  };
  const closeFind = () => {
    findRequest.current++;
    setFindOpen(false);
    keyboard.current?.focus();
  };

  const openedRequest = useRef<string | null>(null);
  useEffect(() => {
    if (
      !requestedURL ||
      !visible ||
      requestedURL.projectId !== scope.projectId ||
      requestedURL.threadId !== scope.threadId ||
      openedRequest.current === requestedURL.id
    )
      return;
    if (!canNavigate) {
      setAddress(requestedURL.url);
      return;
    }
    openedRequest.current = requestedURL.id;
    try {
      const url = browserURL(requestedURL.url);
      const existing = stateRef.current.tabs.find((tab) => tab.url === url);
      void command(existing ? { kind: "select", tabId: existing.id } : { kind: "open", url });
    } catch (error) {
      setError(error instanceof Error ? error.message : "Enter a valid address.");
    }
  }, [requestedURL, visible, canNavigate, command, scope.projectId, scope.threadId]);

  const navigate = () => {
    try {
      const url = browserURL(address);
      setAddress(url);
      addressInput.current?.blur();
      keyboard.current?.focus();
      navigateURL(url);
    } catch (error) {
      setError(error instanceof Error ? error.message : "Enter a valid address.");
    }
  };

  const copy = async () => {
    if (
      !tab ||
      !canInteractPage ||
      stateRef.current.tabs.find((current) => current.id === tab.id)?.viewId !== tab.viewId
    )
      return;
    const result = await command({
      kind: "evaluate",
      tabId: tab.id,
      expression: selectionExpression,
    });
    if (!result?.output) return;
    try {
      const text: unknown = JSON.parse(result.output);
      if (typeof text === "string") await api.copy(text);
    } catch {
      setError("The selected text could not be copied.");
    }
  };

  const loading = state.phase.kind === "installing" || state.phase.kind === "starting";
  return (
    <aside
      ref={pane}
      className={`browser-workspace ${expanded ? "browser-workspace-expanded" : ""}`}
      hidden={!open}
      aria-label="Browser"
      data-connected={connected && !disconnected}
      onKeyDownCapture={(event) => {
        if (event.nativeEvent.isComposing || (!event.metaKey && !event.ctrlKey) || event.altKey)
          return;
        const key = event.key.toLowerCase();
        if (!["l", "t", "w", "r", "f"].includes(key)) return;
        event.preventDefault();
        event.stopPropagation();
        if (key === "l") {
          addressInput.current?.focus();
          addressInput.current?.select();
        } else if (key === "f" && tab) {
          setFindOpen(true);
          findInput.current?.focus();
          findInput.current?.select();
        } else if (canNavigate) {
          if (key === "t" && state.tabs.length < 12) newTab();
          if (key === "w" && tab) closeTab(tab.id);
          if (key === "r" && tab)
            void command({ kind: "reload", tabId: tab.id, ignoreCache: event.shiftKey });
        }
      }}
    >
      <div
        className="browser-resize-handle absolute inset-y-0 left-0 z-3 w-[5px] cursor-col-resize touch-none"
        role="separator"
        aria-label="Resize browser pane"
        aria-valuemin={320}
        aria-valuemax={900}
        aria-valuenow={320}
        aria-orientation="vertical"
        tabIndex={0}
        onKeyDown={(event) => {
          const element = pane.current;
          if (!element || !["ArrowLeft", "ArrowRight", "Home"].includes(event.key)) return;
          event.preventDefault();
          const available = element.parentElement?.clientWidth ?? 1000;
          element.style.flexBasis = `${Math.max(320, Math.min(available - 360, event.key === "Home" ? available * 0.46 : element.clientWidth + (event.key === "ArrowLeft" ? 16 : -16)))}px`;
        }}
        onPointerDown={(event) => {
          if (resizing.current || !event.isPrimary || event.button !== 0 || !pane.current) return;
          event.preventDefault();
          event.currentTarget.setPointerCapture(event.pointerId);
          resizing.current = {
            pointerId: event.pointerId,
            x: event.clientX,
            width: pane.current.clientWidth,
          };
        }}
        onPointerMove={(event) => {
          const start = resizing.current,
            element = pane.current;
          if (!start || !element || start.pointerId !== event.pointerId) return;
          element.style.flexBasis = `${Math.max(320, Math.min((element.parentElement?.clientWidth ?? 1000) - 360, start.width + start.x - event.clientX))}px`;
        }}
        onPointerUp={(event) => {
          if (resizing.current?.pointerId === event.pointerId) {
            resizing.current = null;
            event.currentTarget.releasePointerCapture(event.pointerId);
          }
        }}
        onPointerCancel={() => {
          resizing.current = null;
        }}
      />
      <BrowserTabs
        state={state}
        disabled={!canNavigate}
        creating={openingPreview}
        expanded={expanded}
        onExpand={() => setExpanded((value) => !value)}
        onHide={onClose}
        onSelect={selectTab}
        onClose={closeTab}
        onNew={newTab}
      />
      <form
        className="browser-navigation flex shrink-0 items-center gap-0.5 border-b border-border px-2 pt-0.5 pb-2"
        onSubmit={(event) => {
          event.preventDefault();
          navigate();
        }}
      >
        <BrowserIconButton
          type="button"
          aria-label="Back"
          title="Back"
          disabled={!tab?.canGoBack || !canNavigate}
          onClick={() => {
            if (tab) void command({ kind: "back", tabId: tab.id });
          }}
        >
          <Glyph name="back" />
        </BrowserIconButton>
        <BrowserIconButton
          type="button"
          aria-label="Forward"
          title="Forward"
          disabled={!tab?.canGoForward || !canNavigate}
          onClick={() => {
            if (tab) void command({ kind: "forward", tabId: tab.id });
          }}
        >
          <Glyph name="forward" />
        </BrowserIconButton>
        <BrowserIconButton
          type="button"
          aria-label={tab?.loading ? "Stop loading" : "Reload page"}
          title={tab?.loading ? "Stop loading" : "Reload page"}
          disabled={!tab || !canNavigate}
          onClick={(event) => {
            if (tab)
              void command(
                tab.loading
                  ? { kind: "stop", tabId: tab.id }
                  : { kind: "reload", tabId: tab.id, ignoreCache: event.shiftKey },
              );
          }}
        >
          <Glyph name={tab?.loading ? "stop" : "reload"} />
        </BrowserIconButton>
        <input
          className={browserInputClass}
          ref={addressInput}
          value={address}
          onChange={(event) => setAddress(event.target.value)}
          onFocus={() => {
            addressFocused.current = true;
          }}
          onBlur={() => {
            addressFocused.current = false;
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.nativeEvent.isComposing) {
              event.preventDefault();
              navigate();
            } else if (event.key === "Escape") {
              setAddress(tab?.url ?? "");
              event.currentTarget.blur();
              keyboard.current?.focus();
            }
          }}
          placeholder="Enter a URL or localhost:3000"
          aria-label="Browser address"
          autoComplete="off"
          spellCheck={false}
          disabled={!canNavigate || loading || openingPreview}
        />
        {tab && (
          <Button
            type="button"
            className="browser-control-button cursor-pointer rounded border border-border bg-surface px-[7px] py-[3px] text-[11px] whitespace-nowrap text-secondary-ink"
            disabled={!connected || disconnected}
            title={state.control === "you" ? "Release browser control" : "Take browser control"}
            onClick={() =>
              send({ kind: state.control === "you" ? "release-control" : "take-control" })
            }
          >
            {state.control === "you" ? "Release" : "Take control"}
          </Button>
        )}
        <BrowserOptions
          state={state}
          connected={connected && !disconnected}
          machineLabel={machineLabel}
          viewport={viewport}
          onViewportChange={setViewport}
          canCopy={canInteractPage}
          consoleOpen={consoleOpen}
          onFind={() => setFindOpen(true)}
          onCopy={() => void copy()}
          onConsole={() => setConsoleOpen((value) => !value)}
          onDownloads={() => {
            setDownloadsOpen((value) => !value);
            setConsoleOpen(false);
          }}
        />
      </form>
      {currentError && currentError !== dismissedError && (
        <div
          className="browser-error flex shrink-0 items-center gap-2 border-y border-border py-1.5 pr-2 pl-3 text-[11px] text-secondary-ink"
          role="alert"
        >
          <span className="max-h-[65px] flex-1 overflow-auto leading-normal wrap-anywhere">
            {currentError}
          </span>
          <BrowserIconButton
            type="button"
            aria-label="Dismiss browser error"
            onClick={() => {
              setDismissedError(currentError);
            }}
          >
            <Glyph name="close" />
          </BrowserIconButton>
        </div>
      )}
      {findOpen && tab && (
        <form
          className="browser-find flex shrink-0 items-center gap-0.5 border-b border-border px-2 py-1.5"
          onSubmit={(event) => {
            event.preventDefault();
            void find();
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              closeFind();
            } else if (event.key === "Enter" && event.shiftKey) {
              event.preventDefault();
              void find(true);
            }
          }}
        >
          <input
            className={browserInputClass}
            ref={findInput}
            aria-label="Find in page"
            placeholder="Find in page"
            value={findText}
            maxLength={256}
            onChange={(event) => {
              findRequest.current++;
              setFindText(event.target.value);
              setFindResult(null);
            }}
          />
          <span className="shrink-0 text-[10px] text-secondary-ink" role="status">
            {findResult === "missing" ? "No matches" : findResult === "found" ? "Found" : ""}
          </span>
          <BrowserIconButton
            type="button"
            aria-label="Previous match"
            disabled={!canNavigate || !findText.trim()}
            onClick={() => void find(true)}
          >
            <Glyph name="back" />
          </BrowserIconButton>
          <BrowserIconButton
            type="button"
            aria-label="Next match"
            disabled={!canNavigate || !findText.trim()}
            onClick={() => void find()}
          >
            <Glyph name="forward" />
          </BrowserIconButton>
          <BrowserIconButton type="button" aria-label="Close find" onClick={closeFind}>
            <Glyph name="close" />
          </BrowserIconButton>
        </form>
      )}
      {state.fileChooser && (
        <BrowserFileChooser
          key={state.fileChooser.id}
          chooser={state.fileChooser}
          enabled={canInput}
          command={command}
          setError={setError}
        />
      )}
      <div
        className="browser-surface relative flex min-h-0 flex-1 items-start justify-center overflow-auto bg-surface [container-type:size]"
        ref={surface}
        data-viewport={viewport}
        data-interactive={Boolean(canInteractPage)}
      >
        <BrowserPage
          editingCommands={state.keyboardCommands === true}
          api={api}
          scope={scope}
          tab={tab}
          interactive={canInteractPage}
          canvas={canvas}
          keyboard={keyboard}
          addressInput={addressInput}
          painted={Boolean(painted)}
          copy={copy}
          setError={setError}
          send={send}
        />
        {(!tab || tab.url === "about:blank") && (
          <div className="browser-empty absolute inset-0 flex flex-col items-center justify-center gap-[9px] p-6 text-center text-muted-ink">
            <span className="browser-empty-icon mb-[7px] grid size-[52px] place-items-center rounded-xl border border-border bg-panel">
              <BrowserGlyph size={27} />
            </span>
            <p className="m-0 text-[15px] font-medium text-ink">
              {loading
                ? state.phase.kind === "installing"
                  ? "Preparing your browser"
                  : "Starting browser…"
                : "No preview yet"}
            </p>
            <span className="max-w-[250px] leading-[1.6]">
              {loading
                ? "This happens once on this machine."
                : "Enter a URL above to open a preview."}
            </span>
            {state.phase.kind === "installing" && (
              <progress aria-label="Browser download" value={state.phase.progress} max={1} />
            )}
          </div>
        )}
        {tab && tab.url !== "about:blank" && (!painted || (canInput && !canInteractPage)) && (
          <div
            className="browser-waiting absolute inset-x-0 top-5 text-center text-muted-ink"
            role="status"
          >
            {painted ? "Updating preview…" : "Connecting to page…"}
          </div>
        )}
        {(!connected || disconnected) && (
          <div
            className="browser-reconnecting absolute right-3 bottom-3 left-3 flex flex-wrap items-center gap-2 rounded-[7px] border border-border bg-panel p-3 shadow-[0_4px_16px_#0000000a]"
            role="status"
          >
            <span className="browser-connection-dot size-[5px] shrink-0 rounded-full bg-muted-ink" />
            Reconnecting to {machineLabel}…
            <small className="basis-full pl-[13px] text-muted-ink">
              Your tabs stay on the host.
            </small>
          </div>
        )}
        {state.dialog && (
          <BrowserPageDialog
            key={state.dialog.id}
            dialog={state.dialog}
            enabled={canInput}
            send={send}
            keyboard={keyboard}
            error={error}
          />
        )}
      </div>
      <BrowserDownloads
        downloads={state.downloads}
        open={downloadsOpen}
        connected={connected && !disconnected}
        api={api}
        command={command}
        setError={setError}
      />
      {consoleOpen && (
        <div className="browser-console flex-[0_0_160px] overflow-auto border-t border-border px-3 pt-[5px] pb-2.5">
          <header className="flex items-center justify-between text-secondary-ink">
            <span>Console</span>
            <BrowserIconButton
              type="button"
              aria-label="Refresh console"
              disabled={!connected || disconnected || !tab}
              onClick={() => void refreshConsole()}
            >
              <Glyph name="reload" />
            </BrowserIconButton>
          </header>
          <pre className="m-0 font-mono text-[11px] leading-[1.6] whitespace-pre-wrap text-secondary-ink wrap-anywhere">
            {consoleText || "No console messages."}
          </pre>
        </div>
      )}
    </aside>
  );
}
