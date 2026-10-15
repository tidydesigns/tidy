"use client";

import { useEffect, useRef, useState } from "react";
import { privacyPolicyUrl } from "@/lib/privacy-notice";
import { recordBrowserConsent, recordBrowserWithdrawal } from "@/lib/privacy/receipt-client";
import { browserCollectionEnabled } from "@/lib/posthog-client";
import { Dialog } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { SelectMenu } from "@/components/ui/select-menu";
import { OPEN_PRIVACY_CHOICES } from "./privacy-choices-button";
import {
  browserConsent,
  chooseConsent,
  ESSENTIAL_ONLY,
  subscribeConsent,
  type ConsentChoices,
  type ConsentPurpose,
} from "@/lib/privacy/consent";

const purposes: { key: ConsentPurpose; title: string; description: string }[] = [
  {
    key: "analytics",
    title: "Usage analytics",
    description: "Page visits, interactions, feature usage and optional surveys.",
  },
  {
    key: "replay",
    title: "Session replay",
    description:
      "Navigation, clicks and scrolling. Inputs, text, images and design canvases are hidden.",
  },
  {
    key: "diagnostics",
    title: "Browser performance and errors",
    description: "Loading and interaction timings, plus redacted browser errors.",
  },
];
const actionClass =
  "flex min-h-11 flex-1 items-center justify-center rounded-lg border border-border bg-surface px-4 py-3 text-sm font-medium text-ink hover:bg-hover-surface focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink";

export function CookieConsent() {
  const collectionEnabled = browserCollectionEnabled();
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const choiceGeneration = useRef(0);
  const [choices, setChoices] = useState<ConsentChoices>(ESSENTIAL_ONLY);
  const [customize, setCustomize] = useState(false);
  const [message, setMessage] = useState("");
  const [needsRetry, setNeedsRetry] = useState(false);
  useEffect(() => {
    const refresh = () => setChoices(browserConsent() ?? ESSENTIAL_ONLY);
    refresh();
    if (location.pathname !== "/privacy" && !browserConsent()) {
      dialog.current?.showModal();
      heading.current?.focus({ preventScroll: true });
    }
    const open = (event: Event) => {
      trigger.current = (event as CustomEvent<HTMLButtonElement>).detail;
      ++choiceGeneration.current;
      setCustomize(true);
      setMessage("");
      dialog.current?.showModal();
      heading.current?.focus({ preventScroll: true });
    };
    window.addEventListener(OPEN_PRIVACY_CHOICES, open);
    const unsubscribe = subscribeConsent(refresh);
    return () => {
      window.removeEventListener(OPEN_PRIVACY_CHOICES, open);
      unsubscribe();
    };
  }, []);
  async function choose(next: ConsentChoices, close = false) {
    const generation = ++choiceGeneration.current;
    setNeedsRetry(false);
    const remembered = chooseConsent(next);
    setChoices(remembered ? next : ESSENTIAL_ONLY);
    setMessage(
      remembered
        ? "Recording your choice…"
        : "Your browser could not remember the choice. Optional collection stays off in this tab.",
    );
    try {
      if (!remembered) {
        await recordBrowserWithdrawal();
        if (generation !== choiceGeneration.current) return;
        setMessage(
          "Your browser could not store the choice. All optional collection has been stopped and withdrawal recorded.",
        );
        return;
      }
      await recordBrowserConsent();
      if (generation !== choiceGeneration.current) return;
      setMessage("Your choice applies immediately.");
      if (close) dialog.current?.close();
    } catch {
      if (generation !== choiceGeneration.current) return;
      setNeedsRetry(true);
      setMessage(
        "Your browser choice has changed. Server confirmation is pending; optional collection stays off. Please retry or contact seandowdall22@gmail.com for help with deletion.",
      );
    }
  }
  return (
    <aside className="ph-no-capture" aria-label="Privacy choices">
      <Dialog
        ref={dialog}
        id="privacy-choices-dialog"
        size="lg"
        aria-labelledby="privacy-choice-title"
        aria-describedby="privacy-choice-description"
        onClose={() => {
          if (trigger.current?.isConnected) trigger.current.focus();
        }}
      >
        <div className="flex items-start justify-between gap-4">
          <h2
            ref={heading}
            id="privacy-choice-title"
            tabIndex={-1}
            className="text-xl font-semibold outline-none"
          >
            Your privacy choices
          </h2>
          <Button
            type="button"
            aria-label="Close privacy choices"
            className="-mt-2 -mr-2 flex size-11 shrink-0 items-center justify-center rounded-md text-xl text-secondary-ink hover:bg-hover-surface focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
            onClick={() => dialog.current?.close()}
          >
            <span aria-hidden="true">×</span>
          </Button>
        </div>
        <p id="privacy-choice-description" className="mt-3 text-sm leading-6 text-secondary-ink">
          {collectionEnabled
            ? "Optional PostHog analytics, masked replay and browser diagnostics stay off until you choose."
            : "Only essential storage for sign-in and preferences is active. Optional PostHog collection is off."}
        </p>
        {collectionEnabled && (
          <p className="mt-3 text-sm leading-6 text-secondary-ink">
            When signed in, optional activity is linked to your account ID and email.
          </p>
        )}
        <p className="mt-3 text-sm leading-6 text-secondary-ink">
          <a
            href={privacyPolicyUrl}
            className="rounded-sm text-ink underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
          >
            Privacy and cookie policy
          </a>
        </p>
        {collectionEnabled && customize && (
          <div className="mt-5 mb-5 space-y-5 border-y border-border py-5">
            {purposes.map(({ key, title, description }) => (
              <div key={key}>
                <div className="flex items-center justify-between gap-4">
                  <span id={`consent-${key}`} className="text-sm font-semibold">
                    {title}
                  </span>
                  <SelectMenu
                    label={title}
                    value={choices[key] ? "on" : "off"}
                    options={[
                      { value: "off", label: "Off" },
                      { value: "on", label: "On" },
                    ]}
                    onChange={(value) => choose({ ...choices, [key]: value === "on" })}
                  />
                </div>
                <p className="mt-2 text-sm leading-5 text-secondary-ink">{description}</p>
              </div>
            ))}
          </div>
        )}
        {message && (
          <p role="status" className="mt-4 mb-4 text-sm text-secondary-ink">
            {message}
          </p>
        )}
        {needsRetry && (
          <Button type="button" variant="text" onClick={() => choose(choices)}>
            Retry recording choice
          </Button>
        )}
        <div className="mt-5 flex flex-wrap gap-3">
          <Button
            type="button"
            className={actionClass}
            onClick={() => choose(ESSENTIAL_ONLY, true)}
          >
            {collectionEnabled ? "Reject optional" : "Use essential storage"}
          </Button>
          {collectionEnabled && (
            <Button
              type="button"
              className={actionClass}
              onClick={() => choose({ analytics: true, replay: true, diagnostics: true }, true)}
            >
              Accept all optional
            </Button>
          )}
        </div>
        {collectionEnabled && !customize && (
          <Button
            type="button"
            className="mt-3 flex min-h-11 w-full items-center justify-center rounded-lg px-4 py-3 text-sm font-medium text-secondary-ink hover:bg-hover-surface focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
            onClick={() => setCustomize(true)}
          >
            Choose individually
          </Button>
        )}
      </Dialog>
    </aside>
  );
}
