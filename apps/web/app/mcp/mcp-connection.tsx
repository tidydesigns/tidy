"use client";

import { useCallback, useEffect, useState } from "react";
import { DeferredSection } from "@/components/ui/deferred-section";
import { Button } from "@/components/ui/button";
import { ConfirmAction } from "@/components/ui/confirm-action";
import { SelectMenu } from "@/components/ui/select-menu";
import { checkAuthorizedAgents, revokeAgent } from "./actions";
import { agentOptions, setupFor, type Agent, type SetupValue } from "./agent-setup";
import { useFeatureFlag } from "@/lib/use-feature-flag";

type AuthorizedClient = { clientId: string; name: string };
type EndpointStatus = "checking" | "ready" | "unavailable" | "misconfigured";
function CopyableValue({ value, copyLabel }: SetupValue) {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");

  async function copy() {
    setError("");
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
    } catch {
      setCopied(false);
      setError("Could not copy. Copy the text manually.");
    }
  }

  return (
    <div>
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-5 gap-y-2 rounded-lg border border-primary-grey/70 bg-surface/40 px-4 py-3">
        <code className="min-w-0 select-text break-all font-mono text-xs leading-5">{value}</code>
        <Button
          type="button"
          variant="text"
          onClick={() => void copy()}
          aria-label={copyLabel}
          className="shrink-0 rounded px-1 py-1 text-xs font-medium transition-transform duration-150 ease-out hover:text-primary-black active:scale-[0.97] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-orange"
        >
          <span role="status">{copied ? "Copied" : copyLabel}</span>
        </Button>
      </div>
      {error && (
        <p role="alert" className="mt-2 text-xs text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

async function probeEndpoint(resourceUrl: string): Promise<EndpointStatus> {
  try {
    const signal = AbortSignal.timeout(10_000);
    const metadata = await fetch("/.well-known/oauth-protected-resource/api/mcp", {
      cache: "no-store",
      signal,
    });
    if (!metadata.ok) return "unavailable";
    const details: { resource?: string } = await metadata.json();
    if (details.resource !== resourceUrl) return "misconfigured";
    const response = await fetch("/api/mcp", {
      signal,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "tidy-connection-check", version: "1" },
        },
      }),
    });
    return response.status === 401 || response.ok ? "ready" : "unavailable";
  } catch {
    return "unavailable";
  }
}

export function McpConnection({
  clients,
  resourceUrl,
}: {
  clients: AuthorizedClient[] | Promise<AuthorizedClient[]>;
  resourceUrl: string;
}) {
  const [currentClients, setClients] = useState<AuthorizedClient[]>();
  const [error, setError] = useState("");
  const [endpoint, setEndpoint] = useState<EndpointStatus>("checking");
  const [checking, setChecking] = useState(false);
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

  const check = useCallback(async () => {
    setError("");
    setChecking(true);
    setEndpoint("checking");
    setEndpoint(await probeEndpoint(resourceUrl));
    try {
      const result = await checkAuthorizedAgents();
      if (result.error) setError(result.error);
      if (result.clients) setClients(result.clients);
    } catch {
      setError("Could not check authorized agents.");
    } finally {
      setChecking(false);
    }
  }, [resourceUrl]);

  useEffect(() => {
    let active = true;
    void probeEndpoint(resourceUrl).then((status) => {
      if (active) setEndpoint(status);
    });
    return () => {
      active = false;
    };
  }, [resourceUrl]);

  const endpointLabel =
    endpoint === "checking"
      ? "Checking…"
      : endpoint === "ready"
        ? "Ready"
        : endpoint === "misconfigured"
          ? "Address mismatch"
          : "Unavailable";

  return (
    <section className="min-w-0">
      <h1 data-ph-public className="text-3xl font-semibold tracking-tight">
        Connect your agent
      </h1>
      <p data-ph-public className="mt-2 text-sm text-secondary-ink">
        Read, create, and edit Tidy designs from your agent.
      </p>

      <div className="mt-6">
        <SelectMenu
          replayOptions
          replayLabel
          label="Agent"
          value={agent}
          onChange={(value) => setAgent(value as Agent)}
          options={options}
          className="w-[210px] max-w-full"
        />
      </div>

      <ol key={agent} className="mt-6 space-y-6">
        {setup.steps.map((step, index) => (
          <li key={step.title} className="flex min-w-0 items-start gap-4">
            <span
              aria-hidden="true"
              className="flex size-[26px] shrink-0 items-center justify-center rounded-full border border-primary-grey text-xs text-secondary-ink"
            >
              {index + 1}
            </span>
            <div className="min-w-0 flex-1">
              <h2 className="text-[15px] font-semibold leading-[26px]">{step.title}</h2>
              <p className="mt-1 text-[13px] leading-5 text-secondary-ink">{step.description}</p>
              {step.values.map((item) => (
                <div key={item.value} className="mt-2">
                  <CopyableValue {...item} />
                </div>
              ))}
            </div>
          </li>
        ))}
      </ol>

      <DeferredSection value={currentClients ?? clients} label="authorized agents">
        {(loadedClients) => (
          <>
            {loadedClients.length > 0 && (
              <div className="mt-6 border-t border-primary-grey/70 pt-4">
                <h2 data-ph-public className="text-sm font-medium">
                  Authorized agents
                </h2>
                <ul className="mt-2 space-y-2">
                  {loadedClients.map((client) => (
                    <li
                      key={client.clientId}
                      className="flex flex-wrap items-center justify-between gap-3 text-sm"
                    >
                      <span>{client.name}</span>
                      <ConfirmAction
                        replayLabel
                        label="Revoke access"
                        title={`Revoke ${client.name} access?`}
                        disabled={checking}
                        className="rounded px-1 py-1 text-xs text-danger hover:bg-danger/5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-danger disabled:opacity-50"
                        onConfirm={async () => {
                          const result = await revokeAgent(client.clientId);
                          if (result.error) throw new Error(result.error);
                          setClients((current) =>
                            (current ?? loadedClients).filter(
                              (item) => item.clientId !== client.clientId,
                            ),
                          );
                        }}
                      >
                        <span data-ph-public style={{ display: "contents" }}>
                          This agent will lose access to Tidy until you reconnect it.
                        </span>
                      </ConfirmAction>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}
      </DeferredSection>

      <details className="group mt-4 border-t border-primary-grey/70">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 rounded py-3 text-[13px] text-secondary-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-orange [&::-webkit-details-marker]:hidden">
          <span data-ph-public style={{ display: "contents" }}>
            Connection help
          </span>
          <svg
            data-ph-public
            aria-hidden="true"
            width="16"
            height="16"
            viewBox="0 0 16 16"
            fill="none"
            className="shrink-0 group-open:rotate-180"
          >
            <path
              d="m3.5 6 4.5 4 4.5-4"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </summary>
        <div className="max-h-80 space-y-4 overflow-y-auto pb-4 text-[13px] leading-5 text-secondary-ink">
          {setup.connectionCheck && (
            <div>
              <p data-ph-public className="mb-2">
                Check from your terminal:
              </p>
              <CopyableValue
                key={`${agent}-check`}
                value={setup.connectionCheck}
                copyLabel="Copy command"
              />
            </div>
          )}
          <p data-ph-public>Sign-in timed out? Close the browser tab and try step 2 again.</p>
          {agent === "opencode" && (
            <div>
              <p data-ph-public className="mb-2">
                Can read but cannot edit? Clear the old sign-in, then repeat step 2 and approve
                design read and write access.
              </p>
              <CopyableValue value={`opencode mcp logout ${name}`} copyLabel="Copy command" />
            </div>
          )}
          {agent === "other" && <p data-ph-public>Your agent must support OAuth.</p>}
          {name === "tidy-local" && <p data-ph-public>Keep Tidy running while you connect.</p>}
          <div>
            <div className="flex items-center justify-between gap-3">
              <h2 data-ph-public className="font-medium text-primary-black">
                Server
              </h2>
              <p role="status">{endpointLabel}</p>
            </div>
            <p className="mt-2 break-all font-mono text-xs">{resourceUrl}</p>
            {endpoint === "misconfigured" && (
              <p data-ph-public className="mt-2">
                Server addresses do not match. Check Tidy’s public URL configuration.
              </p>
            )}
            {endpoint === "unavailable" && (
              <p data-ph-public className="mt-2">
                Server unavailable. Check that Tidy is running, then retry.
              </p>
            )}
          </div>
          <Button
            type="button"
            variant="text"
            disabled={checking}
            onClick={() => void check()}
            className="rounded border border-primary-grey px-3 py-2 text-xs font-medium text-primary-black hover:bg-hover-surface focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-orange disabled:opacity-50"
          >
            <span data-ph-public style={{ display: "contents" }}>
              {checking ? "Checking…" : "Check server access"}
            </span>
          </Button>
          <p data-ph-public className="text-xs">
            This checks server access. Use step 3 to test your agent.
          </p>
          {error && (
            <p role="alert" className="text-danger">
              {error}
            </p>
          )}
        </div>
      </details>
    </section>
  );
}
