import "server-only";
import { db } from "../db";
import { requestSignal } from "../request-lifecycle";
import { syncSubscription } from "./webhooks";

/** Claim one row at a time so a slow provider cannot reserve a whole batch.
 * Failed checks rotate too; one unavailable subscription cannot starve others. */
export async function reconcileBilling() {
  const deadline = Date.now() + 10_000;
  let checked = 0,
    failed = 0;
  while (checked < 10 && Date.now() < deadline) {
    requestSignal()?.throwIfAborted();
    const row = (
      await db.query<{ organizationId: string; stripeSubscriptionId: string }>(
        `with candidate as (
        select "organizationId" from "organization_billing"
        where "stripeSubscriptionId" is not null and "stripeStatus" in ('active','trialing','past_due','unpaid','incomplete','paused')
          and ("lastReconciledAt" is null or "lastReconciledAt" < now() - interval '6 hours')
        order by "lastReconciledAt" nulls first, "organizationId" limit 1 for update skip locked
      ) update "organization_billing" b set "lastReconciledAt"=now()
        from candidate c where b."organizationId"=c."organizationId"
        returning b."organizationId", b."stripeSubscriptionId"`,
      )
    ).rows[0];
    if (!row) break;
    checked++;
    try {
      await syncSubscription(row.organizationId, row.stripeSubscriptionId);
    } catch {
      failed++;
      console.error(JSON.stringify({ event: "billing_reconciliation_failed" }));
    }
  }
  return { checked, failed };
}
