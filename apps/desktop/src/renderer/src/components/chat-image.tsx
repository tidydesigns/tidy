import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Button } from "@tidy/ui/button";
import { Dialog } from "@tidy/editor/components/ui/dialog";
import type { DesktopAPI } from "../../../shared/contracts/desktop";

function ImageViewer({ src, name, onClose }: { src: string; name: string; onClose(): void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [zoomed, setZoomed] = useState(false);
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  return createPortal(
    <Dialog
      ref={dialog}
      padded={false}
      size="wide"
      aria-label={name}
      onClose={onClose}
      className="image-viewer flex h-[calc(100dvh-2rem)] max-h-none max-w-none flex-col"
    >
      <div className="flex shrink-0 items-center gap-3 border-b border-border px-4 py-3">
        <span className="min-w-0 flex-1 truncate text-sm">{name}</span>
        <Button
          className="cursor-pointer rounded px-2 py-1 text-xs hover:bg-hover-surface"
          onClick={() => setZoomed(!zoomed)}
          aria-pressed={zoomed}
        >
          {zoomed ? "Fit to screen" : "Actual size"}
        </Button>
        <Button
          className="cursor-pointer rounded px-2 py-1 text-sm hover:bg-hover-surface"
          aria-label="Close image preview"
          onClick={() => dialog.current?.close()}
        >
          ×
        </Button>
      </div>
      <div className="flex min-h-0 flex-1 overflow-auto bg-subtle-fill p-4">
        <img
          src={src}
          alt={name}
          className={
            zoomed
              ? "m-auto max-w-none shrink-0 self-start"
              : "m-auto max-h-full max-w-full object-contain"
          }
        />
      </div>
    </Dialog>,
    document.body,
  );
}

export function ImagePreview({
  src,
  name,
  compact = false,
}: {
  src: string;
  name: string;
  compact?: boolean;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [failed, setFailed] = useState(false);
  return (
    <>
      <Button
        ref={trigger}
        type="button"
        aria-label={`Preview ${name}`}
        onClick={() => setOpen(true)}
        disabled={failed}
        className={`chat-image-preview inline-flex max-w-full cursor-zoom-in flex-col overflow-hidden rounded-lg border border-border bg-panel align-top text-left hover:border-muted-ink focus-visible:outline-2 focus-visible:outline-offset-2 ${compact ? "size-18" : "my-2 w-80"}`}
      >
        {failed ? (
          <span className="p-3 text-xs text-muted-ink">Image unavailable · {name}</span>
        ) : (
          <img
            src={src}
            alt={name}
            loading="lazy"
            decoding="async"
            onError={() => setFailed(true)}
            className={
              compact ? "size-full object-cover" : "h-44 w-full object-contain bg-subtle-fill"
            }
          />
        )}
        {!compact && (
          <span className="w-full truncate border-t border-border px-3 py-2 text-xs text-secondary-ink">
            {name}
          </span>
        )}
      </Button>
      {open && (
        <ImageViewer
          src={src}
          name={name}
          onClose={() => {
            setOpen(false);
            trigger.current?.focus({ preventScroll: true });
          }}
        />
      )}
    </>
  );
}

const pendingImages = new WeakMap<DesktopAPI, Map<string, Promise<string>>>();
function loadImage(api: DesktopAPI, projectId: string, threadId: string, href: string) {
  let cache = pendingImages.get(api);
  if (!cache) {
    cache = new Map();
    pendingImages.set(api, cache);
  }
  const key = JSON.stringify([projectId, threadId, href]);
  const found = cache.get(key);
  if (found) return found;
  const request = api.readChatImage(projectId, threadId, href).then((image) => image.dataUrl);
  cache.set(key, request);
  const current = cache;
  void request.then(
    () => {
      if (current.get(key) === request) current.delete(key);
    },
    () => {
      if (current.get(key) === request) current.delete(key);
    },
  );
  return request;
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
    setState({ kind: "loading" });
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        observer.disconnect();
        void loadImage(api, projectId, threadId, href).then(
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
      observer.disconnect();
    };
  }, [api, projectId, threadId, href, attempt, active]);
  return (
    <span ref={container} className="inline-block max-w-full align-top">
      {state.kind === "ready" ? (
        <ImagePreview src={state.src} name={name} />
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
