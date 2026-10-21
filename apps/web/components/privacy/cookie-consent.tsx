"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { privacyPolicyUrl } from "@/lib/privacy-notice";
import { recordBrowserConsent, recordBrowserWithdrawal } from "@/lib/privacy/receipt-client";
import { browserCollectionEnabled } from "@/lib/posthog-client";
import { Dialog } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { SelectMenu } from "@/components/ui/select-menu";
import { DeferredSection } from "@/components/ui/deferred-section";
import { McpAnalyticsChoice } from "./mcp-analytics-choice";
import {
  browserConsent,
  chooseConsent,
  ESSENTIAL_ONLY,
  subscribeConsent,
  type ConsentChoices,
  type ConsentPurpose,
} from "@/lib/privacy/consent";

export const OPEN_PRIVACY_CHOICES = "tidy-open-privacy-choices";
export type McpPrivacyPreference =
  | { enabled: boolean }
  | null
  | Promise<{ enabled: boolean } | null>;

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
    description:
      "Timings, technical error messages and app stack traces to fix bugs. Links to replay only if you also enable it.",
  },
];
const actionClass =
  "flex min-h-11 flex-1 items-center justify-center rounded-lg border border-border bg-surface px-4 py-3 text-sm font-medium text-ink hover:bg-hover-surface focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink";

export function CookieConsent({
  id = "privacy-choices-dialog",
  initialMcpAnalytics,
}: {
  id?: string;
  initialMcpAnalytics?: McpPrivacyPreference;
}) {
  const accountChoices = initialMcpAnalytics !== undefined;
  const collectionEnabled = browserCollectionEnabled();
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const choiceGeneration = useRef(0);
  const [choices, setChoices] = useState<ConsentChoices>(ESSENTIAL_ONLY);
  const [customize, setCustomize] = useState(accountChoices);
  const [message, setMessage] = useState("");
  const [needsRetry, setNeedsRetry] = useState(false);
  useEffect(() => {
    const refresh = () => setChoices(browserConsent() ?? ESSENTIAL_ONLY);
    refresh();
    if (!accountChoices && location.pathname !== "/privacy" && !browserConsent()) {
      dialog.current?.showModal();
      heading.current?.focus({ preventScroll: true });
    }
    const open = (event: Event) => {
      const detail = (event as CustomEvent<{ trigger: HTMLButtonElement; dialogId: string }>)
        .detail;
      if (detail.dialogId !== id) return;
      trigger.current = detail.trigger;
      // Finish rendering the controls before showModal measures and displays them.
      flushSync(() => {
        setCustomize(true);
        setChoices(browserConsent() ?? ESSENTIAL_ONLY);
      });
      dialog.current?.showModal();
      heading.current?.focus({ preventScroll: true });
    };
    window.addEventListener(OPEN_PRIVACY_CHOICES, open);
    const unsubscribe = subscribeConsent(refresh);
    return () => {
      window.removeEventListener(OPEN_PRIVACY_CHOICES, open);
      unsubscribe();
    };
  }, [accountChoices, id]);
  async function choose(next: ConsentChoices, close = false) {
    const generation = ++choiceGeneration.current;
    setNeedsRetry(false);
    const remembered = chooseConsent(next);
    setChoices(remembered ? next : ESSENTIAL_ONLY);
    setMessage(
      remembered
        ? ""
        : "Your browser could not remember the choice. Optional collection stays off in this tab.",
    );
    if (close) dialog.current?.close();
    try {
      if (remembered) await recordBrowserConsent();
      else await recordBrowserWithdrawal();
    } catch {
      if (generation !== choiceGeneration.current) return;
      setNeedsRetry(true);
      setMessage(
        "Your browser choice has changed. Server confirmation is pending; optional collection stays off. Please retry or contact seandowdall22@gmail.com for help with deletion.",
      );
    }
  }
  function renderPurpose({ key, title, description }: (typeof purposes)[number]) {
    return (
      <div key={key}>
        <div className="flex items-center justify-between gap-4">
          <span className="text-sm font-semibold">{title}</span>
          <SelectMenu
            replayOptions
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
    );
  }
  function diagnosticsSection(children: ReactNode) {
    return (
      <section aria-labelledby={`${id}-diagnostics`} className="space-y-5">
        <h3 id={`${id}-diagnostics`} className="text-sm font-semibold">
          Diagnostics and troubleshooting
        </h3>
        {children}
      </section>
    );
  }
  const mcpChoice = initialMcpAnalytics && (
    <DeferredSection value={initialMcpAnalytics} label="MCP privacy choice">
      {(choice) => {
        if (!choice) return null;
        const control = <McpAnalyticsChoice initialEnabled={choice.enabled} />;
        return collectionEnabled ? control : diagnosticsSection(control);
      }}
    </DeferredSection>
  );
  return (
    <aside data-ph-public-label className="ph-no-capture" aria-label="Privacy choices">
      <Dialog
        ref={dialog}
        id={id}
        size="lg"
        aria-labelledby={`${id}-title`}
        aria-describedby={`${id}-description`}
        onClose={() => {
          if (trigger.current?.isConnected) trigger.current.focus();
        }}
      >
        <div className="flex items-start justify-between gap-4">
          <h2
            data-ph-public
            ref={heading}
            id={`${id}-title`}
            tabIndex={-1}
            className="text-xl font-semibold outline-none"
          >
            {accountChoices ? "Privacy choices" : "Your browser privacy choices"}
          </h2>
          <Button
            type="button"
            aria-label="Close privacy choices"
            className="-mt-2 -mr-2 flex size-11 shrink-0 items-center justify-center rounded-md text-xl text-secondary-ink hover:bg-hover-surface focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
            onClick={() => dialog.current?.close()}
          >
            <span data-ph-public aria-hidden="true">
              ×
            </span>
          </Button>
        </div>
        <p
          data-ph-public
          id={`${id}-description`}
          className="mt-3 text-sm leading-6 text-secondary-ink"
        >
          {collectionEnabled
            ? "Optional PostHog analytics, masked replay and browser diagnostics stay off until you choose."
            : "This browser uses only essential storage for sign-in and preferences. Optional PostHog browser collection is off."}
        </p>
        {collectionEnabled && (
          <p data-ph-public className="mt-3 text-sm leading-6 text-secondary-ink">
            When signed in, optional browser activity is linked to your account ID and email.
          </p>
        )}
        <p className="mt-3 text-sm leading-6 text-secondary-ink">
          <a
            data-ph-public
            href={privacyPolicyUrl}
            className="rounded-sm text-ink underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
          >
            Privacy and cookie policy
          </a>
        </p>
        {customize && (collectionEnabled || initialMcpAnalytics) && (
          <div className="mt-5 space-y-5">
            {collectionEnabled &&
              purposes.filter(({ key }) => key !== "diagnostics").map(renderPurpose)}
            {collectionEnabled
              ? diagnosticsSection(
                  <>
                    {purposes.filter(({ key }) => key === "diagnostics").map(renderPurpose)}
                    {mcpChoice}
                  </>,
                )
              : mcpChoice}
          </div>
        )}
        {message && (
          <p role="status" className="mt-4 mb-4 text-sm text-secondary-ink">
            {message}
          </p>
        )}
        {needsRetry && (
          <Button type="button" variant="text" onClick={() => choose(choices)}>
            <span data-ph-public style={{ display: "contents" }}>
              Retry recording choice
            </span>
          </Button>
        )}
        <div className="mt-5 flex flex-wrap gap-3">
          <Button
            type="button"
            className={actionClass}
            onClick={() => choose(ESSENTIAL_ONLY, true)}
          >
            <span data-ph-public style={{ display: "contents" }}>
              {collectionEnabled
                ? accountChoices
                  ? "Reject browser options"
                  : "Reject optional"
                : "Use essential storage"}
            </span>
          </Button>
          {collectionEnabled && (
            <Button
              type="button"
              className={actionClass}
              onClick={() => choose({ analytics: true, replay: true, diagnostics: true }, true)}
            >
              <span data-ph-public style={{ display: "contents" }}>
                {accountChoices ? "Accept browser options" : "Accept all optional"}
              </span>
            </Button>
          )}
        </div>
        {collectionEnabled && !customize && (
          <Button
            type="button"
            className="mt-3 flex min-h-11 w-full items-center justify-center rounded-lg px-4 py-3 text-sm font-medium text-secondary-ink hover:bg-hover-surface focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
            onClick={() => setCustomize(true)}
          >
            <span data-ph-public style={{ display: "contents" }}>
              Choose individually
            </span>
          </Button>
        )}
      </Dialog>
    </aside>
  );
}
