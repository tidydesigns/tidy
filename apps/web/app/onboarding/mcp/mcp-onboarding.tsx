"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import posthog from "posthog-js";
import { Button } from "@/components/ui/button";
import { TidyLogo } from "@/components/ui/tidy-logo";
import { OnboardingProgress } from "@/components/onboarding/onboarding-progress";
import { McpSetupGuide } from "@/components/mcp/setup-prompt";
import styles from "./mcp-onboarding.module.css";

export function McpOnboarding({
  resourceUrl,
  organizationId,
}: {
  resourceUrl: string;
  organizationId: string;
}) {
  const router = useRouter();
  const [copied, setCopied] = useState(false);
  function finish() {
    posthog.capture("onboarding_completed", { mcp_setup_prompt_copied: copied });
    router.replace("/files");
  }

  return (
    <main className={styles.page}>
      <div className={styles.shell}>
        <header className={styles.header}>
          <TidyLogo className={styles.logo} />
          <OnboardingProgress step={3} />
        </header>

        <McpSetupGuide
          variant="onboarding"
          resourceUrl={resourceUrl}
          organizationId={organizationId}
          copied={copied}
          onCopied={setCopied}
        />

        <footer className={styles.footer}>
          <Button type="button" data-ph-public className={styles.skipButton} onClick={finish}>
            Set up later
          </Button>
        </footer>
      </div>
    </main>
  );
}
