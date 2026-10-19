import "server-only";
import type Stripe from "stripe";
import { db } from "@/lib/db";
import { cancelsAtPeriodEnd } from "./cancellation";
import { stripe } from "./server";
import { requireRegisteredProPrice } from "./plan-server";
import { COMPLIMENTARY_SOURCE, subscriptionEnded } from "./complimentary";

function id(value: string | { id: string } | null) {
  return typeof value === "string" ? value : (value?.id ?? null);
}

function retrieveSubscription(subscriptionId: string) {
  return stripe().subscriptions.retrieve(
    subscriptionId,
    {},
    { timeout: 5000, maxNetworkRetries: 0 },
  );
}

export async function syncSubscription(
  organizationId: string,
  subscriptionId: string,
  checkoutSessionId?: string,
  expectedCustomerId?: string,
) {
  const allowSwitch = Boolean(checkoutSessionId);
  await requireRegisteredProPrice();
  const connection = await db.connect();
  try {
    await connection.query("begin");
    await connection.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [
      organizationId,
    ]);
    const organization = await connection.query('select "id" from "organization" where "id" = $1', [
      organizationId,
    ]);
    if (!organization.rowCount) {
      await connection.query("commit");
      return;
    }
    // Discovery is not a snapshot to publish. Fetch again only after acquiring
    // the same organization fence used by checkout and entitlement writers.
    const subscription = await retrieveSubscription(subscriptionId);
    const customerId = id(subscription.customer);
    if (
      subscription.metadata.organizationId !== organizationId ||
      !customerId ||
      (expectedCustomerId && customerId !== expectedCustomerId)
    )
      throw new Error("Stripe subscription metadata changed.");
    if (
      checkoutSessionId &&
      !subscription.items.data.some((item) => item.price.id === process.env.STRIPE_PRO_PRICE_ID)
    )
      throw new Error("Stripe checkout has the wrong Price.");
    await connection.query(
      'insert into "organization_billing" ("organizationId") values ($1) on conflict do nothing',
      [organizationId],
    );
    const row = (
      await connection.query<{
        stripeCustomerId: string | null;
        stripeSubscriptionId: string | null;
        stripeCheckoutSessionId: string | null;
      }>(
        'select "stripeCustomerId", "stripeSubscriptionId", "stripeCheckoutSessionId" from "organization_billing" where "organizationId" = $1 for update',
        [organizationId],
      )
    ).rows[0];
    if (row.stripeCustomerId && row.stripeCustomerId !== customerId)
      throw new Error("Stripe customer does not match this organization.");
    if (
      checkoutSessionId &&
      row.stripeCheckoutSessionId !== checkoutSessionId &&
      row.stripeSubscriptionId !== subscription.id
    ) {
      await connection.query("commit");
      return;
    }
    if (row.stripeSubscriptionId && row.stripeSubscriptionId !== subscription.id && !allowSwitch) {
      // An admin-created complimentary subscription can replace an ended one.
      // Fetch the previous subscription so stale/out-of-order events can't
      // displace a current paid or complimentary subscription.
      if (
        subscription.metadata.accessSource !== COMPLIMENTARY_SOURCE ||
        subscriptionEnded(subscription.status) ||
        !subscription.items.data.some((item) => item.price.id === process.env.STRIPE_PRO_PRICE_ID)
      ) {
        await connection.query("commit");
        return;
      }
      const previous = await retrieveSubscription(row.stripeSubscriptionId);
      if (
        !subscriptionEnded(previous.status) ||
        id(previous.customer) !== customerId ||
        previous.metadata.organizationId !== organizationId ||
        subscription.created < previous.created
      ) {
        await connection.query("commit");
        return;
      }
    }
    const periodEnd = subscription.items.data
      .map((item) => item.current_period_end)
      .filter(Boolean)
      .sort((a, b) => b - a)[0];
    const priceId =
      subscription.items.data.find((item) => item.price.id === process.env.STRIPE_PRO_PRICE_ID)
        ?.price.id ??
      subscription.items.data[0]?.price.id ??
      null;
    if (
      ["active", "trialing"].includes(subscription.status) &&
      (!Number.isSafeInteger(periodEnd) || !periodEnd || periodEnd <= 0)
    )
      throw new Error("Stripe subscription period is unavailable.");
    await connection.query(
      `update "organization_billing" set
      "stripeCustomerId" = $2, "stripeSubscriptionId" = $3, "stripeStatus" = $4,
      "stripePriceId" = $5, "currentPeriodEnd" = $6, "cancelAtPeriodEnd" = $7,
      "stripeCheckoutSessionId" = null, "firstMonthUsed" = "firstMonthUsed" or $8,
      "lastReconciledAt" = now(), "updatedAt" = now()
      where "organizationId" = $1`,
      [
        organizationId,
        customerId,
        subscription.id,
        subscription.status,
        priceId,
        periodEnd ? new Date(periodEnd * 1000) : null,
        cancelsAtPeriodEnd(subscription, periodEnd),
        priceId === process.env.STRIPE_PRO_PRICE_ID &&
          (subscription.status === "active" || subscription.status === "trialing"),
      ],
    );
    await connection.query("commit");
  } catch (error) {
    await connection.query("rollback");
    throw error;
  } finally {
    connection.release();
  }
}

export async function processBillingEvent(event: Stripe.Event) {
  if (
    event.type === "checkout.session.completed" ||
    event.type === "checkout.session.async_payment_succeeded"
  ) {
    const session = event.data.object;
    if (session.mode !== "subscription" || !session.subscription || !session.client_reference_id)
      return;
    const subscription = await retrieveSubscription(id(session.subscription)!);
    if (
      subscription.metadata.organizationId !== session.client_reference_id ||
      id(subscription.customer) !== id(session.customer)
    ) {
      throw new Error("Stripe checkout metadata does not match the subscription.");
    }
    if (!subscription.items.data.some((item) => item.price.id === process.env.STRIPE_PRO_PRICE_ID))
      throw new Error("Stripe checkout has the wrong Price.");
    await syncSubscription(
      session.client_reference_id,
      subscription.id,
      session.id,
      id(session.customer)!,
    );
  } else if (
    event.type === "customer.subscription.created" ||
    event.type === "customer.subscription.updated" ||
    event.type === "customer.subscription.deleted"
  ) {
    const subscription = await retrieveSubscription(event.data.object.id);
    if (subscription.metadata.organizationId)
      await syncSubscription(subscription.metadata.organizationId, subscription.id);
  }
}
