"use client";

import { Dialog } from "@/components/ui/dialog";
import { useRef, useState } from "react";
import { Icon } from "@/components/ui/icon";
import { formatStorage, type PlanLimits } from "@/lib/billing/plans";

export function UpgradeDialog({
  organizationId,
  owner,
  firstMonthUsed,
  limits,
  triggerClassName,
  showIcon = false,
}: {
  organizationId: string;
  owner: boolean;
  firstMonthUsed: boolean;
  limits: PlanLimits;
  triggerClassName: string;
  showIcon?: boolean;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function checkout() {
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/billing/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ organizationId }),
      });
      const data = (await response.json()) as { url?: string; error?: string };
      if (!response.ok || !data.url) throw new Error(data.error ?? "Could not start checkout.");
      window.location.assign(data.url);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not start checkout.");
      setBusy(false);
    }
  }

  return (
    <>
      <button
        type="button"
        aria-haspopup="dialog"
        aria-controls="upgrade-dialog"
        onClick={() => dialog.current?.showModal()}
        className={`${triggerClassName} cursor-pointer text-left`}
      >
        {showIcon && <Icon name="upgrade" size={18} />}
        <span>Upgrade to Pro</span>
      </button>
      <Dialog
        ref={dialog}
        id="upgrade-dialog"
        aria-labelledby="upgrade-title"
        aria-describedby="upgrade-description"
        aria-busy={busy}
        onCancel={(event) => {
          if (busy) event.preventDefault();
        }}
      >
        <div className="flex items-start justify-between gap-4">
          <h2 id="upgrade-title" className="text-2xl font-semibold tracking-tight">
            Upgrade to Pro
          </h2>
          <button
            type="button"
            disabled={busy}
            onClick={() => dialog.current?.close()}
            aria-label="Close upgrade dialog"
            className="-mr-2 -mt-2 rounded-md px-2 py-1 text-xl text-primary-black/55 hover:text-primary-black focus-visible:outline-2 focus-visible:outline-primary-orange disabled:opacity-50"
          >
            ×
          </button>
        </div>
        <p id="upgrade-description" className="mt-3 text-sm text-primary-black/65">
          {limits.files === null ? "Unlimited design files" : `${limits.files} design files`},{" "}
          {limits.editors === null
            ? "all team members included"
            : `${limits.editors} editors included`}
          , and{" "}
          {limits.storageBytes === null
            ? "unlimited asset storage"
            : `${formatStorage(limits.storageBytes)} asset storage`}
          .
        </p>
        <p className="mt-2 text-sm text-primary-black/65">
          {limits.mcpCalls === null
            ? "Unlimited MCP calls"
            : `${limits.mcpCalls.toLocaleString()} MCP calls per month`}
          . Bring your own inference. Your provider’s limits apply.
        </p>

        <div className="mt-8 border-y border-primary-grey/70 py-6">
          <p className="text-3xl font-semibold tracking-tight">
            $10<span className="ml-1 text-sm font-normal text-primary-black/55">/ month</span>
          </p>
          <p className="mt-1 text-sm text-primary-black/60">$10 billed monthly</p>
          <p className="mt-4 text-sm text-primary-black/60">
            {firstMonthUsed ? "Billed monthly." : "$5 for your first month, then $10 monthly."}
          </p>
        </div>

        {owner ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => void checkout()}
            className="mt-7 min-h-10 w-full rounded-lg bg-primary-orange px-4 text-sm font-semibold text-on-accent hover:bg-primary-orange/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-black disabled:cursor-wait disabled:opacity-50"
          >
            {busy ? "Opening checkout…" : "Continue with monthly Pro"}
          </button>
        ) : (
          <p className="mt-7 text-sm text-primary-black/65">
            Ask an organization owner to upgrade.
          </p>
        )}
        {error && (
          <p role="alert" className="mt-3 text-sm text-red-700">
            {error}
          </p>
        )}
      </Dialog>
    </>
  );
}
