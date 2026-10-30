"use client";

import { useErrorNotice } from "@/lib/use-error-notice";

import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { mcpSetupPrompt } from "@/lib/mcp/setup-prompt";
import styles from "./setup-prompt.module.css";

const steps = [
  ["Copy the setup prompt", "Everything your agent needs to connect."],
  ["Paste and send it in your agent", "Open a chat in Codex, Claude Code or OpenCode."],
  ["Approve the connection", "Follow your agent’s sign-in link and approve access to Tidy."],
] as const;

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
  const [, setError] = useErrorNotice("", "clipboard");

  async function copyPrompt() {
    const notifyError = setError("");
    if (copying) return;
    setCopying(true);

    try {
      await navigator.clipboard.writeText(mcpSetupPrompt(resourceUrl, organizationId));
      onCopied(true);
    } catch (cause) {
      onCopied(false);
      notifyError(cause, "Could not copy the setup prompt. Please try again.");
    } finally {
      setCopying(false);
    }
  }

  return (
    <div className={styles.copyControl}>
      <Button
        type="button"
        data-ph-public
        className={styles.copyButton}
        onClick={() => void copyPrompt()}
        aria-disabled={copying}
        aria-busy={copying}
        aria-label={copied ? "Copy setup prompt again" : undefined}
      >
        <span aria-hidden="true" className={styles.agents}>
          <span className={`${styles.agent} ${styles.codex}`} />
          <span className={`${styles.agent} ${styles.claude}`} />
          <span className={`${styles.agent} ${styles.opencode}`} />
        </span>
        <span aria-hidden="true" className={styles.divider} />
        <span className={styles.buttonLabel}>{copied ? "Prompt copied" : "Copy setup prompt"}</span>
        <Icon name={copied ? "checkBold" : "copy"} size={19} />
      </Button>
      <span role="status" className="sr-only">
        {copied ? "Prompt copied. Paste it into your coding agent and send it." : ""}
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
  const nextStep = variant === "onboarding" && props.copied;
  return (
    <div
      className={`${styles.guide} ${variant === "workspace" ? styles.workspace : styles.onboarding}`}
    >
      <section aria-labelledby={titleId} className="flex min-w-0 flex-col items-start gap-5">
        <Heading id={titleId} data-ph-public className={styles.title}>
          {nextStep ? (
            <>
              Paste the prompt
              <br />
              into your agent.
            </>
          ) : (
            <>
              Bring your agent
              <br />
              to Tidy.
            </>
          )}
        </Heading>
        <p data-ph-public className={styles.description}>
          {nextStep ? (
            "Open a chat in Codex, Claude Code or OpenCode. Paste the prompt and send it. Your agent will guide you through signing in."
          ) : variant === "onboarding" ? (
            "Let your coding agent work with your designs. Copy one prompt, then finish connecting in your agent."
          ) : (
            <>
              Connect Tidy to your coding agent. Keep your designs and code in the same
              conversation.
            </>
          )}
        </p>
        <McpPromptButton {...props} />
      </section>
      <div className={`${styles.instructions} min-w-0`}>
        <ol aria-label="Connect your agent" data-ph-public className={styles.steps}>
          {steps.map(([title, description], index) => (
            <li
              key={title}
              aria-current={index === (props.copied ? 1 : 0) ? "step" : undefined}
              data-active={index === (props.copied ? 1 : 0) ? "" : undefined}
              data-complete={props.copied && index === 0 ? "" : undefined}
              className={styles.step}
            >
              <span aria-hidden="true" className={styles.stepNumber}>
                {props.copied && index === 0 ? <Icon name="checkBold" size={18} /> : index + 1}
              </span>
              <div>
                <p className={styles.stepTitle}>{title}</p>
                <p className={styles.stepDescription}>{description}</p>
              </div>
            </li>
          ))}
        </ol>
        {variant === "onboarding" && (
          <p role="status" data-ph-public className={styles.connectionStatus}>
            <span
              aria-hidden="true"
              className={styles.statusDot}
              data-waiting={props.copied || undefined}
            />
            {props.copied
              ? "Waiting for your agent to connect…"
              : "Keep this page open while you connect."}
          </p>
        )}
      </div>
    </div>
  );
}
