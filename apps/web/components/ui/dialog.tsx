"use client";

import { useRef, type ComponentPropsWithRef, type MouseEvent } from "react";

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
      className={`fixed inset-0 m-auto max-h-[90dvh] w-[calc(100%-2rem)] overflow-y-auto rounded-lg border border-border bg-panel text-ink shadow-xl backdrop:bg-overlay/20 backdrop:backdrop-blur-none ${widths[size]} ${padded ? "p-6" : "p-0"} ${className}`}
    />
  );
}
