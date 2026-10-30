"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import posthog, { appErrorReporter } from "@/lib/posthog-client";
import { Button } from "@/components/ui/button";
import { OnboardingFrame } from "@/components/onboarding/onboarding-frame";
import { McpSetupGuide } from "@/components/mcp/setup-prompt";
import { Icon } from "@/components/ui/icon";
import { checkAuthorizedAgents } from "@/app/mcp/actions";
import type { AuthorizedClient } from "@/lib/mcp/authorizations";
import { authorizationRefreshDelay } from "@/lib/mcp/authorization-refresh";
import styles from "./mcp-onboarding.module.css";

export function McpOnboarding({
  resourceUrl,
  organizationId,
  initialClients,
}: {
  resourceUrl: string;
  organizationId: string;
  initialClients: AuthorizedClient[];
}) {
  const router = useRouter();
  const [copied, setCopied] = useState(false);
  const [clients, setClients] = useState(initialClients);
  const connected = clients.length > 0;
  const successHeading = useRef<HTMLHeadingElement>(null);
  const reportedConnection = useRef(false);

  useEffect(() => {
    router.prefetch("/files");
  }, [router]);

  useEffect(() => {
    if (connected && !reportedConnection.current) {
      reportedConnection.current = true;
      posthog.capture("onboarding_mcp_connected");
    }
  }, [connected]);

  function promptCopied(value: boolean) {
    setCopied(value);
    if (value) posthog.capture("onboarding_mcp_prompt_copied");
  }

  useEffect(() => {
    if (connected) {
      successHeading.current?.focus({ preventScroll: true });
      return;
    }
    let disposed = false;
    let inFlight = false;
    let timer: ReturnType<typeof setTimeout>;
    let delay = authorizationRefreshDelay(0, { settingUp: copied, changed: true });
    const schedule = () => {
      timer = setTimeout(() => void refresh(), delay);
    };
    const reportPollError = appErrorReporter("integration_update");
    let failureReported = false;
    async function refresh() {
      if (disposed || inFlight) return;
      clearTimeout(timer);
      if (document.hidden || !navigator.onLine) {
        schedule();
        return;
      }
      inFlight = true;
      try {
        const result = await checkAuthorizedAgents();
        failureReported = false;
        if (disposed) return;
        if (result.clients?.length) {
          setClients(result.clients);
          return;
        }
      } catch (cause) {
        if (!disposed && !failureReported) reportPollError(cause);
        failureReported = true;
        // Keep setup usable and retry transient failures without a manual check button.
      } finally {
        inFlight = false;
      }
      if (!disposed) {
        delay = authorizationRefreshDelay(delay, { settingUp: copied, changed: false });
        schedule();
      }
    }
    function wake() {
      if (!document.hidden) void refresh();
    }
    // Also refresh on mount: a restored onboarding page may predate OAuth sign-in.
    void refresh();
    window.addEventListener("focus", wake);
    window.addEventListener("online", wake);
    document.addEventListener("visibilitychange", wake);
    return () => {
      disposed = true;
      clearTimeout(timer);
      window.removeEventListener("focus", wake);
      window.removeEventListener("online", wake);
      document.removeEventListener("visibilitychange", wake);
    };
  }, [copied, connected]);

  function finish() {
    posthog.capture("onboarding_completed", {
      mcp_setup_prompt_copied: copied,
      mcp_connected: connected,
    });
    router.replace("/files");
  }

  return (
    <OnboardingFrame step={3} completed={connected}>
      {connected ? (
        <section
          className="flex flex-1 items-center justify-center py-18"
          aria-labelledby="mcp-ready-title"
        >
          <div className="flex w-full min-w-0 max-w-[460px] flex-col items-start gap-5">
            <span
              aria-hidden="true"
              className="flex size-12 items-center justify-center rounded-full bg-[#46a758] text-white"
            >
              <Icon name="checkBold" size={26} />
            </span>
            <h1
              id="mcp-ready-title"
              ref={successHeading}
              tabIndex={-1}
              data-ph-public
              className={styles.successTitle}
            >
              You’re all set.
            </h1>
            <p className={styles.successDescription}>
              {clients.length === 1
                ? `${clients[0].name} is connected to Tidy.`
                : "Your agents are connected to Tidy."}
            </p>
            <Button type="button" data-ph-public className={styles.continueButton} onClick={finish}>
              Open Tidy
              <Icon name="arrowRight" size={18} />
            </Button>
          </div>
        </section>
      ) : (
        <McpSetupGuide
          variant="onboarding"
          resourceUrl={resourceUrl}
          organizationId={organizationId}
          copied={copied}
          onCopied={promptCopied}
        />
      )}

      {!connected && (
        <footer className="flex justify-center">
          <Button type="button" data-ph-public className={styles.skipButton} onClick={finish}>
            Set up later
          </Button>
        </footer>
      )}
    </OnboardingFrame>
  );
}
