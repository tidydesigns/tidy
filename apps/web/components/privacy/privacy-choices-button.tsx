"use client";

import { Button } from "@/components/ui/button";

export const OPEN_PRIVACY_CHOICES = "tidy-open-privacy-choices";

export function PrivacyChoicesButton({ className }: { className?: string }) {
  return (
    <Button
      type="button"
      aria-haspopup="dialog"
      aria-controls="privacy-choices-dialog"
      className={
        className ??
        "min-h-11 rounded-lg border border-border bg-panel px-4 text-sm font-medium text-ink hover:bg-hover-surface focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
      }
      onClick={(event) =>
        window.dispatchEvent(new CustomEvent(OPEN_PRIVACY_CHOICES, { detail: event.currentTarget }))
      }
    >
      <span data-ph-public style={{ display: "contents" }}>
        Privacy choices
      </span>
    </Button>
  );
}
