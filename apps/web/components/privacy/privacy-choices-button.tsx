"use client";

import { OPEN_PRIVACY_CHOICES } from "./cookie-consent";
import { Button } from "@/components/ui/button";

export function PrivacyChoicesButton({ className }: { className?: string }) {
  const dialogId = "privacy-choices-dialog";
  return (
    <Button
      type="button"
      aria-haspopup="dialog"
      aria-controls={dialogId}
      className={
        className ??
        "min-h-11 rounded-lg border border-border bg-panel px-4 text-sm font-medium text-ink hover:bg-hover-surface focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
      }
      onClick={(event) =>
        window.dispatchEvent(
          new CustomEvent(OPEN_PRIVACY_CHOICES, {
            detail: { trigger: event.currentTarget, dialogId },
          }),
        )
      }
    >
      <span data-ph-public style={{ display: "contents" }}>
        Privacy choices
      </span>
    </Button>
  );
}
