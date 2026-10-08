"use client";

import { useState } from "react";
import type { BillingStatus } from "@/lib/billing/server";
import { formatStorage } from "@/lib/billing/plans";
import { UsageBar } from "@/components/ui/usage-bar";

export function BillingSettings({
  organizationId,
  owner,
  billing,
}: {
  organizationId: string;
  owner: boolean;
  billing: BillingStatus;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function openPortal() {
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/billing/portal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ organizationId }),
      });
      const data = (await response.json()) as { url?: string; error?: string };
      if (!response.ok || !data.url)
        throw new Error(data.error ?? "Could not open Stripe billing.");
      window.location.assign(data.url);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not open Stripe billing.");
      setBusy(false);
    }
  }
  const period = billing.currentPeriodEnd
    ? new Date(billing.currentPeriodEnd).toLocaleDateString(undefined, { dateStyle: "medium" })
    : null;
  const canManage = !!(
    billing.customerId &&
    billing.status &&
    !["canceled", "incomplete_expired"].includes(billing.status)
  );
  return (
    <section aria-label="Billing" className="max-w-xl space-y-6">
      <div>
        <p className="text-sm text-primary-black/55">Current plan</p>
        <p className="mt-1 text-xl font-semibold">
          {billing.tier === "self_hosted" ? "Self-hosted" : billing.tier === "pro" ? "Pro" : "Free"}
        </p>
        {billing.status === "past_due" || billing.status === "unpaid" ? (
          <p className="mt-2 text-sm text-red-700">Payment needs attention.</p>
        ) : null}
        {billing.status === "canceled" && period ? (
          <p className="mt-2 text-sm text-primary-black/60">Subscription ended {period}.</p>
        ) : null}
      </div>
      {billing.tier === "pro" && (
        <p className="text-sm">
          {billing.cancelAtPeriodEnd && period
            ? `Pro ends ${period}`
            : `$10 USD per month${period ? ` · Current period ends ${period}` : ""}`}
        </p>
      )}
      {billing.plan && (
        <div className="space-y-3 text-sm">
          <dl className="divide-y divide-primary-grey/60">
            <UsageBar
              label="MCP calls"
              used={billing.plan.usage.mcpCalls}
              limit={billing.plan.limits.mcpCalls}
              detail={`Resets ${new Date(billing.plan.mcpResetAt).toLocaleDateString(undefined, { dateStyle: "medium", timeZone: "UTC" })} (UTC)`}
            />
            <UsageBar
              label="Files"
              used={billing.plan.usage.files}
              limit={billing.plan.limits.files}
            />
            <UsageBar
              label="Editors"
              used={billing.plan.usage.editors}
              limit={billing.plan.limits.editors}
            />
            <UsageBar
              label="Asset storage"
              used={billing.plan.usage.storageBytes}
              limit={billing.plan.limits.storageBytes}
              format={formatStorage}
            />
          </dl>
          <p className="text-xs text-primary-black/60">
            Files include archives. Editors include owners, admins and pending editor invitations.
            Viewers are free.
          </p>
          <p className="text-xs text-primary-black/60">
            MCP calls are shared by this workspace and reset each month. Use your own inference
            provider; your provider’s limits also apply.
          </p>
          {(["files", "editors", "storageBytes"] as const).some(
            (key) =>
              billing.plan!.limits[key] !== null &&
              billing.plan!.usage[key] > billing.plan!.limits[key]!,
          ) && (
            <p role="status" className="text-sm text-primary-black/70">
              This workspace exceeds its current allowance. Existing designs remain accessible;
              reduce usage or upgrade before adding more.
            </p>
          )}
        </div>
      )}
      {owner && billing.ready && canManage && (
        <button
          type="button"
          disabled={busy}
          onClick={() => void openPortal()}
          className="min-h-10 rounded-lg bg-primary-orange px-4 text-sm font-semibold text-on-accent hover:bg-primary-orange/90 disabled:opacity-50"
        >
          Manage billing
        </button>
      )}
      {error && (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      )}
    </section>
  );
}
