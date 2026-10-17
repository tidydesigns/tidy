"use client";

import { useState } from "react";
import posthog from "@/lib/posthog-client";
import { connectionStatusSchema, type ConnectionStatus } from "@/lib/github/connection-contract";
import { readJsonResponse } from "@/lib/http/json-response";
import { z } from "zod";

const button =
  "rounded-md border border-primary-grey/80 bg-surface px-3 py-2 text-sm hover:bg-primary-grey/20 disabled:opacity-50";
export function GitHubSettings({
  organizationId,
  canManage,
  initial,
  callbackStatus,
}: {
  organizationId: string;
  canManage: boolean;
  initial: ConnectionStatus;
  callbackStatus?: string;
}) {
  const [status, setStatus] = useState(initial);
  const [error, setError] = useState(
    initial.error ??
      (callbackStatus === "retry"
        ? "Authorization could not be verified. Connect GitHub again from here."
        : ""),
  );
  const [busy, setBusy] = useState(false);
  async function attach(installationId: number) {
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/github/connection", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ organizationId, installationId }),
      });
      const data = await readJsonResponse({
        response,
        schema: connectionStatusSchema,
        message: "Could not update GitHub connection.",
      });
      setStatus(data);
      posthog.capture("github_installation_linked");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not link installation.");
    } finally {
      setBusy(false);
    }
  }
  async function disconnect() {
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/github/connection", { method: "DELETE" });
      if (!response.ok)
        await readJsonResponse({ response, schema: z.unknown(), message: "Could not disconnect." });
      setStatus((current) => ({ ...current, login: null, installations: [] }));
      posthog.capture("github_account_disconnected");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not disconnect.");
    } finally {
      setBusy(false);
    }
  }
  if (!status.ready || !status.configured)
    return (
      <p data-ph-public className="text-sm text-secondary-ink">
        {!status.ready
          ? "GitHub integration is awaiting its database migration."
          : "GitHub integration is awaiting its server credentials."}
      </p>
    );
  return (
    <div className="max-w-xl space-y-5">
      <div className="flex flex-wrap items-center gap-3">
        {status.login && (
          <span className="text-sm">
            <span data-ph-public style={{ display: "contents" }}>
              Connected as{" "}
            </span>
            {status.login}
          </span>
        )}
        <form action="/api/github/connect" method="post">
          <input type="hidden" name="organizationId" value={organizationId} />
          <button data-ph-public className={button}>
            {status.login ? "Reconnect GitHub" : "Connect GitHub"}
          </button>
        </form>
        {status.login && (
          <button
            data-ph-public
            className={button}
            disabled={busy}
            onClick={() => void disconnect()}
          >
            Disconnect account
          </button>
        )}
      </div>
      {status.connections.length > 0 && (
        <ul className="space-y-2">
          {status.connections.map((item) => (
            <li key={item.installationId} className="text-sm">
              {item.account}{" "}
              <span data-ph-public className="text-secondary-ink">
                {item.active ? "Linked" : "Access suspended or removed"}
              </span>
            </li>
          ))}
        </ul>
      )}
      {canManage && status.login && (
        <>
          <a
            data-ph-public
            href={status.installUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-block text-sm underline decoration-primary-orange underline-offset-4"
          >
            Install on a GitHub account
          </a>
          <p data-ph-public className="text-xs text-secondary-ink">
            After installing, return here to refresh the available installations.
          </p>
          <button
            data-ph-public
            className={button}
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setError("");
              try {
                const response = await fetch(
                  `/api/github/connection?organizationId=${encodeURIComponent(organizationId)}`,
                );
                const data = await readJsonResponse({
                  response,
                  schema: connectionStatusSchema,
                  message: "Could not update GitHub connection.",
                });
                setStatus(data);
                setError(data.error ?? "");
              } catch (e) {
                setError(e instanceof Error ? e.message : "Could not refresh installations.");
              } finally {
                setBusy(false);
              }
            }}
          >
            Refresh installations
          </button>
          {status.installations
            .filter(
              (item) =>
                !status.connections.some(
                  (connection) =>
                    connection.installationId === String(item.id) && connection.active,
                ),
            )
            .map((item) => (
              <div
                key={item.id}
                className="flex items-center justify-between gap-3 rounded-lg border border-primary-grey/70 p-3"
              >
                <span className="text-sm">
                  {item.account?.login?.trim() || "Unknown GitHub account"}
                </span>
                <button
                  data-ph-public
                  disabled={busy}
                  className={button}
                  onClick={() => void attach(item.id)}
                >
                  Link organisation
                </button>
              </div>
            ))}
        </>
      )}
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
