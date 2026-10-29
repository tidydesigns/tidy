import { Button } from "@tidy/ui/button";
import type { ComponentPropsWithRef } from "react";
export function BrowserIconButton({
  className = "",
  ...props
}: ComponentPropsWithRef<typeof Button>) {
  return (
    <Button
      type="button"
      className={`browser-icon-button inline-flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-[5px] border border-transparent bg-transparent p-0 text-secondary-ink disabled:cursor-default disabled:opacity-35 ${className}`}
      {...props}
    />
  );
}

export function BrowserGlyph({ size = 16 }: { size?: number }) {
  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="3" y="4" width="18" height="16" rx="3" />
      <path d="M3 9h18M7 6.5h.01M10 6.5h.01" />
    </svg>
  );
}

export function Glyph({
  name,
}: {
  name: "back" | "forward" | "reload" | "close" | "plus" | "stop" | "expand" | "more";
}) {
  return (
    <svg
      aria-hidden="true"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {name === "back" ? (
        <path d="m14 6-6 6 6 6" />
      ) : name === "forward" ? (
        <path d="m10 6 6 6-6 6" />
      ) : name === "reload" ? (
        <>
          <path d="M20 11a8 8 0 1 0-2 6M20 4v7h-7" />
        </>
      ) : name === "close" ? (
        <path d="m6 6 12 12M18 6 6 18" />
      ) : name === "plus" ? (
        <path d="M12 5v14M5 12h14" />
      ) : name === "stop" ? (
        <rect x="6" y="6" width="12" height="12" rx="1" />
      ) : name === "more" ? (
        <path d="M12 5h.01M12 12h.01M12 19h.01" strokeWidth="3" />
      ) : (
        <path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5" />
      )}
    </svg>
  );
}

export const browserInputClass =
  "ml-1 h-[30px] min-w-0 flex-1 rounded-[5px] border border-border bg-surface px-2.5 text-xs text-ink outline-offset-1 focus:outline focus:outline-1 focus:outline-muted-ink placeholder:text-muted-ink";
