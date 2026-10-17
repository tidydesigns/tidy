"use client";

import type { ReactNode } from "react";
import { Icon } from "@/components/ui/icon";

export function EditorNotification({
  message,
  onDismiss,
  children,
}: {
  message: string;
  onDismiss: () => void;
  children?: ReactNode;
}) {
  return (
    <div
      role="alert"
      data-canvas-control
      onPointerDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
      className="pointer-events-auto rounded-lg bg-surface p-3 text-xs shadow-sm"
    >
      <div className="flex items-start gap-2">
        <p className="min-w-0 flex-1 break-words">{message}</p>
        <button
          data-ph-public
          type="button"
          aria-label="Dismiss notification"
          className="-m-1 flex size-7 shrink-0 items-center justify-center rounded-md hover:bg-primary-grey/20 focus-visible:outline-2 focus-visible:outline-primary-orange"
          onClick={onDismiss}
        >
          <Icon name="xmark" size={14} />
        </button>
      </div>
      {children}
    </div>
  );
}
