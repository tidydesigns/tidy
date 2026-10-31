"use client";

import { useId, useRef, type ComponentPropsWithRef, type MouseEvent, type ReactNode } from "react";
import { Button } from "@tidy/ui/button";

const widths = {
  sm: "max-w-sm",
  md: "max-w-md",
  lg: "max-w-lg",
  wide: "max-w-[1200px]",
} as const;

type DialogProps = ComponentPropsWithRef<"dialog"> & {
  size?: keyof typeof widths;
  padded?: boolean;
};

function isBackdrop(event: MouseEvent<HTMLDialogElement>) {
  if (event.target !== event.currentTarget) return false;
  const bounds = event.currentTarget.getBoundingClientRect();
  return (
    event.clientX < bounds.left ||
    event.clientX > bounds.right ||
    event.clientY < bounds.top ||
    event.clientY > bounds.bottom
  );
}

/** Backdrop dismissal uses the same cancellable event as Escape. */
export function Dialog({
  size = "md",
  padded = true,
  className = "",
  onPointerDown,
  onPointerCancel,
  onClick,
  onClose,
  ...props
}: DialogProps) {
  const pressedBackdrop = useRef(false);
  return (
    <dialog
      {...props}
      onPointerDown={(event) => {
        onPointerDown?.(event);
        pressedBackdrop.current =
          !event.defaultPrevented && event.button === 0 && event.isPrimary && isBackdrop(event);
        if (pressedBackdrop.current) event.stopPropagation();
      }}
      onPointerCancel={(event) => {
        pressedBackdrop.current = false;
        onPointerCancel?.(event);
      }}
      onClick={(event) => {
        onClick?.(event);
        const dismiss = pressedBackdrop.current && !event.defaultPrevented && isBackdrop(event);
        pressedBackdrop.current = false;
        if (!dismiss) return;
        event.stopPropagation();
        const dialog = event.currentTarget;
        if (dialog.dispatchEvent(new Event("cancel", { cancelable: true }))) dialog.close();
      }}
      onClose={(event) => {
        pressedBackdrop.current = false;
        onClose?.(event);
      }}
      className={`fixed inset-0 m-auto max-h-[90dvh] w-[calc(100%-2rem)] overflow-y-auto overscroll-contain rounded-lg border border-border bg-panel text-ink shadow-xl backdrop:bg-overlay/20 backdrop:backdrop-blur-none ${widths[size]} ${padded ? "p-6" : "p-0"} ${className}`}
    />
  );
}

/** Shared destructive confirmation layout for web and desktop. */
export function ConfirmationDialog({
  title,
  children,
  confirmLabel,
  onConfirm,
  onDismiss,
  pending = false,
  onCancel,
  ...props
}: Omit<DialogProps, "title" | "children" | "aria-labelledby" | "aria-describedby"> & {
  title: ReactNode;
  children: ReactNode;
  confirmLabel: ReactNode;
  onConfirm(): void;
  onDismiss(): void;
  pending?: boolean;
}) {
  const id = useId();
  return (
    <Dialog
      {...props}
      aria-labelledby={`${id}-title`}
      aria-describedby={`${id}-description`}
      onCancel={(event) => {
        onCancel?.(event);
        if (pending) event.preventDefault();
      }}
    >
      <h2 id={`${id}-title`} className="text-lg font-semibold wrap-anywhere">
        {title}
      </h2>
      <div id={`${id}-description`} className="mt-3 text-sm text-secondary-ink wrap-anywhere">
        {children}
      </div>
      <div className="mt-6 flex flex-wrap justify-end gap-3">
        <Button
          data-ph-public
          type="button"
          autoFocus
          disabled={pending}
          onClick={onDismiss}
          className="rounded-lg px-4 py-2.5 text-sm hover:bg-primary-grey/20 focus-visible:outline-2 focus-visible:outline-primary-orange disabled:opacity-50"
        >
          Cancel
        </Button>
        <Button
          type="button"
          disabled={pending}
          onClick={onConfirm}
          className="rounded-lg bg-danger-fill px-4 py-2.5 text-sm font-medium text-on-danger hover:bg-danger-fill-hover focus-visible:outline-2 focus-visible:outline-danger disabled:opacity-50"
        >
          {confirmLabel}
        </Button>
      </div>
    </Dialog>
  );
}
