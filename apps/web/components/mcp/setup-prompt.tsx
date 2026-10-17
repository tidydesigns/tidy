"use client";

import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { FormMessage } from "@/components/ui/form-message";
import { Icon } from "@/components/ui/icon";
import { mcpSetupPrompt } from "@/lib/mcp/setup-prompt";
import styles from "./setup-prompt.module.css";

const steps = [
  ["Copy the setup prompt", "Everything your agent needs to connect."],
  ["Paste it into your agent", "Start a new message and run the prompt."],
  ["Sign in to Tidy", "Follow the link your agent gives you."],
];

export type SetupPromptProps = {
  resourceUrl: string;
  organizationId: string;
  copied: boolean;
  onCopied: (copied: boolean) => void;
};

export function McpPromptButton({
  resourceUrl,
  organizationId,
  copied,
  onCopied,
}: SetupPromptProps) {
  const [copying, setCopying] = useState(false);
  const [error, setError] = useState("");

  async function copyPrompt() {
    if (copying) return;
    setCopying(true);
    setError("");
    try {
      await navigator.clipboard.writeText(mcpSetupPrompt(resourceUrl, organizationId));
      onCopied(true);
    } catch {
      onCopied(false);
      setError("Could not copy the setup prompt. Please try again.");
    } finally {
      setCopying(false);
    }
  }

  return (
    <div className={styles.copyControl}>
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
        <span className={styles.buttonLabel}>{copied ? "Prompt copied" : "Copy setup prompt"}</span>
        <Icon name={copied ? "check" : "copy"} size={19} />
      </Button>
      <span role="status" className="sr-only">
        {copied ? "Prompt copied" : ""}
      </span>
    </div>
  );
}

export function McpSetupGuide({
  variant = "workspace",
  ...props
}: SetupPromptProps & { variant?: "onboarding" | "workspace" }) {
  const titleId = useId();
  const Heading = variant === "onboarding" ? "h1" : "h2";
  return (
    <div className={`${styles.guide} ${variant === "workspace" ? styles.workspace : ""}`}>
      <section aria-labelledby={titleId} className={styles.introduction}>
        <Heading id={titleId} data-ph-public className={styles.title}>
          Bring your agent
          <br />
          to Tidy.
        </Heading>
        <p data-ph-public className={styles.description}>
          Connect Tidy to your coding agent.
          <br />
          Keep your designs and code in the same conversation.
        </p>
        <McpPromptButton {...props} />
      </section>
      <ol aria-label="Connect your agent" data-ph-public className={styles.steps}>
        {steps.map(([title, description], index) => (
          <li
            key={title}
            aria-current={index === (props.copied ? 1 : 0) ? "step" : undefined}
            data-active={props.copied && index === 1 ? "" : undefined}
            data-complete={props.copied && index === 0 ? "" : undefined}
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
  );
}
