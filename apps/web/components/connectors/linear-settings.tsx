"use client";

import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import type { ConnectorStatus } from "@/lib/connectors/catalog";

const button =
  "rounded-md border border-border bg-surface px-3 py-2 text-sm font-medium hover:bg-canvas focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink disabled:opacity-50 disabled:cursor-wait";
export function LinearSettings({
  organizationId,
  initial,
  callbackStatus,
}: {
  organizationId: string;
  initial: ConnectorStatus;
  callbackStatus?: string;
}) {
  const [connections, setConnections] = useState(initial.connections);
  const [error, setError] = useState(
    initial.error ??
      (callbackStatus === "retry"
        ? "Linear could not be connected. Try again and choose the same workspace when reconnecting."
        : ""),
  );
  const [busy, setBusy] = useState<string | null>(null);
  const inFlight = useRef(false);
  async function disconnect(connectionId: string) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(connectionId);
    setError("");
    try {
      const response = await fetch("/api/linear/connection", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ organizationId, connectionId }),
      });
      if (!response.ok)
        throw new Error(
          ((await response.json()) as { error?: string }).error ?? "Could not disconnect Linear.",
        );
      setConnections((current) => current.filter((connection) => connection.id !== connectionId));
    } catch (error) {
      setError(error instanceof Error ? error.message : "Could not disconnect Linear.");
    } finally {
      inFlight.current = false;
      setBusy(null);
    }
  }
  const available = initial.ready && initial.configured;
  return (
    <div className="space-y-4">
      {connections.length > 0 && (
        <ul className="max-h-72 space-y-3 overflow-y-auto" aria-label="Your Linear connections">
          {connections.map((connection) => (
            <li
              key={connection.id}
              className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border px-4 py-3"
            >
              <div className="min-w-0">
                <p className="break-words text-sm font-medium">{connection.workspaceName}</p>
                <p className="mt-1 break-words text-xs text-secondary-ink">
                  {connection.accountName} ·{" "}
                  {connection.state === "connected" ? "Connected" : "Reconnect to restore access"}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {available && (
                  <form action="/api/linear/connect" method="post">
                    <input type="hidden" name="organizationId" value={organizationId} />
                    <input type="hidden" name="accountId" value={connection.accountId} />
                    <Button className={button} disabled={busy !== null}>
                      Reconnect
                    </Button>
                  </form>
                )}
                <Button
                  className={button}
                  disabled={busy !== null}
                  onClick={() => void disconnect(connection.id)}
                >
                  {busy === connection.id ? "Disconnecting…" : "Disconnect"}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {available ? (
        <div className="flex flex-wrap items-center gap-4">
          <form action="/api/linear/connect" method="post">
            <input type="hidden" name="organizationId" value={organizationId} />
            <Button className={button} disabled={busy !== null}>
              {connections.length ? "Add Linear workspace" : "Connect Linear"}
            </Button>
          </form>
          <p className="text-xs text-secondary-ink">
            Read and update issues with your Linear permissions.
          </p>
        </div>
      ) : (
        <p className="text-sm text-secondary-ink">
          Linear is not available yet. Contact your Tidy administrator.
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      {callbackStatus === "connected" && !error && (
        <p role="status" className="text-sm text-secondary-ink">
          Linear connected.
        </p>
      )}
    </div>
  );
}
