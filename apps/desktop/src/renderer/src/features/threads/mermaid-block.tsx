import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { Button } from "@tidy/ui/button";
import { Dialog } from "@tidy/editor/components/ui/dialog";
import { currentThemePreference, subscribeTheme } from "../../theme";
import { ClipboardCopyButton } from "./message-copy-button";
import { mermaidSourceError } from "./mermaid-source";
import type { DiagramImage } from "./mermaid-image";
import { MermaidRenderError } from "./mermaid-error";

type DiagramState =
  | { kind: "pending" }
  | { kind: "ready"; image: DiagramImage; source: string; dark: boolean }
  | { kind: "error"; message: string; retryable: boolean; source: string; dark: boolean };

function isDark() {
  const preference = currentThemePreference();
  return (
    preference === "dark" ||
    (preference === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches)
  );
}

function subscribeAppearance(listener: () => void) {
  const stop = subscribeTheme(listener);
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  media.addEventListener("change", listener);
  return () => {
    stop();
    media.removeEventListener("change", listener);
  };
}

export function MermaidBlock({ text, children }: { text: string; children: ReactNode }) {
  const dark = useSyncExternalStore(subscribeAppearance, isDark, () => false);
  const [showCode, setShowCode] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<DiagramState>({ kind: "pending" });
  const [expandedSource, setExpandedSource] = useState<string | null>(null);
  const [visible, setVisible] = useState(false);
  if (expandedSource !== null && expandedSource !== text) setExpandedSource(null);
  const completed = useRef<DiagramState>({ kind: "pending" });
  const host = useRef<HTMLDivElement>(null);
  const expandButton = useRef<HTMLButtonElement>(null);
  const error = useMemo(() => mermaidSourceError(text), [text]);

  useEffect(() => {
    if (!host.current) return;
    const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting), {
      rootMargin: "200px",
    });
    observer.observe(host.current);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (error || !visible || showCode) return;
    const previous = completed.current;
    if (previous.kind === "ready" && previous.source === text && previous.dark === dark) {
      setState(previous);
      return;
    }
    const controller = new AbortController();
    setState((previous) =>
      previous.kind === "ready" && previous.source === text ? previous : { kind: "pending" },
    );
    void import("./mermaid-renderer")
      .then(({ renderMermaid }) => renderMermaid({ source: text, dark, signal: controller.signal }))
      .then(
        (image) => {
          if (!controller.signal.aborted) {
            const ready = { kind: "ready", image, source: text, dark } satisfies DiagramState;
            completed.current = ready;
            setState(ready);
          }
        },
        (cause: unknown) => {
          if (!controller.signal.aborted)
            setState({
              kind: "error",
              message:
                cause instanceof MermaidRenderError
                  ? cause.message
                  : "Couldn’t render this diagram. Retry or copy the source below.",
              retryable: !(cause instanceof MermaidRenderError),
              source: text,
              dark,
            });
        },
      );
    return () => controller.abort();
  }, [text, dark, visible, showCode, attempt, error]);

  const current =
    state.kind !== "pending" && state.source === text ? state : ({ kind: "pending" } as const);
  const image = current.kind === "ready" ? current.image : null;
  const message = error || (current.kind === "error" ? current.message : null);
  const sourceVisible = showCode || !!message || !image;
  return (
    <div className="markdown-code-block markdown-mermaid" ref={host} dir="ltr">
      <div className="markdown-code-header">
        <span className="markdown-code-language">mermaid</span>
        <div className="markdown-code-actions" role="toolbar" aria-label="Diagram actions">
          {!message && (image || showCode) && (
            <Button
              className="markdown-diagram-action"
              aria-pressed={showCode}
              onClick={() => setShowCode(!showCode)}
            >
              {showCode ? "Diagram" : "Code"}
            </Button>
          )}
          {!sourceVisible && (
            <Button
              ref={expandButton}
              className="markdown-diagram-action"
              aria-haspopup="dialog"
              onClick={() => setExpandedSource(text)}
            >
              Expand
            </Button>
          )}
          {current.kind === "error" && current.retryable && !error && (
            <Button
              className="markdown-diagram-action"
              onClick={() => {
                setShowCode(false);
                setAttempt(attempt + 1);
              }}
            >
              Retry
            </Button>
          )}
          <ClipboardCopyButton
            label="Copy code"
            copiedDurationMs={1000}
            onCopy={() => navigator.clipboard.writeText(text)}
          />
        </div>
      </div>
      {message && (
        <p className="markdown-diagram-status" role="status">
          {message}
        </p>
      )}
      {!showCode && !message && current.kind === "pending" && (
        <p className="markdown-diagram-status" role="status">
          Drawing diagram…
        </p>
      )}
      {sourceVisible ? (
        <pre tabIndex={0} role="region" aria-label="mermaid code">
          {children}
        </pre>
      ) : (
        image && (
          <div
            className="markdown-diagram-inline"
            tabIndex={0}
            role="region"
            aria-label="Diagram preview"
          >
            <img
              src={image.url}
              width={image.width}
              height={image.height}
              alt={image.description}
            />
          </div>
        )
      )}
      {expandedSource === text &&
        image &&
        createPortal(
          <DiagramDialog
            image={image}
            onClose={() => {
              setExpandedSource(null);
              expandButton.current?.focus({ preventScroll: true });
            }}
          />,
          document.body,
        )}
    </div>
  );
}

function DiagramDialog({ image, onClose }: { image: DiagramImage; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  const [zoom, setZoom] = useState<number | null>(1);
  const [availableWidth, setAvailableWidth] = useState(800);
  const fit = Math.min(1, Math.max(1, availableWidth - 48) / image.width);
  const scale = zoom ?? fit;
  useLayoutEffect(() => {
    dialog.current?.showModal();
    closeButton.current?.focus();
    const element = viewport.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setAvailableWidth(element.clientWidth));
    observer.observe(element);
    setAvailableWidth(element.clientWidth);
    return () => observer.disconnect();
  }, []);
  return (
    <Dialog
      ref={dialog}
      size="wide"
      padded={false}
      className="markdown-diagram-dialog"
      aria-label="Expanded diagram"
      onClose={onClose}
    >
      <div className="markdown-diagram-toolbar" role="toolbar" aria-label="Diagram view">
        <Button
          className="markdown-diagram-action"
          aria-label="Zoom out"
          disabled={scale <= 0.1}
          onClick={() => setZoom(Math.max(0.1, scale / 1.25))}
        >
          −
        </Button>
        <span className="markdown-diagram-zoom" aria-live="polite">
          {Math.round(scale * 100)}%
        </span>
        <Button
          className="markdown-diagram-action"
          aria-label="Zoom in"
          disabled={scale >= 4}
          onClick={() => setZoom(Math.min(4, scale * 1.25))}
        >
          +
        </Button>
        <Button className="markdown-diagram-action" onClick={() => setZoom(null)}>
          Fit width
        </Button>
        <Button className="markdown-diagram-action" onClick={() => setZoom(1)}>
          Actual size
        </Button>
        <Button
          className="markdown-diagram-action"
          ref={closeButton}
          autoFocus
          onClick={() => dialog.current?.close()}
        >
          Close
        </Button>
      </div>
      <div
        ref={viewport}
        className="markdown-diagram-viewport"
        tabIndex={0}
        role="region"
        aria-label="Diagram"
        onPointerDown={(event) => {
          if (event.button !== 0 || event.pointerType !== "mouse") return;
          const element = event.currentTarget;
          drag.current = {
            x: event.clientX,
            y: event.clientY,
            left: element.scrollLeft,
            top: element.scrollTop,
          };
          element.setPointerCapture(event.pointerId);
          element.setAttribute("data-panning", "");
          element.focus({ preventScroll: true });
          event.preventDefault();
        }}
        onPointerMove={(event) => {
          if (!drag.current) return;
          event.currentTarget.scrollLeft = drag.current.left + drag.current.x - event.clientX;
          event.currentTarget.scrollTop = drag.current.top + drag.current.y - event.clientY;
        }}
        onPointerUp={(event) => event.currentTarget.releasePointerCapture(event.pointerId)}
        onLostPointerCapture={(event) => {
          drag.current = null;
          event.currentTarget.removeAttribute("data-panning");
        }}
      >
        <img
          src={image.url}
          style={{ width: image.width * scale, height: image.height * scale }}
          alt={image.description}
          draggable={false}
        />
      </div>
    </Dialog>
  );
}
