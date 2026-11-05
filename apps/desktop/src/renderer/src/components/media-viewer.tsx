import { useLayoutEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Button } from "@tidy/ui/button";
import { Dialog } from "@tidy/editor/components/ui/dialog";
import "./media-viewer.css";

export const mediaViewerControlClassName =
  "inline-flex min-h-[40px] shrink-0 cursor-pointer items-center justify-center rounded-[10px] border border-[color-mix(in_srgb,var(--color-border)_65%,transparent)] bg-surface text-ink shadow-[0_1px_2px_rgb(0_0_0/3%)] hover:bg-hover-surface active:scale-[0.97] active:bg-pressed-surface focus-visible:border-transparent focus-visible:outline-2 focus-visible:outline-offset-3 focus-visible:outline-muted-ink forced-colors:border-[CanvasText]!";

export function MediaViewer({
  kind,
  name,
  onClose,
  actions,
  children,
}: {
  kind: "image" | "video";
  name: string;
  onClose(): void;
  actions?: ReactNode;
  children: ReactNode;
}) {
  const displayName = name.trim() || (kind === "image" ? "Image" : "Video");
  const dialog = useRef<HTMLDialogElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const dismissed = useRef(false);
  function dismiss() {
    if (dismissed.current) return;
    dismissed.current = true;
    dialog.current?.close();
    onClose();
  }
  useLayoutEffect(() => {
    const element = dialog.current;
    element?.showModal();
    close.current?.focus({ preventScroll: true });
  }, []);
  return createPortal(
    <Dialog
      ref={dialog}
      padded={false}
      size="wide"
      aria-label={`${kind === "image" ? "Image" : "Video"} preview: ${displayName}`}
      onClose={dismiss}
      onCancel={(event) => {
        event.preventDefault();
        dismiss();
      }}
      className="media-viewer hidden h-[82dvh] max-h-[calc(100dvh-32px)]! w-[min(1200px,calc(100%-clamp(24px,12vw,192px)))]! max-w-none! flex-col overflow-hidden! rounded-[20px]! open:flex backdrop:bg-[light-dark(rgb(20_22_26/32%),rgb(0_0_0/48%))]! backdrop:backdrop-blur-[6px]! max-[480px]:max-h-[calc(100dvh-24px)]! max-[480px]:w-[min(1200px,calc(100%-24px))]! max-[480px]:rounded-[16px]! [@media(max-height:480px)]:max-h-[calc(100dvh-24px)]! [@media(max-height:480px)]:w-[min(1200px,calc(100%-24px))]! [@media(max-height:480px)]:rounded-[16px]! forced-colors:border-[CanvasText]!"
    >
      <div
        dir="ltr"
        className="flex shrink-0 items-center gap-[12px] py-[12px] pr-[14px] pl-[22px] max-[480px]:gap-[8px] max-[480px]:py-[8px] max-[480px]:pr-[10px] max-[480px]:pl-[14px] [@media(max-height:480px)]:gap-[8px] [@media(max-height:480px)]:py-[8px] [@media(max-height:480px)]:pr-[10px] [@media(max-height:480px)]:pl-[14px]"
      >
        <span
          className="min-w-0 flex-1 truncate text-sm leading-normal font-medium text-secondary-ink"
          title={displayName}
          dir="auto"
        >
          {displayName}
        </span>
        {actions}
        <Button
          type="button"
          ref={close}
          className={`${mediaViewerControlClassName} size-[40px]`}
          aria-label={`Close ${kind} preview`}
          onClick={dismiss}
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path
              d="m6 6 12 12M18 6 6 18"
              stroke="currentColor"
              strokeWidth="1.75"
              strokeLinecap="round"
            />
          </svg>
        </Button>
      </div>
      <div
        dir="ltr"
        className="media-viewer-stage mx-[8px] mb-[8px] flex min-h-0 flex-1 overflow-auto overscroll-contain rounded-[12px] border p-[24px] max-[480px]:mx-[4px] max-[480px]:mb-[4px] max-[480px]:p-[12px] [@media(max-height:480px)]:mx-[4px] [@media(max-height:480px)]:mb-[4px] [@media(max-height:480px)]:p-[12px] forced-colors:border-[CanvasText]!"
      >
        {children}
      </div>
    </Dialog>,
    document.body,
  );
}
