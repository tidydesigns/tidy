import { loadChatImage } from "./load-chat-image";
import { useEffect, useRef, useState } from "react";
import { Button } from "@tidy/ui/button";
import { MediaViewer, mediaViewerControlClassName } from "./media-viewer";
import type { DesktopAPI } from "../../../shared/contracts/desktop";

export function ImageViewer({
  src,
  name,
  onClose,
}: {
  src: string;
  name: string;
  onClose(): void;
}) {
  const [zoomed, setZoomed] = useState(false);
  const [failedSource, setFailedSource] = useState<string | null>(null);
  const failed = failedSource === src;
  return (
    <MediaViewer
      kind="image"
      name={name}
      onClose={onClose}
      actions={
        !failed && (
          <Button
            className={`${mediaViewerControlClassName} px-[12px] py-[6px] text-xs leading-normal`}
            onClick={() => setZoomed((value) => !value)}
            aria-pressed={zoomed}
          >
            {zoomed ? "Fit to screen" : "Actual size"}
          </Button>
        )
      }
    >
      {failed ? (
        <div className="m-auto p-6 text-center text-sm text-muted-ink" role="status">
          Image unavailable
        </div>
      ) : (
        <img
          src={src}
          alt={name.trim() || "Image preview"}
          onError={() => setFailedSource(src)}
          className={
            zoomed
              ? "media-viewer-image m-auto max-w-none shrink-0 self-start rounded-[4px]"
              : "media-viewer-image m-auto max-h-full max-w-full rounded-[4px] object-contain"
          }
        />
      )}
    </MediaViewer>
  );
}

export function ImagePreview({
  src,
  name,
  compact = false,
  onError,
}: {
  src: string;
  name: string;
  compact?: boolean;
  onError?(): void;
}) {
  const displayName = name.trim() || "Image";
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [failedSource, setFailedSource] = useState<string | null>(null);
  const failed = failedSource === src;
  return (
    <>
      <Button
        ref={trigger}
        type="button"
        aria-label={`Preview ${displayName}`}
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
        disabled={failed}
        className={`chat-image-preview inline-flex max-w-full cursor-zoom-in flex-col overflow-hidden rounded-lg border border-border bg-panel align-top text-left hover:border-muted-ink focus-visible:outline-2 focus-visible:outline-offset-2 ${compact ? "size-18" : "my-2 w-80"}`}
      >
        {failed ? (
          <span className="p-3 text-xs text-muted-ink">Image unavailable · {displayName}</span>
        ) : (
          <img
            src={src}
            alt={displayName}
            loading="lazy"
            decoding="async"
            onError={() => {
              setFailedSource(src);
              onError?.();
            }}
            className={
              compact ? "size-full object-cover" : "h-44 w-full object-contain bg-subtle-fill"
            }
          />
        )}
      </Button>
      {open && (
        <ImageViewer
          src={src}
          name={displayName}
          onClose={() => {
            setOpen(false);
            trigger.current?.focus({ preventScroll: true });
          }}
        />
      )}
    </>
  );
}

export function ChatImage({
  api,
  projectId,
  threadId,
  href,
  name,
  active,
}: {
  api: DesktopAPI;
  projectId: string;
  threadId: string;
  href: string;
  name: string;
  active: boolean;
}) {
  const loaded = useRef<{ api: DesktopAPI; key: string } | null>(null);
  const container = useRef<HTMLSpanElement>(null);
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<
    { kind: "loading" } | { kind: "ready"; src: string } | { kind: "failed" }
  >({ kind: "loading" });
  useEffect(() => {
    if (!active) return;
    const key = JSON.stringify([projectId, threadId, href]);
    if (loaded.current?.api === api && loaded.current.key === key) return;
    let current = true;
    let release: (() => void) | undefined;
    setState({ kind: "loading" });
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        observer.disconnect();
        const load = loadChatImage(api, { projectId, threadId, href });
        release = load.release;
        void load.promise.then(
          (src) => {
            if (current) {
              loaded.current = { api, key };
              setState({ kind: "ready", src });
            }
          },
          () => {
            if (current) setState({ kind: "failed" });
          },
        );
      },
      { rootMargin: "200px" },
    );
    if (container.current) observer.observe(container.current);
    return () => {
      current = false;
      release?.();
      observer.disconnect();
    };
  }, [api, projectId, threadId, href, attempt, active]);
  return (
    <span ref={container} className="block max-w-full">
      {state.kind === "ready" ? (
        <ImagePreview
          key={state.src}
          src={state.src}
          name={name}
          onError={() => {
            loaded.current = null;
            setState({ kind: "failed" });
          }}
        />
      ) : (
        <span
          className="my-2 inline-flex h-56 w-80 max-w-full flex-col items-center justify-center gap-2 rounded-lg border border-border bg-subtle-fill px-3 text-xs text-muted-ink"
          role="status"
        >
          <span>{state.kind === "failed" ? "Image unavailable" : "Loading image…"}</span>
          <span className="max-w-full truncate">{name}</span>
          {state.kind === "failed" && (
            <Button
              className="cursor-pointer rounded border border-border bg-panel px-3 py-1 text-ink hover:bg-hover-surface"
              onClick={() => setAttempt((value) => value + 1)}
            >
              Retry image
            </Button>
          )}
        </span>
      )}
    </span>
  );
}
