"use client";

import { useErrorNotice } from "@/lib/use-error-notice";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  connectionStatusSchema,
  nativeLoginSchema,
  agentOkSchema,
  type ConnectionStatus,
  type NativeLogin,
} from "@/lib/agents/protocol";
import { readJsonResponse } from "@/lib/http/json-response";

export function AgentConnectionSettings({ initial }: { initial: ConnectionStatus }) {
  const [connection, setConnection] = useState(initial);
  const [login, setLogin] = useState<NativeLogin | null>(null);
  const [busy, setBusy] = useState(false);
  const [, setError] = useErrorNotice("", "integration_update");
  useEffect(() => {
    if (!login) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const started = Date.now();
    let notifyError = setError("");
    let failing = false;
    const poll = async () => {
      if (Date.now() - started > 10 * 60_000) {
        setLogin(null);
        notifyError("Sign-in expired. Connect again to get a new code.");
        return;
      }
      try {
        const response = await fetch("/api/agents/connection", {
          method: "PATCH",
          signal: controller.signal,
        });
        const data = await readJsonResponse({
          response,
          schema: connectionStatusSchema,
          message: "Could not check Codex connection.",
        });
        if (controller.signal.aborted) return;
        if (failing) {
          notifyError = setError("");
          failing = false;
        }
        setConnection(data);
        if (data.status === "connected") {
          setLogin(null);
          return;
        }
      } catch (cause) {
        if (controller.signal.aborted) return;
        if (!failing) notifyError(cause, "Could not check the connection. Retrying…");
        failing = true;
      }
      timer = setTimeout(poll, 2500);
    };
    timer = setTimeout(poll, 1500);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [login, setError]);
  async function connect() {
    const notifyError = setError("");
    setBusy(true);

    try {
      const response = await fetch("/api/agents/connection", { method: "POST" });
      const data = await readJsonResponse({
        response,
        schema: nativeLoginSchema,
        message: "Could not connect Codex.",
      });
      setLogin(data);
      setConnection((current) => ({ ...current, status: "connecting" }));
    } catch (error) {
      notifyError(error, "Could not connect Codex.");
    } finally {
      setBusy(false);
    }
  }
  async function disconnect() {
    const notifyError = setError("");
    setBusy(true);

    try {
      const response = await fetch("/api/agents/connection", { method: "DELETE" });
      await readJsonResponse({ response, schema: agentOkSchema, message: "Could not disconnect." });
      setLogin(null);
      setConnection((current) => ({ ...current, status: "disconnected", accountLabel: null }));
    } catch (error) {
      notifyError(error, "Could not disconnect.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="max-w-lg space-y-5" aria-labelledby="codex-connection-title">
      <div>
        <h2 data-ph-public id="codex-connection-title" className="text-lg font-semibold">
          Codex
        </h2>
        <p data-ph-public className="mt-2 text-sm leading-6 text-secondary-ink">
          Use your Codex subscription for shared design threads. Other workspace members need their
          own Codex connection to start runs.
        </p>
      </div>
      {connection.status === "connected" ? (
        <>
          <div>
            <p className="text-sm font-medium">{connection.accountLabel}</p>
            <p data-ph-public className="mt-1 text-xs text-secondary-ink">
              Connected
            </p>
          </div>
          <div className="flex items-center gap-5">
            <a
              data-ph-public
              href={connection.usageUrl}
              target="_blank"
              rel="noreferrer"
              className="text-sm underline underline-offset-4"
            >
              Manage usage
            </a>
            <Button variant="text" disabled={busy} onClick={() => void disconnect()}>
              <span data-ph-public style={{ display: "contents" }}>
                Disconnect
              </span>
            </Button>
          </div>
          <p data-ph-public className="text-xs leading-5 text-secondary-ink">
            Runs continue when you close Tidy. Disconnecting stops your runs. Shared threads remain
            available to your team.
          </p>
        </>
      ) : login ? (
        <div className="space-y-3">
          <p data-ph-public className="text-sm">
            Enter this code on the Codex sign-in page:
          </p>
          <p className="select-all font-mono text-xl tracking-wider">{login.userCode}</p>
          <a
            data-ph-public
            href={login.verificationUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex rounded-lg border border-primary-grey px-4 py-2 text-sm hover:bg-hover-surface"
          >
            Open Codex sign-in
          </a>
          <p data-ph-public role="status" className="text-xs text-secondary-ink">
            Waiting for you to finish signing in…
          </p>
          <Button variant="text" disabled={busy} onClick={() => void disconnect()}>
            <span data-ph-public style={{ display: "contents" }}>
              Cancel
            </span>
          </Button>
        </div>
      ) : (
        <>
          <Button disabled={busy || !connection.configured} onClick={() => void connect()}>
            <span data-ph-public style={{ display: "contents" }}>
              {busy ? "Connecting…" : "Connect Codex"}
            </span>
          </Button>
          {!connection.configured && (
            <p data-ph-public className="text-sm text-secondary-ink">
              Codex connections are not available in this workspace yet.
            </p>
          )}
          {connection.status === "reconnect" && (
            <p data-ph-public className="text-sm text-secondary-ink">
              Your Codex connection needs to be renewed.
            </p>
          )}
        </>
      )}
    </section>
  );
}
