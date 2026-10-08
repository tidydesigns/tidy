"use client";

import { useCallback, useEffect, useState } from "react";
import { ConfirmAction } from "@/components/ui/confirm-action";
import { SelectMenu } from "@/components/ui/select-menu";
import { checkAuthorizedAgents, revokeAgent } from "./actions";

type AuthorizedClient = { clientId: string; name: string };
type EndpointStatus = "checking" | "ready" | "unavailable" | "misconfigured";
type Agent = "codex" | "claude" | "opencode" | "pi" | "gemini" | "other";

function setupFor(agent: Agent, name: string, resourceUrl: string) {
  switch (agent) {
    case "codex":
      return {
        command: `codex mcp add ${name} --url ${resourceUrl}`,
        next: `Run codex mcp login ${name}, then check the connection with codex mcp list. If sign-in times out, close that tab and run the login command again.`,
      };
    case "claude":
      return {
        command: `claude mcp add --transport http --scope user ${name} ${resourceUrl}`,
        next: "Open /mcp in Claude Code, select this server, and complete sign-in.",
      };
    case "opencode":
      return {
        command: `opencode mcp add ${name} --url ${resourceUrl}`,
        next: `Run opencode mcp auth ${name}, then check the connection with opencode mcp list.`,
      };
    case "pi":
      return {
        command: `pi mcp add ${name} --url ${resourceUrl}`,
        next: `Run pi mcp login ${name}, then check the connection with pi mcp list.`,
      };
    case "gemini":
      return {
        command: `gemini mcp add --transport http --scope user ${name} ${resourceUrl}`,
        next: `Run /mcp auth ${name} in Gemini CLI, then check the connection with /mcp list.`,
      };
    case "other":
      return {
        command: resourceUrl,
        next: "Add this URL as a remote Streamable HTTP MCP server. Enable browser-based OAuth discovery and sign in when your client asks. Your client must support OAuth for protected MCP servers.",
      };
  }
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
  clients: AuthorizedClient[];
  resourceUrl: string;
}) {
  const [currentClients, setClients] = useState(clients);
  const [error, setError] = useState("");
  const [endpoint, setEndpoint] = useState<EndpointStatus>("checking");
  const [checking, setChecking] = useState(false);
  const [copied, setCopied] = useState("");
  const [agent, setAgent] = useState<Agent>("codex");
  const name = ["localhost", "127.0.0.1", "::1"].includes(new URL(resourceUrl).hostname)
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

  async function copySetup() {
    try {
      await navigator.clipboard.writeText(setup.command);
      setCopied(setup.command);
    } catch {
      setCopied("");
    }
  }

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
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h1 className="text-3xl font-semibold tracking-tight">MCP</h1>
        <button
          type="button"
          onClick={() => void check()}
          disabled={checking}
          className="rounded-lg border border-primary-grey px-4 py-2.5 text-sm font-medium hover:bg-primary-grey/20 disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-orange"
        >
          {checking ? "Checking…" : "Check connection"}
        </button>
      </div>
      {error && (
        <p role="alert" className="mt-3 text-sm text-danger">
          {error}
        </p>
      )}
      <p className="mt-4 text-sm text-secondary-ink">
        Connect a coding agent to create and read Tidy design files.
      </p>

      <div className="mt-10 border-t border-primary-grey/70 py-6">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <h2 className="text-lg font-semibold">Endpoint</h2>
          <p role="status" className="text-sm text-secondary-ink">
            {endpointLabel}
          </p>
        </div>
        <p className="mt-2 break-all font-mono text-xs text-secondary-ink">{resourceUrl}</p>
        {endpoint === "misconfigured" && (
          <p className="mt-3 text-sm text-secondary-ink">
            This page and the MCP endpoint report different addresses. Check the Tidy public URL
            configuration.
          </p>
        )}
        {endpoint === "unavailable" && (
          <p className="mt-3 text-sm text-secondary-ink">
            The MCP endpoint is not responding. Check that Tidy is running, then try again.
          </p>
        )}
      </div>

      <div className="border-t border-primary-grey/70 py-6">
        <h2 className="text-lg font-semibold">Authorized agents</h2>
        {currentClients.length ? (
          <ul className="mt-3 space-y-3">
            {currentClients.map((client) => (
              <li
                key={client.clientId}
                className="flex flex-wrap items-baseline justify-between gap-3 text-sm"
              >
                <span>{client.name}</span>
                <ConfirmAction
                  label="Revoke access"
                  title={`Revoke ${client.name} access?`}
                  disabled={checking}
                  onConfirm={async () => {
                    const result = await revokeAgent(client.clientId);
                    if (result.error) throw new Error(result.error);
                    setClients((current) =>
                      current.filter((item) => item.clientId !== client.clientId),
                    );
                  }}
                >
                  This agent will lose access to your Tidy account until you authorize it again.
                </ConfirmAction>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-3 text-sm text-secondary-ink">
            No coding agent is authorized for this account yet.
          </p>
        )}
        {!currentClients.length && (
          <a
            href="#mcp-setup"
            className="mt-5 inline-flex rounded-lg bg-strong-action px-4 py-2.5 text-sm font-medium text-on-strong-action hover:bg-strong-action-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-orange"
          >
            Get started
          </a>
        )}
      </div>

      <div id="mcp-setup" className="border-t border-primary-grey/70 py-6">
        <h2 className="text-lg font-semibold">Connect an agent</h2>
        <p className="mt-3 text-sm text-secondary-ink">
          Use a remote Streamable HTTP MCP client with OAuth. Sign in to Tidy when your agent
          prompts you.
        </p>
        <span id="mcp-agent-label" className="mt-5 block text-sm font-medium">
          Agent
        </span>
        <SelectMenu
          label="Agent"
          labelledBy="mcp-agent-label"
          value={agent}
          onChange={(value) => setAgent(value as Agent)}
          options={[
            { value: "codex", label: "Codex" },
            { value: "claude", label: "Claude Code" },
            { value: "opencode", label: "OpenCode" },
            { value: "pi", label: "Pi" },
            { value: "gemini", label: "Gemini CLI" },
            { value: "other", label: "Other MCP client" },
          ]}
          className="mt-2 w-52 max-w-full"
        />
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-primary-grey/70 px-4 py-3">
          <code className="min-w-0 break-all text-xs">{setup.command}</code>
          <button
            type="button"
            onClick={() => void copySetup()}
            className="shrink-0 text-sm font-medium underline decoration-primary-orange underline-offset-4 hover:text-accent-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-orange"
          >
            {copied === setup.command ? "Copied" : agent === "other" ? "Copy URL" : "Copy command"}
          </button>
        </div>
        <p className="mt-4 text-sm text-secondary-ink">{setup.next}</p>
        {name === "tidy-local" && (
          <p className="mt-2 text-sm text-secondary-ink">
            Keep Tidy running on this computer while your agent connects.
          </p>
        )}
      </div>
    </section>
  );
}
