"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { usePathname } from "next/navigation";
import { loadMcpChoice, recordMcpChoice } from "@/lib/privacy/mcp-choice-client";
import { privacyPolicyUrl } from "@/lib/privacy-notice";
import { recordBrowserConsent, recordBrowserWithdrawal } from "@/lib/privacy/receipt-client";
import { browserCollectionEnabled } from "@/lib/posthog-client";
import { Dialog } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { SelectMenu } from "@/components/ui/select-menu";
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

export function CookieConsent() {
  const id = "privacy-choices-dialog";
  const pathname = usePathname();
  const collectionEnabled = browserCollectionEnabled();
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const choiceGeneration = useRef(0);
  const [choices, setChoices] = useState<ConsentChoices>(ESSENTIAL_ONLY);
  const [customize, setCustomize] = useState(false);
  const [message, setMessage] = useState("");
  const [needsRetry, setNeedsRetry] = useState(false);
  const [mcpEnabled, setMcpEnabled] = useState(false);
  const [mcpLoading, setMcpLoading] = useState(true);
  const [mcpError, setMcpError] = useState(false);
  const [pending, setPending] = useState(false);
  const mcpGeneration = useRef(0);
  const pendingRef = useRef(false);
  const retryMcp = useRef<boolean | undefined>(undefined);
  const refreshMcp = useCallback(() => {
    if (pendingRef.current) return;
    const generation = ++mcpGeneration.current;
    return loadMcpChoice()
      .then(
        (result) => {
          if (generation === mcpGeneration.current) {
            setMcpEnabled(result.enabled);
            setMcpError(false);
          }
        },
        () => {
          if (generation === mcpGeneration.current) setMcpError(true);
        },
      )
      .finally(() => {
        if (generation === mcpGeneration.current) setMcpLoading(false);
      });
  }, []);
  useEffect(() => {
    void refreshMcp();
    window.addEventListener("focus", refreshMcp);
    return () => {
      window.removeEventListener("focus", refreshMcp);
    };
  }, [pathname, refreshMcp]);
  useEffect(() => {
    const refresh = () => setChoices(browserConsent() ?? ESSENTIAL_ONLY);
    refresh();
    if (location.pathname !== "/privacy" && !browserConsent()) {
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
  }, []);
  async function choose(next: ConsentChoices, close = false, mcp?: boolean) {
    if (pendingRef.current) return;
    pendingRef.current = true;
    const generation = ++choiceGeneration.current;
    if (mcp !== undefined) ++mcpGeneration.current;
    retryMcp.current = mcp;
    setNeedsRetry(false);
    setPending(true);
    const current = browserConsent();
    const unchanged =
      current &&
      (["analytics", "replay", "diagnostics"] as const).every(
        (purpose) => current[purpose] === next[purpose],
      );
    const remembered = unchanged || chooseConsent(next);
    setChoices(remembered ? next : ESSENTIAL_ONLY);
    setMessage(
      remembered
        ? ""
        : "Your browser could not remember the choice. Optional browser collection stays off in this tab.",
    );
    try {
      // Independent purposes must both be attempted: a browser receipt failure
      // must never prevent an explicit MCP withdrawal (or vice versa).
      const [browserResult, mcpResult] = await Promise.allSettled([
        remembered ? recordBrowserConsent() : recordBrowserWithdrawal(),
        mcp === undefined ? Promise.resolve(undefined) : recordMcpChoice(mcp),
      ]);
      if (
        mcpResult.status === "fulfilled" &&
        mcpResult.value &&
        generation === choiceGeneration.current
      ) {
        setMcpEnabled(mcpResult.value.enabled);
        setMcpLoading(false);
        setMcpError(false);
      }
      if (browserResult.status === "rejected" || mcpResult.status === "rejected")
        throw new Error("Privacy choice confirmation failed");
      if (close && generation === choiceGeneration.current) dialog.current?.close();
    } catch {
      if (generation !== choiceGeneration.current) return;
      setNeedsRetry(true);
      setMessage(
        "Your privacy choices could not all be confirmed. Please retry. Browser and MCP choices are applied only when their server confirmation succeeds.",
      );
    } finally {
      if (generation === choiceGeneration.current) {
        pendingRef.current = false;
        setPending(false);
        if (mcp !== undefined) setMcpLoading(false);
      }
    }
  }
  function renderPurpose({ key, title, description }: (typeof purposes)[number]) {
    return (
      <div key={key}>
        <div className="flex items-center justify-between gap-4">
          <span className="text-sm font-semibold">{title}</span>
          <SelectMenu
            replayOptions
            disabled={pending}
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
            Privacy choices
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
            ? "Choose optional PostHog usage analytics, masked session replay, browser performance and errors, and account-linked MCP diagnostics. Optional collection starts only after you choose."
            : "Optional browser collection is currently off. You can choose whether to link MCP diagnostics to your account for troubleshooting."}
        </p>
        <p data-ph-public className="mt-3 text-sm leading-6 text-secondary-ink">
          Browser choices continue after sign-in on this browser; allowed browser activity is linked
          to your account ID and email. MCP linking applies across your account for 90 days. Before
          sign-in, your MCP choice applies to the next account you sign in to.
        </p>
        <p className="mt-3 text-sm leading-6 text-secondary-ink">
          <a
            data-ph-public
            href={privacyPolicyUrl}
            className="rounded-sm text-ink underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
          >
            Privacy and cookie policy
          </a>
        </p>
        {customize && (
          <div className="mt-5 space-y-5">
            {collectionEnabled &&
              purposes.filter(({ key }) => key !== "diagnostics").map(renderPurpose)}
            <section aria-labelledby={`${id}-diagnostics`} className="space-y-5">
              <h3 id={`${id}-diagnostics`} className="text-sm font-semibold">
                Diagnostics and troubleshooting
              </h3>
              {collectionEnabled &&
                purposes.filter(({ key }) => key === "diagnostics").map(renderPurpose)}
              <McpAnalyticsChoice
                enabled={mcpEnabled}
                pending={pending || mcpLoading}
                onChange={(enabled) => void choose(choices, false, enabled)}
              />
              {mcpError && (
                <div className="text-sm text-danger" role="alert">
                  Could not load your MCP privacy choice.
                  <Button type="button" variant="text" onClick={refreshMcp}>
                    Try again
                  </Button>
                </div>
              )}
            </section>
          </div>
        )}
        {message && (
          <p role="status" className="mt-4 mb-4 text-sm text-secondary-ink">
            {message}
          </p>
        )}
        {needsRetry && (
          <Button
            type="button"
            variant="text"
            disabled={pending}
            onClick={() => choose(choices, false, retryMcp.current)}
          >
            <span data-ph-public style={{ display: "contents" }}>
              Retry recording choice
            </span>
          </Button>
        )}
        <div className="mt-5 flex flex-wrap gap-3">
          <Button
            type="button"
            className={actionClass}
            disabled={pending}
            onClick={() => choose(ESSENTIAL_ONLY, true, false)}
          >
            <span data-ph-public style={{ display: "contents" }}>
              Reject all optional
            </span>
          </Button>
          <Button
            type="button"
            className={actionClass}
            disabled={pending}
            onClick={() =>
              choose(
                {
                  analytics: collectionEnabled,
                  replay: collectionEnabled,
                  diagnostics: collectionEnabled,
                },
                true,
                true,
              )
            }
          >
            <span data-ph-public style={{ display: "contents" }}>
              Accept all optional
            </span>
          </Button>
        </div>
        {!customize && (
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
