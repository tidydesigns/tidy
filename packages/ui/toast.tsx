"use client";

import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  dismissToast,
  emptyToastSnapshot,
  showToast,
  subscribeToasts,
  toastSnapshot,
} from "./toast-store";
export { showToast, dismissToast, clearToasts } from "./toast-store";

/** Shared by global action errors and actionable editor notifications. */
export function Toast({
  message,
  onDismiss,
  children,
  action,
  tone = "error",
}: {
  message: string;
  onDismiss: () => void;
  children?: ReactNode;
  action?: { label: string; onClick: () => void; disabled?: boolean };
  tone?: "error" | "success" | "info";
}) {
  return (
    <div
      className="tidy-toast"
      role={tone === "error" ? "alert" : "status"}
      aria-atomic="true"
      data-canvas-control
      onPointerDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <div className="tidy-toast-content">
        <span aria-hidden="true" className="tidy-toast-icon">
          {tone === "error" ? "!" : tone === "info" ? "i" : "✓"}
        </span>
        <p data-ph-private>{message}</p>
        {action && (
          <button
            data-ph-public
            type="button"
            className="tidy-toast-action"
            onClick={action.onClick}
            disabled={action.disabled}
          >
            {action.label}
          </button>
        )}
        <button data-ph-public type="button" aria-label="Dismiss notification" onClick={onDismiss}>
          ×
        </button>
      </div>
      {children}
    </div>
  );
}

/** Portal global toasts and actionable notices into the shared bottom-right notification stack. */
export function ToastViewport({ children }: { children?: ReactNode }) {
  const notices = useSyncExternalStore(subscribeToasts, toastSnapshot, emptyToastSnapshot);
  const [container, setContainer] = useState<HTMLElement | null>(null);
  useEffect(() => {
    const timers = new Map<number, ReturnType<typeof setTimeout>>();
    const update = () => {
      const notices = toastSnapshot();
      for (const [id, timer] of timers) {
        if (!notices.some((notice) => notice.id === id)) {
          clearTimeout(timer);
          timers.delete(id);
        }
      }
      for (const notice of notices) {
        if (notice.tone === "success" && !timers.has(notice.id))
          timers.set(
            notice.id,
            setTimeout(() => {
              timers.delete(notice.id);
              dismissToast(notice.id);
            }, 5000),
          );
      }
    };
    update();
    const unsubscribe = subscribeToasts(update);
    return () => {
      unsubscribe();
      for (const timer of timers.values()) clearTimeout(timer);
    };
  }, []);
  useEffect(() => {
    // Native modal dialogs make body siblings inert. Mount inside the active
    // modal so errors remain visible, announced and dismissible while it is open.
    const update = () => {
      const dialogs = document.querySelectorAll<HTMLDialogElement>("dialog:modal");
      setContainer(dialogs.item(dialogs.length - 1) ?? document.body);
    };
    update();
    const observer = new MutationObserver(update);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["open"],
    });
    return () => observer.disconnect();
  }, []);
  if (!container) return null;
  return createPortal(
    <div className="tidy-toast-viewport" role="region" aria-label="Notifications">
      {notices.map((notice) => (
        <Toast key={notice.id} {...notice} onDismiss={() => dismissToast(notice.id, true)} />
      ))}
      {children}
    </div>,
    container,
  );
}

/** Success notices expire; errors remain until explicitly dismissed. */
export function useSuccessToast() {
  return (message: string) => showToast(message, "success");
}
