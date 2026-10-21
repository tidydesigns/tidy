"use client";

import { useErrorNotice } from "@/lib/use-error-notice";

import { useId, useRef, useState, type InputHTMLAttributes } from "react";
import { TextField } from "./text-field";

type Props = Omit<
  InputHTMLAttributes<HTMLInputElement>,
  "value" | "onChange" | "onBlur" | "onKeyDown" | "id"
> & {
  label: string;
  replayLabel?: boolean;
  value: string;
  onCommit: (draft: string) => Promise<string>;
};

export function ImmediateField({ label, value, onCommit, disabled, ...props }: Props) {
  const id = useId();
  const [draft, setDraft] = useState(value);
  const [pending, setPending] = useState(false);
  const [error, setError] = useErrorNotice("", "user_action", "inline");
  const submitting = useRef(false);
  const cancelling = useRef(false);

  async function commit() {
    const notifyError = setError("");
    if (cancelling.current) {
      cancelling.current = false;
      return;
    }
    if (submitting.current || draft === value) return;
    submitting.current = true;
    setPending(true);

    try {
      setDraft(await onCommit(draft));
    } catch (error) {
      notifyError(error, "Could not apply the change. Try again.");
    } finally {
      submitting.current = false;
      setPending(false);
    }
  }

  return (
    <div>
      <TextField
        {...props}
        id={id}
        label={label}
        value={draft}
        disabled={disabled || pending}
        aria-invalid={Boolean(error)}
        aria-describedby={error ? `${id}-error` : undefined}
        onChange={(event) => {
          setDraft(event.target.value);
          setError("");
        }}
        onBlur={() => void commit()}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === "Enter") {
            event.preventDefault();
            event.currentTarget.blur();
          }
          if (event.key === "Escape") {
            event.preventDefault();
            cancelling.current = true;
            setDraft(value);
            setError("");
            event.currentTarget.blur();
          }
        }}
      />
      {error && (
        <p id={`${id}-error`} role="alert" className="mt-2 text-sm text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
