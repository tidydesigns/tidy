"use client";
import type { ReactNode } from "react";

export const folderCardClass =
  "flex h-24 items-center gap-4 rounded-xl border border-primary-grey/70 px-5 pr-12 transition-colors hover:border-primary-grey hover:bg-surface/40";
export function FileViewToggle({
  view,
  onChange,
}: {
  view: "grid" | "list";
  onChange(view: "grid" | "list"): void;
}) {
  return (
    <div
      data-ph-public-label
      data-ph-public
      role="group"
      aria-label="File view"
      className="flex rounded-lg border border-primary-grey/70 p-1"
    >
      <button
        data-ph-public-label
        type="button"
        aria-label="Grid view"
        aria-pressed={view === "grid"}
        onClick={() => onChange("grid")}
        className={`rounded-md p-2 focus-visible:outline-2 focus-visible:outline-primary-orange ${view === "grid" ? "bg-primary-grey/35" : "text-secondary-ink hover:bg-primary-grey/20"}`}
      >
        <svg
          data-ph-public
          aria-hidden="true"
          width="18"
          height="18"
          viewBox="0 0 18 18"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
        >
          <rect x="2" y="2" width="5" height="5" rx="1" />
          <rect x="11" y="2" width="5" height="5" rx="1" />
          <rect x="2" y="11" width="5" height="5" rx="1" />
          <rect x="11" y="11" width="5" height="5" rx="1" />
        </svg>
      </button>
      <button
        data-ph-public-label
        type="button"
        aria-label="List view"
        aria-pressed={view === "list"}
        onClick={() => onChange("list")}
        className={`rounded-md p-2 focus-visible:outline-2 focus-visible:outline-primary-orange ${view === "list" ? "bg-primary-grey/35" : "text-secondary-ink hover:bg-primary-grey/20"}`}
      >
        <svg
          data-ph-public
          aria-hidden="true"
          width="18"
          height="18"
          viewBox="0 0 18 18"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
        >
          <path d="M7 4h9M7 9h9M7 14h9" />
          <path d="M2.5 4h1M2.5 9h1M2.5 14h1" />
        </svg>
      </button>
    </div>
  );
}

export function FileCard({
  preview,
  openLink,
  children,
}: {
  preview: ReactNode;
  openLink?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="group relative overflow-hidden rounded-xl border border-primary-grey/70 transition-colors hover:border-primary-grey hover:bg-surface/40">
      {openLink}
      <div className="h-44 border-b border-primary-grey/45">{preview}</div>
      <div className="p-4 pr-12">{children}</div>
    </div>
  );
}
