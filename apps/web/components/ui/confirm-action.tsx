"use client";

import { useErrorNotice } from "@/lib/use-error-notice";

import { unstable_rethrow } from "next/navigation";
import { ConfirmationDialog } from "@/components/ui/dialog";
import { useTransition, useRef, useState, type ReactNode } from "react";

export function ConfirmAction({
  label,
  title,
  replayLabel = false,
  replayTitle = false,
  children,
  onConfirm,
  disabled,
  className,
}: {
  label: string;
  title: string;
  replayLabel?: boolean;
  replayTitle?: boolean;
  children: ReactNode;
  onConfirm: () => Promise<void>;
  disabled?: boolean;
  className?: string;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const confirming = useRef(false);
  const [, startTransition] = useTransition();
  const [pending, setPending] = useState(false);
  const [, setError] = useErrorNotice("", "user_action");

  function confirm() {
    if (confirming.current) return;
    confirming.current = true;
    setPending(true);
    setError("");
    startTransition(confirmAction);
  }

  async function confirmAction() {
    const notifyError = setError("");
    try {
      await onConfirm();
      dialog.current?.close();
    } catch (error) {
      unstable_rethrow(error);
      notifyError(error, "Could not complete the action. Try again.");
    } finally {
      confirming.current = false;
      setPending(false);
    }
  }

  return (
    <>
      <button
        type="button"
        disabled={disabled || pending}
        onClick={() => {
          setError("");
          dialog.current?.showModal();
        }}
        className={
          className ??
          "rounded-lg px-3 py-2 text-sm text-danger hover:bg-danger/5 focus-visible:outline-2 focus-visible:outline-danger disabled:opacity-50"
        }
      >
        <span data-ph-public={replayLabel || undefined}>{label}</span>
      </button>
      <ConfirmationDialog
        ref={dialog}
        title={<span data-ph-public={replayTitle || undefined}>{title}</span>}
        confirmLabel={
          <span data-ph-public={replayLabel || undefined}>{pending ? "Working…" : label}</span>
        }
        pending={pending}
        onConfirm={confirm}
        onDismiss={() => {
          if (!confirming.current) dialog.current?.close();
        }}
        onCancel={(event) => {
          if (confirming.current) event.preventDefault();
        }}
      >
        {children}
      </ConfirmationDialog>
    </>
  );
}
