"use client";

import { unstable_rethrow } from "next/navigation";
import { Dialog } from "@/components/ui/dialog";
import { useId, useRef, useState, type ReactNode } from "react";

export function ConfirmAction({
  label,
  title,
  children,
  onConfirm,
  disabled,
  className,
}: {
  label: string;
  title: string;
  children: ReactNode;
  onConfirm: () => Promise<void>;
  disabled?: boolean;
  className?: string;
}) {
  const id = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  async function confirm() {
    if (pending) return;
    setPending(true);
    setError("");
    try {
      await onConfirm();
      dialog.current?.close();
    } catch (error) {
      unstable_rethrow(error);
      setError(
        error instanceof Error ? error.message : "Could not complete the action. Try again.",
      );
    } finally {
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
        {label}
      </button>
      <Dialog
        ref={dialog}
        aria-labelledby={`${id}-title`}
        aria-describedby={`${id}-description`}
        onCancel={(event) => {
          if (pending) event.preventDefault();
        }}
      >
        <h2 id={`${id}-title`} className="text-lg font-semibold">
          {title}
        </h2>
        <div id={`${id}-description`} className="mt-3 text-sm text-secondary-ink">
          {children}
        </div>
        {error && (
          <p role="alert" className="mt-3 text-sm text-danger">
            {error}
          </p>
        )}
        <div className="mt-6 flex justify-end gap-3">
          <button
            type="button"
            autoFocus
            disabled={pending}
            onClick={() => dialog.current?.close()}
            className="rounded-lg px-4 py-2.5 text-sm hover:bg-primary-grey/20 focus-visible:outline-2 focus-visible:outline-primary-orange disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={pending}
            onClick={() => void confirm()}
            className="rounded-lg bg-danger-fill px-4 py-2.5 text-sm font-medium text-on-danger hover:bg-danger-fill-hover focus-visible:outline-2 focus-visible:outline-danger disabled:opacity-50"
          >
            {pending ? "Working…" : label}
          </button>
        </div>
      </Dialog>
    </>
  );
}
