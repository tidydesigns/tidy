import { useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";
import { Button } from "@tidy/ui/button";
import { Dialog } from "@tidy/editor/components/ui/dialog";
import type { DesktopAPI } from "../../../shared/contracts/desktop";
import { useVideoSource, type VideoInput } from "./use-video-source";

export function VideoPreview({
  api,
  input,
  name,
  onClose,
}: {
  api: DesktopAPI;
  input: VideoInput;
  name: string;
  onClose(): void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const { state, retry, playbackFailed } = useVideoSource(api, input, true);
  const { href } = input;
  useEffect(() => {
    const element = dialog.current;
    const previousFocus = document.activeElement;
    element?.showModal();
    return () => {
      element?.close();
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected)
        previousFocus.focus({ preventScroll: true });
    };
  }, []);

  return createPortal(
    <Dialog
      ref={dialog}
      size="wide"
      padded={false}
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      className="video-preview-dialog"
    >
      <header className="video-preview-header">
        <div className="min-w-0">
          <h2 id={titleId} className="truncate text-sm font-medium">
            {name}
          </h2>
          <p className="truncate text-xs text-muted-ink" title={href}>
            {href}
          </p>
        </div>
        <Button
          className="grid size-7 shrink-0 cursor-pointer place-items-center rounded border-0 bg-transparent text-muted-ink hover:bg-hover-surface hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-muted-ink active:scale-97"
          aria-label="Close video preview"
          onClick={onClose}
        >
          <svg
            aria-hidden="true"
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          >
            <path d="m6 6 12 12M18 6 6 18" />
          </svg>
        </Button>
      </header>
      <div className="video-preview-stage">
        {state.kind === "ready" ? (
          <video
            src={state.url}
            controls
            playsInline
            preload="metadata"
            aria-label={name}
            onError={playbackFailed}
          />
        ) : (
          <div className="video-preview-status" role={state.kind === "error" ? "alert" : "status"}>
            <span className="video-preview-symbol" aria-hidden="true">
              <svg
                width="22"
                height="22"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
              >
                <path d="m9 5 11 7-11 7V5Z" strokeLinejoin="round" />
              </svg>
            </span>
            {state.kind === "loading" ? (
              <>
                <p>Loading recording…</p>
                <progress
                  aria-label="Loading recording"
                  max={state.total ?? 1}
                  value={state.total ? state.loaded : undefined}
                />
                <span className="text-xs text-muted-ink">
                  {state.total
                    ? `${Math.round((state.loaded / state.total) * 100)}% · ${(state.total / 1024 / 1024).toFixed(1)} MB`
                    : "Connecting to the project"}
                </span>
              </>
            ) : (
              <>
                <p>Unable to preview video</p>
                <p className="text-xs text-muted-ink">{state.message}</p>
                <Button
                  className="cursor-pointer rounded-md border border-border bg-panel px-3 py-1.5 text-xs hover:bg-hover-surface focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-muted-ink active:scale-97"
                  onClick={retry}
                >
                  Try again
                </Button>
              </>
            )}
          </div>
        )}
      </div>
    </Dialog>,
    document.body,
  );
}
