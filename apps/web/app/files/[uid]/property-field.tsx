"use client";
import { useRef, useState, type ChangeEvent, type KeyboardEvent } from "react";
type Value = string | number | undefined;
const inputClass =
  "h-8 w-full min-w-0 rounded-md border border-primary-grey/70 bg-surface px-2 text-xs text-primary-black outline-none focus:border-primary-orange disabled:opacity-40";
/** Keep the draft focused while other fields and network responses update. */
export function PropertyField({
  label,
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
  multiline = false,
  validate,
}: {
  label: string;
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
  multiline?: boolean;
  validate?: (value: string) => boolean;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const committed = useRef(false);
  const [invalid, setInvalid] = useState(false);
  const displayed = typeof value === "number" ? Math.round(value * 1000) / 1000 : value;
  function commit() {
    if (draft === null || committed.current) return;
    if (
      (validate && !validate(draft)) ||
      (numeric &&
        draft !== "" &&
        (!Number.isFinite(Number(draft)) ||
          (integer && !Number.isInteger(Number(draft))) ||
          (min !== undefined && Number(draft) < min) ||
          (max !== undefined && Number(draft) > max)))
    ) {
      setInvalid(true);
      return;
    }
    committed.current = true;
    if (draft !== String(displayed ?? "")) onCommit(draft);
    setDraft(null);
    setInvalid(false);
  }
  const control = {
    disabled,
    "aria-label": label,
    "aria-invalid": invalid || undefined,
    value: draft ?? displayed ?? "",
    placeholder,
    onChange: (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      committed.current = false;
      setDraft(event.target.value);
      setInvalid(false);
    },
    onBlur: commit,
    onKeyDown: (event: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      event.stopPropagation();
      if (event.key === "Enter" && (!multiline || event.metaKey || event.ctrlKey)) {
        commit();
        event.currentTarget.blur();
      }
      if (event.key === "Escape") {
        committed.current = true;
        setDraft(null);
        setInvalid(false);
        event.currentTarget.blur();
      }
    },
  };
  return (
    <label className="block min-w-0 text-[10px] text-secondary-ink">
      {label}
      {multiline ? (
        <textarea
          {...control}
          rows={3}
          className={`${inputClass} mt-1 min-h-16 resize-y py-2 ${invalid ? "border-danger" : ""}`}
        />
      ) : (
        <input
          {...control}
          type={numeric ? "number" : "text"}
          min={min}
          max={max}
          step={step}
          list={list}
          className={`${inputClass} mt-1 ${invalid ? "border-danger" : ""}`}
        />
      )}
    </label>
  );
}
