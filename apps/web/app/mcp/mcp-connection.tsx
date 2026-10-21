"use client";
import { appErrorReporter } from "@/lib/posthog-client";

import { useEffect, useId, useRef, useState } from "react";
import { DeferredSection } from "@/components/ui/deferred-section";
import { Button } from "@/components/ui/button";
import { ConfirmAction } from "@/components/ui/confirm-action";
import { Icon } from "@/components/ui/icon";
import { SelectMenu } from "@/components/ui/select-menu";
import {
  McpPromptButton,
  McpSetupGuide,
  type SetupPromptProps,
} from "@/components/mcp/setup-prompt";
import { CopyableValue } from "@/components/mcp/copyable-value";
import { checkAuthorizedAgents, revokeAgent } from "./actions";
import { agentOptions, setupFor, type Agent } from "./agent-setup";
import { useFeatureFlag } from "@/lib/use-feature-flag";
import type { AuthorizedClient } from "@/lib/mcp/authorizations";
import { authorizationRefreshDelay, sameAuthorizations } from "@/lib/mcp/authorization-refresh";
import { McpConnectionsSkeleton, McpPageHeading } from "./mcp-loading";
import styles from "./mcp-connection.module.css";

function ManualSetup({ resourceUrl }: { resourceUrl: string }) {
  const [selectedAgent, setAgent] = useState<Agent>("codex");
  const showAdditionalClients = useFeatureFlag("mcp-pi-gemini");
  const options = agentOptions.filter(
    (option) => showAdditionalClients || !["pi", "gemini", "other"].includes(option.value),
  );
  const agent = options.some((option) => option.value === selectedAgent) ? selectedAgent : "codex";
  const name = ["localhost", "127.0.0.1", "[::1]"].includes(new URL(resourceUrl).hostname)
    ? "tidy-local"
    : "tidy";
  const setup = setupFor(agent, name, resourceUrl);

  return (
    <details className={styles.manual}>
      <summary data-ph-public className={styles.manualToggle}>
        <Icon name="arrowRight" size={14} className={styles.disclosureIcon} />
        Manual setup
      </summary>
      <div className={styles.manualContent}>
        <SelectMenu
          replayOptions
          replayLabel
          label="Agent"
          value={agent}
          onChange={(value) => setAgent(value as Agent)}
          options={options}
          className="w-[210px] max-w-full"
        />
        <ol key={agent} className="mt-6 space-y-6">
          {setup.steps.map((step, index) => (
            <li key={step.title} className="flex min-w-0 items-start gap-3">
              <span aria-hidden="true" className={styles.manualStep}>
                {index + 1}
              </span>
              <div className="min-w-0 flex-1">
                <h3 data-ph-public className="text-sm font-medium leading-6">
                  {step.title}
                </h3>
                <p data-ph-public className="mt-1 text-[13px] leading-5 text-secondary-ink">
                  {step.description}
                </p>
                {step.values.map((item) => (
                  <div key={item.value} className="mt-2">
                    <CopyableValue {...item} />
                  </div>
                ))}
              </div>
            </li>
          ))}
        </ol>
      </div>
    </details>
  );
}

function EmptySetup(props: SetupPromptProps) {
  return (
    <>
      <McpSetupGuide {...props} />
      <ManualSetup resourceUrl={props.resourceUrl} />
    </>
  );
}

function AgentLogo({ name }: { name: string }) {
  const agent = /claude/i.test(name)
    ? "claude"
    : /opencode/i.test(name)
      ? "opencode"
      : /codex|openai/i.test(name)
        ? "codex"
        : null;
  return agent ? (
    <span
      aria-hidden="true"
      className={styles.agentLogo}
      style={{ maskImage: `url(/agents/${agent}.svg)` }}
    />
  ) : (
    <Icon name="plug" size={28} />
  );
}

function Connections({
  initialClients,
  ...props
}: SetupPromptProps & { initialClients: AuthorizedClient[] }) {
  const [clients, setClients] = useState(initialClients);
  const [leavingSetup, setLeavingSetup] = useState<{ copied: boolean } | null>(null);
  const [adding, setAdding] = useState(false);
  const [revoking, setRevoking] = useState(false);
  const access = useRef({ clients: initialClients, generation: 0, revoking: false });
  const agentsHeading = useRef<HTMLDivElement>(null);
  const panelTitle = useRef<HTMLHeadingElement>(null);
  const wasAdding = useRef(false);
  const panelId = useId();
  const { copied, onCopied } = props;

  useEffect(() => {
    if (!leavingSetup) return;
    // Also retire the inert setup if animations are disabled or interrupted.
    const timer = setTimeout(() => setLeavingSetup(null), 200);
    return () => clearTimeout(timer);
  }, [leavingSetup]);

  useEffect(() => {
    if (adding) panelTitle.current?.focus();
    else if (wasAdding.current) agentsHeading.current?.querySelector("button")?.focus();
    wasAdding.current = adding;
  }, [adding]);

  useEffect(() => {
    let disposed = false;
    let inFlight = false;
    let timer: ReturnType<typeof setTimeout>;
    const settingUp = () => copied && (!access.current.clients.length || adding);
    let delay = authorizationRefreshDelay(0, { settingUp: settingUp(), changed: true });
    const schedule = () => {
      timer = setTimeout(() => void refresh(), delay);
    };
    const reportPollError = appErrorReporter("integration_update");
    let failureReported = false;
    async function refresh() {
      if (inFlight || disposed) return;
      clearTimeout(timer);
      if (document.hidden || !navigator.onLine || access.current.revoking) {
        schedule();
        return;
      }
      inFlight = true;
      const generation = access.current.generation;
      try {
        const result = await checkAuthorizedAgents();
        failureReported = false;
        if (!disposed && generation === access.current.generation) {
          const changed = Boolean(
            result.clients && !sameAuthorizations(access.current.clients, result.clients),
          );
          if (result.clients) {
            const previous = new Set(access.current.clients.map((client) => client.clientId));
            if (
              !previous.size &&
              result.clients.length &&
              !window.matchMedia("(prefers-reduced-motion: reduce)").matches
            ) {
              setLeavingSetup({ copied });
            }
            if (result.clients.some((client) => !previous.has(client.clientId))) {
              setAdding(false);
            }
            access.current.clients = result.clients;
            if (changed) setClients(result.clients);
          }
          delay = authorizationRefreshDelay(delay, { settingUp: settingUp(), changed });
        }
      } catch (cause) {
        if (!disposed && !failureReported) reportPollError(cause);
        failureReported = true;
        // Keep the last known authorization state when a background refresh fails.
        delay = authorizationRefreshDelay(delay, { settingUp: settingUp(), changed: false });
      } finally {
        inFlight = false;
        if (!disposed) schedule();
      }
    }
    function wake() {
      if (!document.hidden) void refresh();
    }
    schedule();
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
  }, [copied, adding]);

  async function revoke(clientId: string) {
    access.current.generation++;
    access.current.revoking = true;
    setRevoking(true);
    try {
      const result = await revokeAgent(clientId);
      if (result.error) throw new Error(result.error);
      const remaining = access.current.clients.filter((client) => client.clientId !== clientId);
      access.current.clients = remaining;
      setClients(remaining);
      if (!remaining.length) {
        setLeavingSetup(null);
        setAdding(false);
        onCopied(false);
      }
    } finally {
      access.current.generation++;
      access.current.revoking = false;
      setRevoking(false);
    }
  }

  return (
    <div className={styles.authorizationState}>
      {(!clients.length || leavingSetup) && (
        <div
          key="setup"
          className={leavingSetup ? styles.leavingSetup : undefined}
          aria-hidden={leavingSetup ? true : undefined}
          inert={Boolean(leavingSetup)}
        >
          <EmptySetup {...props} copied={leavingSetup?.copied ?? copied} />
        </div>
      )}
      {clients.length > 0 && (
        <div key="agents" className={leavingSetup ? styles.enteringAgents : undefined}>
          <div ref={agentsHeading} className={styles.agentsHeading}>
            <h2 data-ph-public className="text-base font-medium">
              Your agents
            </h2>
            <Button
              type="button"
              data-ph-public
              hidden={adding}
              aria-expanded={adding}
              aria-controls={panelId}
              className={styles.addButton}
              onClick={() => {
                onCopied(false);
                setAdding(true);
              }}
            >
              <span aria-hidden="true">+</span> Connect another agent
            </Button>
          </div>
          <ul aria-label="Your agents" className={styles.agentList}>
            {clients.map((client) => (
              <li key={client.clientId} className={styles.agentRow}>
                <div className={styles.agentIdentity}>
                  <AgentLogo name={client.name} />
                  <div className="min-w-0">
                    <p className={styles.agentName}>{client.name}</p>
                    <p data-ph-public className={styles.agentScope}>
                      Access to your Tidy account
                    </p>
                  </div>
                </div>
                <div className={styles.agentActions}>
                  <span data-ph-public className={styles.authorized}>
                    <span aria-hidden="true" />
                    Authorized
                  </span>
                  <ConfirmAction
                    replayLabel
                    label="Revoke access"
                    title={`Revoke ${client.name} access?`}
                    disabled={revoking}
                    className={styles.revokeButton}
                    onConfirm={() => revoke(client.clientId)}
                  >
                    This agent will lose access to your Tidy account. You can connect it again
                    later.
                  </ConfirmAction>
                </div>
              </li>
            ))}
          </ul>
          {adding ? (
            <section id={panelId} aria-labelledby={`${panelId}-title`} className={styles.addPanel}>
              <div className={styles.panelHeading}>
                <h2
                  id={`${panelId}-title`}
                  ref={panelTitle}
                  tabIndex={-1}
                  data-ph-public
                  className={styles.panelTitle}
                >
                  Connect another agent
                </h2>
                <Button
                  type="button"
                  data-ph-public
                  className={styles.cancelButton}
                  onClick={() => {
                    setAdding(false);
                    onCopied(false);
                  }}
                >
                  Cancel
                </Button>
              </div>
              <McpPromptButton {...props} />
              <ManualSetup resourceUrl={props.resourceUrl} />
            </section>
          ) : (
            <ManualSetup resourceUrl={props.resourceUrl} />
          )}
        </div>
      )}
    </div>
  );
}

export function McpConnection({
  clients,
  resourceUrl,
  organizationId,
}: {
  clients: AuthorizedClient[] | Promise<AuthorizedClient[]>;
  resourceUrl: string;
  organizationId: string;
}) {
  const [copied, setCopied] = useState(false);
  const prompt = { resourceUrl, organizationId, copied, onCopied: setCopied };
  return (
    <section className={styles.connection}>
      <McpPageHeading />
      <div className={styles.content}>
        <DeferredSection
          value={clients}
          label="authorized agents"
          fallback={<McpConnectionsSkeleton />}
        >
          {(loaded) => <Connections initialClients={loaded} {...prompt} />}
        </DeferredSection>
      </div>
    </section>
  );
}
