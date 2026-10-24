"use client";
import type { ComponentProps, CSSProperties, ReactNode } from "react";
import { Avatar } from "@tidy/ui/avatar";

export type FileListColumn = "edited" | "created" | "creator" | "layers" | "status";
const columnLabels: Record<FileListColumn, string> = {
  edited: "Edited",
  created: "Created",
  creator: "Created by",
  layers: "Layers",
  status: "Status",
};

function listStyle(columns: readonly FileListColumn[], actions = true): CSSProperties {
  const template = (included: readonly FileListColumn[]) =>
    `minmax(0,1fr) ${columns
      .filter((column) => included.includes(column))
      .map((column) => (column === "creator" ? "150px" : column === "status" ? "120px" : "110px"))
      .join(" ")} ${actions ? "32px" : ""}`;
  return {
    "--file-list-small": `minmax(0,1fr) ${actions ? "32px" : ""}`,
    "--file-list-medium": `minmax(0,1fr) ${columns.includes("edited") ? "110px" : ""} ${actions ? "32px" : ""}`,
    "--file-list-expanded": template(["edited", "created", "layers"]),
    "--file-list-large": template(["edited", "created", "layers", "creator"]),
    "--file-list-wide": template(columns),
  } as CSSProperties;
}

export function FileListHeader({
  columns,
  edited,
  actions = true,
}: {
  columns: readonly FileListColumn[];
  edited?: ReactNode;
  actions?: boolean;
}) {
  return (
    <div
      data-ph-public
      className="file-list-layout file-list-header"
      style={listStyle(columns, actions)}
    >
      <span>Name</span>
      {columns.map((column) => (
        <div key={column} className={`file-list-cell file-list-${column}`}>
          {column === "edited" && edited ? edited : columnLabels[column]}
        </div>
      ))}
      {actions && <span className="sr-only">Actions</span>}
    </div>
  );
}

export function FileListRow({
  columns,
  className = "",
  actions = true,
  ...props
}: ComponentProps<"li"> & { columns: readonly FileListColumn[]; actions?: boolean }) {
  return (
    <li
      {...props}
      className={`file-list-layout file-list-row ${className}`}
      style={{ ...listStyle(columns, actions), ...props.style }}
    />
  );
}

export function FileListCreator({ name, image }: { name: string; image?: string | null }) {
  return (
    <span className="file-list-creator-content">
      <Avatar name={name} image={image} className="size-7 text-xs" />
      <span className="truncate">{name}</span>
    </span>
  );
}

export function FileListDate({ value, asOf }: { value: string; asOf?: string }) {
  if (!value || !Number.isFinite(Date.parse(value))) return null;
  const date = new Date(value);
  let label = date.toLocaleDateString("en-IE", { day: "numeric", month: "short", year: "numeric" });
  if (asOf) {
    const elapsed = Math.max(0, Date.parse(asOf) - date.getTime());
    const hours = Math.floor(elapsed / 3600000);
    const days = Math.floor(elapsed / 86400000);
    label =
      elapsed < 3600000
        ? "Just now"
        : days < 1
          ? `${hours} ${hours === 1 ? "hour" : "hours"} ago`
          : days === 1
            ? "Yesterday"
            : days < 7
              ? `${days} days ago`
              : days < 30
                ? `${Math.floor(days / 7)} ${days < 14 ? "week" : "weeks"} ago`
                : days < 365
                  ? `${Math.floor(days / 30)} ${days < 60 ? "month" : "months"} ago`
                  : `${Math.floor(days / 365)} ${days < 730 ? "year" : "years"} ago`;
  }
  return (
    <time
      dateTime={value}
      title={date.toLocaleDateString("en-IE", { day: "numeric", month: "long", year: "numeric" })}
    >
      {label}
    </time>
  );
}

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
