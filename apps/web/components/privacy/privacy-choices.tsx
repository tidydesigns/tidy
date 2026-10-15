"use client";

import { useEffect, useId, useRef, useState } from "react";
import { privacyPolicyUrl } from "@/lib/privacy-notice";
import { recordBrowserConsent, recordBrowserWithdrawal } from "@/lib/privacy/receipt-client";
import { browserCollectionEnabled } from "@/lib/posthog-client";
import { Button } from "@/components/ui/button";
import { SelectMenu } from "@/components/ui/select-menu";
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
    description:
      "Page visits, interactions, feature usage and optional surveys help us improve Tidy. Uses PostHog.",
  },
  {
    key: "replay",
    title: "Session replay",
    description:
      "A masked reconstruction of navigation, clicks and scrolling helps us understand usability problems. Inputs, text, images and design canvases are hidden.",
  },
  {
    key: "diagnostics",
    title: "Browser performance and errors",
    description:
      "Browser loading and interaction timings and redacted browser errors help us find and fix technical problems.",
  },
];
const actionClass =
  "flex min-h-11 flex-1 items-center justify-center rounded-lg border border-border bg-surface px-4 py-3 text-sm font-medium text-ink hover:bg-hover-surface focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink";

export function PrivacyChoices({
  customizeInitially = true,
  titleId,
  onDone,
}: {
  customizeInitially?: boolean;
  titleId?: string;
  onDone?: () => void;
}) {
  const id = useId();
  const collectionEnabled = browserCollectionEnabled();
  const choiceGeneration = useRef(0);
  const [choices, setChoices] = useState<ConsentChoices>(ESSENTIAL_ONLY);
  const [customize, setCustomize] = useState(customizeInitially);
  const [message, setMessage] = useState("");
  const [needsRetry, setNeedsRetry] = useState(false);
  useEffect(() => {
    const refresh = () => setChoices(browserConsent() ?? ESSENTIAL_ONLY);
    refresh();
    return subscribeConsent(refresh);
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
      if (close) onDone?.();
    } catch {
      if (generation !== choiceGeneration.current) return;
      setNeedsRetry(true);
      setMessage(
        "Your browser choice has changed. Server confirmation is pending; optional collection stays off. Please retry or contact seandowdall22@gmail.com for help with deletion.",
      );
    }
  }
  return (
    <section className="ph-no-capture max-w-xl" aria-labelledby={titleId ?? `${id}-title`}>
      <h2
        id={titleId ?? `${id}-title`}
        tabIndex={-1}
        className={`text-xl font-semibold tracking-tight outline-none ${onDone ? "pr-10" : ""}`}
      >
        Your privacy choices
      </h2>
      <p className="mt-3 text-sm leading-6 text-secondary-ink">
        {collectionEnabled
          ? "Tidy uses essential storage for sign-in and preferences. Choose whether to allow PostHog analytics, masked replay or browser diagnostics. Optional tracking stays off until you choose."
          : "Tidy uses essential storage for sign-in and your preferences. Optional PostHog browser collection is paused. Only essential storage is available."}
      </p>
      <p className="mt-3 text-sm leading-6 text-secondary-ink">
        Our{" "}
        <a
          href={privacyPolicyUrl}
          className="rounded-sm text-ink underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
        >
          privacy and cookie policy
        </a>{" "}
        covers server fault monitoring separately and explains how to object.
      </p>
      <p className="mt-3 text-sm leading-6 text-secondary-ink">
        {collectionEnabled
          ? "When signed in, selected activity, including replay, is linked to your account ID and email. You can use Tidy without accepting. Change or withdraw choices anytime in Settings → Privacy. Choices last 180 days in this browser."
          : "Your essential-only preference lasts 180 days in this browser. Any future optional collection will require a separate choice."}
      </p>
      {collectionEnabled && customize && (
        <div className="mt-5 mb-5 space-y-5 border-y border-border py-5">
          {purposes.map(({ key, title, description }) => (
            <div key={key}>
              <div className="flex items-center justify-between gap-4">
                <span id={`${id}-${key}`} className="text-sm font-semibold">
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
        <Button type="button" className={actionClass} onClick={() => choose(ESSENTIAL_ONLY, true)}>
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
    </section>
  );
}
