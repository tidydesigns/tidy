"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import posthog from "posthog-js";
import { Button } from "@/components/ui/button";
import { FormMessage } from "@/components/ui/form-message";
import { Icon } from "@/components/ui/icon";
import { TidyLogo } from "@/components/ui/tidy-logo";
import { OnboardingProgress } from "@/components/onboarding/onboarding-progress";
import styles from "./mcp-onboarding.module.css";

const steps = [
  ["Copy the setup prompt", "Everything your agent needs to connect."],
  ["Paste it into your agent", "Start a new message and run the prompt."],
  ["Sign in to Tidy", "Follow the link your agent gives you."],
];

export function McpOnboarding({ resourceUrl }: { resourceUrl: string }) {
  const router = useRouter();
  const [copied, setCopied] = useState(false);
  const [copying, setCopying] = useState(false);
  const [error, setError] = useState("");

  async function copyPrompt() {
    setCopying(true);
    setError("");
    try {
      await navigator.clipboard.writeText(
        `Connect this coding agent to Tidy using ${resourceUrl}.\n\n` +
          "Set up the remote Streamable HTTP MCP server using this agent’s supported configuration. " +
          "Preserve any existing MCP servers. Guide me through browser-based OAuth sign-in, " +
          "then verify the connection by listing my Tidy organizations. " +
          "If this agent cannot configure MCP itself, give me the exact setup steps for this client.",
      );
      setCopied(true);
    } catch {
      setCopied(false);
      setError("Could not copy the setup prompt. Please try again.");
    } finally {
      setCopying(false);
    }
  }

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

        <div className={styles.content}>
          <section aria-labelledby="connect-agent-title" className={styles.introduction}>
            <h1 id="connect-agent-title" data-ph-public className={styles.title}>
              Bring your agent
              <br />
              to Tidy.
            </h1>
            <p data-ph-public className={styles.description}>
              Connect Tidy to your coding agent.
              <br />
              Keep your designs and code in the same conversation.
            </p>
            {error && <FormMessage>{error}</FormMessage>}
            <Button
              type="button"
              data-ph-public
              className={styles.copyButton}
              onClick={() => void copyPrompt()}
              disabled={copying}
              aria-busy={copying}
            >
              <span aria-hidden="true" className={styles.agents}>
                <span className={`${styles.agent} ${styles.codex}`} />
                <span className={`${styles.agent} ${styles.claude}`} />
                <span className={`${styles.agent} ${styles.opencode}`} />
              </span>
              <span aria-hidden="true" className={styles.divider} />
              <span aria-live="polite" className={styles.buttonLabel}>
                {copied ? "Prompt copied" : "Copy setup prompt"}
              </span>
              <Icon name={copied ? "check" : "copy"} size={19} />
            </Button>
          </section>

          <ol aria-label="Connect your agent" data-ph-public className={styles.steps}>
            {steps.map(([title, description], index) => (
              <li
                key={title}
                aria-current={index === (copied ? 1 : 0) ? "step" : undefined}
                data-active={copied && index === 1 ? "" : undefined}
                data-complete={copied && index === 0 ? "" : undefined}
                className={styles.step}
              >
                <span aria-hidden="true" className={styles.stepNumber}>
                  {index + 1}
                </span>
                <div>
                  <p className={styles.stepTitle}>{title}</p>
                  <p className={styles.stepDescription}>{description}</p>
                </div>
              </li>
            ))}
          </ol>
        </div>

        <footer className={styles.footer}>
          <Button type="button" data-ph-public className={styles.skipButton} onClick={finish}>
            Set up later
          </Button>
        </footer>
      </div>
    </main>
  );
}
