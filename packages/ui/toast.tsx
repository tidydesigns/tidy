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
  tone = "error",
}: {
  message: string;
  onDismiss: () => void;
  children?: ReactNode;
  tone?: "error" | "success";
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
          {tone === "error" ? "!" : "✓"}
        </span>
        <p data-ph-private>{message}</p>
        <button data-ph-public type="button" aria-label="Dismiss notification" onClick={onDismiss}>
          ×
        </button>
      </div>
      {children}
    </div>
  );
}

export function ToastViewport() {
  const notices = useSyncExternalStore(subscribeToasts, toastSnapshot, emptyToastSnapshot);
  const [container, setContainer] = useState<HTMLElement | null>(null);
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
    <div className="tidy-toast-viewport" aria-label="Notifications">
      {notices.map((notice) => (
        <Toast key={notice.id} {...notice} onDismiss={() => dismissToast(notice.id, true)} />
      ))}
    </div>,
    container,
  );
}

/** Success notices expire; errors remain until explicitly dismissed. */
export function useSuccessToast() {
  useEffect(() => {
    const timers = new Map<number, ReturnType<typeof setTimeout>>();
    const update = () => {
      for (const notice of toastSnapshot()) {
        if (notice.tone === "success" && !timers.has(notice.id))
          timers.set(
            notice.id,
            setTimeout(() => {
              dismissToast(notice.id);
              timers.delete(notice.id);
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
  return (message: string) => showToast(message, "success");
}
