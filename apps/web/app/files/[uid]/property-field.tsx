"use client";
import {
  useId,
  useRef,
  useState,
  type ChangeEvent,
  type FocusEvent,
  type KeyboardEvent,
} from "react";
type Value = string | number | undefined;
const inputClass =
  "h-8 w-full min-w-0 rounded-md border border-control-border bg-surface px-2 text-xs text-primary-black outline-none focus:border-primary-orange focus-visible:ring-2 focus-visible:ring-primary-orange disabled:opacity-40";
/** Keep the draft focused while other fields and network responses update. */
export function PropertyField({
  label,
  replayLabel = false,
  value,
  onCommit,
  numeric = false,
  integer = false,
  min,
  max,
  step = 1,
  placeholder = "Mixed",
  list,
  disabled = false,
  required = false,
  multiline = false,
  validate,
}: {
  label: string;
  replayLabel?: boolean;
  value: Value;
  onCommit: (value: string) => void;
  numeric?: boolean;
  integer?: boolean;
  min?: number;
  max?: number;
  step?: number | "any";
  placeholder?: string;
  list?: string;
  disabled?: boolean;
  required?: boolean;
  multiline?: boolean;
  validate?: (value: string) => string | undefined;
}) {
  const id = useId();
  const [draft, setDraft] = useState<string | null>(null);
  const committed = useRef(false);
  const [error, setError] = useState<string>();
  const displayed = typeof value === "number" ? Math.round(value * 1000) / 1000 : value;
  function commit(input: HTMLInputElement | HTMLTextAreaElement) {
    if (draft === null || committed.current) return;
    let message = validate?.(draft) ?? (required && draft === "" ? "Enter a value." : undefined);
    if (numeric && (input.validity.badInput || draft !== "")) {
      const number = Number(draft);
      if (input.validity.badInput || !Number.isFinite(number)) message = "Enter a number.";
      else if (integer && !Number.isInteger(number)) message = "Enter a whole number.";
      else if ((min !== undefined && number < min) || (max !== undefined && number > max))
        message =
          min !== undefined && max !== undefined
            ? `Enter a number from ${min} to ${max}.`
            : min !== undefined
              ? `Enter a number of at least ${min}.`
              : `Enter a number no greater than ${max}.`;
    }
    if (message) {
      setError(message);
      return;
    }
    committed.current = true;
    if (draft !== String(displayed ?? "")) onCommit(draft);
    setDraft(null);
    setError(undefined);
  }
  const control = {
    id,
    disabled,
    required,
    "aria-invalid": error ? true : undefined,
    "aria-describedby": error ? `${id}-error` : undefined,
    value: draft ?? displayed ?? "",
    placeholder,
    onChange: (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      committed.current = false;
      setDraft(event.target.value);
      setError(undefined);
    },
    onBlur: (event: FocusEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      commit(event.currentTarget),
    onKeyDown: (event: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      event.stopPropagation();
      if (event.nativeEvent.isComposing) return;
      if (event.key === "Enter" && (!multiline || event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        commit(event.currentTarget);
        event.currentTarget.blur();
      }
      if (event.key === "Escape") {
        committed.current = true;
        setDraft(null);
        setError(undefined);
        event.currentTarget.blur();
      }
    },
  };
  return (
    <div className="min-w-0 text-[10px] text-secondary-ink">
      <label htmlFor={id} data-ph-public={replayLabel || undefined}>
        {label}
      </label>
      {multiline ? (
        <textarea
          {...control}
          rows={3}
          className={`${inputClass} mt-1 min-h-16 resize-y py-2 ${error ? "border-danger" : ""}`}
        />
      ) : (
        <input
          {...control}
          type={numeric ? "number" : "text"}
          min={min}
          max={max}
          step={step}
          list={list}
          className={`${inputClass} mt-1 ${error ? "border-danger" : ""}`}
        />
      )}
      {error && (
        <p id={`${id}-error`} role="alert" className="mt-1 text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
