"use client";

import { useEffect, useRef } from "react";
import Link from "next/link";
import { Dialog } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { browserConsent } from "@/lib/privacy/consent";
import { PrivacyChoices } from "./privacy-choices";

export function CookieConsent() {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (!location.pathname.startsWith("/privacy") && !browserConsent()) {
      dialog.current?.showModal();
      dialog.current?.querySelector("h2")?.focus({ preventScroll: true });
    }
  }, []);

  return (
    <Dialog ref={dialog} size="lg" aria-labelledby="privacy-dialog-title" className="ph-no-capture">
      <Button
        type="button"
        aria-label="Close privacy choices"
        className="absolute top-4 right-4 flex size-11 items-center justify-center rounded-md text-xl text-secondary-ink hover:bg-hover-surface focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
        onClick={() => dialog.current?.close()}
      >
        <span aria-hidden="true">×</span>
      </Button>
      <PrivacyChoices
        customizeInitially={false}
        titleId="privacy-dialog-title"
        onDone={() => dialog.current?.close()}
      />
      <p className="mt-4 text-sm text-secondary-ink">
        You can also change choices without signing in on the{" "}
        <Link
          href="/privacy/choices"
          onClick={() => dialog.current?.close()}
          className="underline underline-offset-4"
        >
          privacy choices page
        </Link>
        .
      </p>
    </Dialog>
  );
}
