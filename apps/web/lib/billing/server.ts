import { requireOrganizationPermission } from "@/lib/organizations/authorization";
import "server-only";
import Stripe from "stripe";
import { db } from "@/lib/db";

import {
  organizationPlanTier,
  organizationPlanUsage,
  proPlanLimits,
  requireRegisteredProPrice,
} from "./plan-server";
import type { PlanLimits, PlanUsage } from "./plans";
const BLOCKED = new Set(["active", "trialing", "past_due", "unpaid", "incomplete", "paused"]);
export type BillingStatus = {
  ready: boolean;
  tier: "free" | "pro" | "self_hosted";
  plan: PlanUsage | null;
  proLimits: PlanLimits | null;
  status: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  customerId: string | null;
  firstMonthUsed: boolean;
};

type BillingRow = {
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  stripeCheckoutSessionId: string | null;
  stripeStatus: string | null;
  stripePriceId: string | null;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  firstMonthUsed: boolean;
};

export function billingConfigured() {
  return !!(
    process.env.STRIPE_SECRET_KEY &&
    process.env.STRIPE_WEBHOOK_SECRET &&
    process.env.STRIPE_PRO_PRICE_ID &&
    process.env.STRIPE_FIRST_MONTH_COUPON_ID
  );
}

export function checkoutPricing(firstMonthUsed: boolean) {
  return {
    line_items: [{ price: process.env.STRIPE_PRO_PRICE_ID!, quantity: 1 }],
    ...(!firstMonthUsed
      ? { discounts: [{ coupon: process.env.STRIPE_FIRST_MONTH_COUPON_ID! }] }
      : {}),
  };
}

let stripeClient: Stripe | undefined;
export function stripe() {
  if (!process.env.STRIPE_SECRET_KEY) throw new Error("Stripe billing is not configured.");
  return (stripeClient ??= new Stripe(process.env.STRIPE_SECRET_KEY, {
    httpClient: Stripe.createFetchHttpClient(),
  }));
}

export async function billingStatus(
  userId: string,
  organizationId: string,
  includeUsage = false,
): Promise<BillingStatus> {
  await requireOrganizationPermission(userId, organizationId, "view");
  let row: BillingRow | undefined;
  let plan: PlanUsage | null = null;
  let tier: PlanUsage["tier"];
  let proLimits: PlanLimits;
  try {
    // The sidebar only needs the tier. Count assets and invitations on the
    // billing page, rather than scanning usage on every workspace navigation.
    if (includeUsage) {
      [plan, proLimits] = await Promise.all([
        organizationPlanUsage(organizationId),
        proPlanLimits(),
      ]);
      tier = plan.tier;
    } else {
      [tier, proLimits] = await Promise.all([
        organizationPlanTier(organizationId),
        proPlanLimits(),
      ]);
    }
    row = (
      await db.query<BillingRow>(
        'select "stripeCustomerId", "stripeSubscriptionId", "stripeCheckoutSessionId", "stripeStatus", "stripePriceId", "currentPeriodEnd", "cancelAtPeriodEnd", "firstMonthUsed" from "organization_billing" where "organizationId" = $1',
        [organizationId],
      )
    ).rows[0];
  } catch (error) {
    // The tab can be opened before the reviewed migration has been applied.
    if (!["42P01", "42883"].includes((error as { code?: string }).code ?? "")) throw error;
    return {
      ready: false,
      tier: "free",
      plan: null,
      proLimits: null,
      status: null,
      currentPeriodEnd: null,
      cancelAtPeriodEnd: false,
      customerId: null,
      firstMonthUsed: false,
    };
  }
  return {
    ready: billingConfigured() && tier !== "self_hosted",
    tier,
    plan,
    proLimits,
    status: row?.stripeStatus ?? null,
    currentPeriodEnd: row?.currentPeriodEnd?.toISOString() ?? null,
    cancelAtPeriodEnd: row?.cancelAtPeriodEnd ?? false,
    customerId: row?.stripeCustomerId ?? null,
    firstMonthUsed: row?.firstMonthUsed ?? false,
  };
}

export async function requireBillingOwner(userId: string, organizationId: string) {
  await requireOrganizationPermission(userId, organizationId, "own");
}

export async function validateCatalog(client: Stripe) {
  const price = await client.prices.retrieve(process.env.STRIPE_PRO_PRICE_ID!);
  const coupon = await client.coupons.retrieve(process.env.STRIPE_FIRST_MONTH_COUPON_ID!);
  if (
    !price.active ||
    price.currency !== "usd" ||
    price.unit_amount !== 1000 ||
    price.recurring?.interval !== "month" ||
    price.recurring.interval_count !== 1
  ) {
    throw new Error("The Stripe Pro price must be $10 USD per month.");
  }
  const fiveDollarDiscount = coupon.amount_off === 500 && coupon.currency === "usd";
  const halfOffDiscount = coupon.percent_off === 50 && coupon.amount_off === null;
  if (!coupon.valid || coupon.duration !== "once" || (!fiveDollarDiscount && !halfOffDiscount)) {
    throw new Error("The Stripe first-month coupon must take 50% or $5 USD off once.");
  }
  const productId = typeof price.product === "string" ? price.product : price.product.id;
  if (coupon.applies_to?.products?.length && !coupon.applies_to.products.includes(productId)) {
    throw new Error("The first-month coupon does not apply to the Pro price.");
  }
}

function returnUrl() {
  const base = process.env.BETTER_AUTH_URL;
  if (!base) throw new Error("The application URL is not configured.");
  return new URL("/settings?tab=billing", base).toString();
}

export async function checkoutUrl(userId: string, organizationId: string, email: string) {
  await requireBillingOwner(userId, organizationId);
  if ((await organizationPlanTier(organizationId)) === "self_hosted")
    throw new Error("Billing is disabled for self-hosted workspaces.");
  if (!billingConfigured()) throw new Error("Stripe billing is not configured.");
  const client = stripe();
  await validateCatalog(client);
  await requireRegisteredProPrice();
  const connection = await db.connect();
  try {
    await connection.query("begin");
    await connection.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [
      organizationId,
    ]);
    await connection.query(
      'insert into "organization_billing" ("organizationId") values ($1) on conflict do nothing',
      [organizationId],
    );
    const row = (
      await connection.query<BillingRow>(
        'select * from "organization_billing" where "organizationId" = $1 for update',
        [organizationId],
      )
    ).rows[0];
    if (row.stripeStatus && BLOCKED.has(row.stripeStatus))
      throw new Error("Manage the existing Pro subscription in Stripe.");
    if (row.stripeCheckoutSessionId) {
      const existing = await client.checkout.sessions.retrieve(row.stripeCheckoutSessionId);
      if (existing.status === "open" && existing.url) {
        await connection.query("commit");
        return existing.url;
      }
      if (existing.status === "complete")
        throw new Error("Your checkout is processing. Return to Billing in a moment.");
    }
    const customerId =
      row.stripeCustomerId ??
      (
        await client.customers.create(
          {
            email,
            metadata: { organizationId },
          },
          { idempotencyKey: `tidy-pro-customer-${organizationId}` },
        )
      ).id;
    // An admin grant may exist in Stripe before its webhook reaches this row.
    // Check canonical subscriptions while holding the shared organization lock.
    for await (const subscription of client.subscriptions.list({
      customer: customerId,
      status: "all",
      limit: 100,
    })) {
      if (!["canceled", "incomplete_expired"].includes(subscription.status))
        throw new Error("An existing subscription is processing. Return to Billing in a moment.");
    }
    const session = await client.checkout.sessions.create({
      mode: "subscription",
      customer: customerId,
      client_reference_id: organizationId,
      ...checkoutPricing(row.firstMonthUsed),
      subscription_data: { metadata: { organizationId } },
      metadata: { organizationId },
      success_url: returnUrl(),
      cancel_url: returnUrl(),
    });
    if (!session.url) throw new Error("Stripe did not provide a checkout URL.");
    await connection.query(
      'update "organization_billing" set "stripeCustomerId" = $2, "stripeCheckoutSessionId" = $3, "updatedAt" = now() where "organizationId" = $1',
      [organizationId, customerId, session.id],
    );
    await connection.query("commit");
    return session.url;
  } catch (error) {
    await connection.query("rollback");
    throw error;
  } finally {
    connection.release();
  }
}

export async function portalUrl(userId: string, organizationId: string) {
  await requireBillingOwner(userId, organizationId);
  if (!billingConfigured()) throw new Error("Stripe billing is not configured.");
  const row = (
    await db.query<{ stripeCustomerId: string | null }>(
      'select "stripeCustomerId" from "organization_billing" where "organizationId" = $1',
      [organizationId],
    )
  ).rows[0];
  if (!row?.stripeCustomerId) throw new Error("This organization has no Stripe billing account.");
  const session = await stripe().billingPortal.sessions.create({
    customer: row.stripeCustomerId,
    return_url: returnUrl(),
  });
  return session.url;
}

export async function assertNoActiveBilling(organizationId: string) {
  try {
    const row = (
      await db.query<{ stripeStatus: string | null; stripeCheckoutSessionId: string | null }>(
        'select "stripeStatus", "stripeCheckoutSessionId" from "organization_billing" where "organizationId" = $1',
        [organizationId],
      )
    ).rows[0];
    if (row?.stripeStatus && BLOCKED.has(row.stripeStatus))
      throw new Error("Cancel the Pro subscription in Billing before deleting this organization.");
    if (row?.stripeCheckoutSessionId) {
      const checkout = await stripe().checkout.sessions.retrieve(row.stripeCheckoutSessionId);
      if (checkout.status === "open" || checkout.status === "complete")
        throw new Error(
          "Finish or expire the open Pro checkout before deleting this organization.",
        );
    }
  } catch (error) {
    if ((error as { code?: string }).code !== "42P01") throw error;
  }
}
