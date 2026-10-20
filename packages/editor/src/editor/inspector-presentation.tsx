"use client";
import { createContext, useContext, useState, type ReactNode } from "react";

export const QuietInspector = createContext(false);
export const useQuietInspector = () => useContext(QuietInspector);
export const InspectorGesture = createContext<{
  begin: () => void;
  commit: () => void;
  cancel: () => void;
} | null>(null);
const disclosures = new Map<string, boolean>();

export function InspectorDisclosure({
  title,
  summary,
  children,
  nested = false,
  enabled = true,
}: {
  title: string;
  summary?: ReactNode;
  children: ReactNode;
  nested?: boolean;
  enabled?: boolean;
}) {
  const [open, setOpen] = useState(() => disclosures.get(title) ?? false);
  if (!enabled) return children;
  return (
    <details
      className={`inspector-disclosure ${nested ? "inspector-disclosure-nested" : "border-b border-primary-grey"}`}
      open={open}
      onToggle={(event) => {
        const next = event.currentTarget.open;
        disclosures.set(title, next);
        setOpen(next);
      }}
    >
      <summary
        className={`flex cursor-pointer list-none items-center justify-between gap-3 text-xs outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary-orange ${nested ? "min-h-7 text-secondary-ink" : "min-h-11 px-4 text-primary-black"}`}
      >
        <span>{title}</span>
        {summary && (
          <span className="min-w-0 truncate text-[11px] font-normal text-secondary-ink">
            {summary}
          </span>
        )}
      </summary>
      {open && <div className={nested ? "space-y-3 pt-2" : "space-y-3 px-4 pb-4"}>{children}</div>}
    </details>
  );
}
