"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import type { ConnectionStatus } from "@/lib/agents/protocol";

type Login = { loginId: string; verificationUrl: string; userCode: string };
export function AgentConnectionSettings({ initial }: { initial: ConnectionStatus }) {
  const [connection, setConnection] = useState(initial);
  const [login, setLogin] = useState<Login | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  useEffect(() => {
    if (!login) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const started = Date.now();
    const poll = async () => {
      try {
        const response = await fetch("/api/agents/connection", {
          method: "PATCH",
          signal: controller.signal,
        });
        const data = (await response.json()) as ConnectionStatus;
        if (controller.signal.aborted) return;
        if (response.ok) {
          setConnection(data);
          if (data.status === "connected") {
            setLogin(null);
            return;
          }
        }
        if (Date.now() - started > 10 * 60_000) {
          setLogin(null);
          setError("Sign-in expired. Connect again to get a new code.");
          return;
        }
      } catch {
        if (controller.signal.aborted) return;
      }
      timer = setTimeout(poll, 2500);
    };
    timer = setTimeout(poll, 1500);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [login]);
  async function connect() {
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/agents/connection", { method: "POST" });
      const data = (await response.json()) as Login & { error?: string };
      if (!response.ok) throw new Error(data.error);
      setLogin(data);
      setConnection((current) => ({ ...current, status: "connecting" }));
    } catch (error) {
      setError(error instanceof Error ? error.message : "Could not connect Codex.");
    } finally {
      setBusy(false);
    }
  }
  async function disconnect() {
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/agents/connection", { method: "DELETE" });
      if (!response.ok) throw new Error(((await response.json()) as { error?: string }).error);
      setLogin(null);
      setConnection((current) => ({ ...current, status: "disconnected", accountLabel: null }));
    } catch (error) {
      setError(error instanceof Error ? error.message : "Could not disconnect.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="max-w-lg space-y-5" aria-labelledby="codex-connection-title">
      <div>
        <h2 id="codex-connection-title" className="text-lg font-semibold">
          Codex
        </h2>
        <p className="mt-2 text-sm leading-6 text-secondary-ink">
          Use your Codex subscription for shared design threads. Your connection stays personal.
        </p>
      </div>
      {connection.status === "connected" ? (
        <>
          <div>
            <p className="text-sm font-medium">{connection.accountLabel}</p>
            <p className="mt-1 text-xs text-secondary-ink">Connected</p>
          </div>
          <div className="flex items-center gap-5">
            <a
              href={connection.usageUrl}
              target="_blank"
              rel="noreferrer"
              className="text-sm underline underline-offset-4"
            >
              Manage usage
            </a>
            <Button variant="text" disabled={busy} onClick={() => void disconnect()}>
              Disconnect
            </Button>
          </div>
          <p className="text-xs leading-5 text-secondary-ink">
            Runs continue when you close Tidy. Disconnecting stops your runs. Shared threads remain
            available to your team.
          </p>
        </>
      ) : login ? (
        <div className="space-y-3">
          <p className="text-sm">Enter this code on the Codex sign-in page:</p>
          <p className="select-all font-mono text-xl tracking-wider">{login.userCode}</p>
          <a
            href={login.verificationUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex rounded-lg border border-primary-grey px-4 py-2 text-sm hover:bg-hover-surface"
          >
            Open Codex sign-in
          </a>
          <p role="status" className="text-xs text-secondary-ink">
            Waiting for you to finish signing in…
          </p>
          <Button variant="text" disabled={busy} onClick={() => void disconnect()}>
            Cancel
          </Button>
        </div>
      ) : (
        <>
          <Button disabled={busy || !connection.configured} onClick={() => void connect()}>
            {busy ? "Connecting…" : "Connect Codex"}
          </Button>
          {!connection.configured && (
            <p className="text-sm text-secondary-ink">
              Codex connections are not available in this workspace yet.
            </p>
          )}
          {connection.status === "reconnect" && (
            <p className="text-sm text-secondary-ink">Your Codex connection needs to be renewed.</p>
          )}
        </>
      )}
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
    </section>
  );
}
