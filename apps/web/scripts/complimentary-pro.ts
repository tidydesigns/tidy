import type Stripe from "stripe";
import {
  BillingAdminError,
  assertComplimentaryCoupon,
  assertProPrice,
  COMPLIMENTARY_SOURCE,
  subscriptionEnded,
} from "../lib/billing/complimentary";

export type Organization = {
  id: string;
  name: string;
  ownerEmail: string;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  stripeCheckoutSessionId: string | null;
};
export type Options = {
  action: "grant" | "inspect" | "revoke";
  mode: "test" | "live";
  apply: boolean;
  reason?: string;
};
const objectId = (value: string | { id: string }) => (typeof value === "string" ? value : value.id);
const missing = (error: unknown) => (error as { code?: string }).code === "resource_missing";

async function findCustomer(client: Stripe, org: Organization, live: boolean) {
  let customer: Stripe.Customer | Stripe.DeletedCustomer | undefined;
  if (org.stripeCustomerId) customer = await client.customers.retrieve(org.stripeCustomerId);
  else {
    // Recover a customer from a previous run even if its webhook hasn't arrived.
    for await (const candidate of client.customers.list({ email: org.ownerEmail, limit: 100 })) {
      if (candidate.metadata.organizationId !== org.id) continue;
      if (customer)
        throw new BillingAdminError(
          "Multiple Stripe customers match this organization. Reconcile them before continuing.",
        );
      customer = candidate;
    }
  }
  if (
    customer &&
    (customer.deleted || customer.livemode !== live || customer.metadata.organizationId !== org.id)
  ) {
    throw new BillingAdminError("Stripe customer does not match this organization and mode.");
  }
  return customer as Stripe.Customer | undefined;
}

async function assertComplimentary(
  client: Stripe,
  subscription: Stripe.Subscription,
  org: Organization,
  price: Stripe.Price,
) {
  if (
    subscription.metadata.organizationId !== org.id ||
    subscription.metadata.accessSource !== COMPLIMENTARY_SOURCE ||
    subscription.items.has_more ||
    subscription.items.data.length !== 1 ||
    subscription.items.data[0].price.id !== price.id ||
    subscription.items.data[0].quantity !== 1 ||
    subscription.schedule ||
    subscription.discounts.length !== 1
  ) {
    throw new BillingAdminError(
      "Refusing to change a subscription that isn't a script-managed complimentary Pro subscription.",
    );
  }
  const discount = subscription.discounts[0];
  if (typeof discount === "string" || discount.end !== null || !discount.source.coupon)
    throw new BillingAdminError("The subscription's permanent discount could not be verified.");
  const coupon =
    typeof discount.source.coupon === "string"
      ? await client.coupons.retrieve(discount.source.coupon)
      : discount.source.coupon;
  assertComplimentaryCoupon(coupon, objectId(price.product), price.livemode, true);
}

export async function manageComplimentaryPro(
  client: Stripe,
  org: Organization,
  options: Options,
  priceId: string,
) {
  const live = options.mode === "live";
  if (options.action !== "inspect" && (!options.reason?.trim() || options.reason.length > 500))
    throw new BillingAdminError("Provide --reason (1–500 characters) for grants and revocations.");
  const price = await client.prices.retrieve(priceId);
  assertProPrice(price, live);
  const customer = await findCustomer(client, org, live);
  const subscriptions: Stripe.Subscription[] = [];
  if (customer) {
    for await (const subscription of client.subscriptions.list({
      customer: customer.id,
      status: "all",
      limit: 100,
      expand: ["data.discounts"],
    })) {
      subscriptions.push(subscription);
    }
  }
  if (org.stripeSubscriptionId && !subscriptions.some((s) => s.id === org.stripeSubscriptionId)) {
    throw new BillingAdminError(
      "The database subscription wasn't found on this Stripe customer. Reconcile billing before continuing.",
    );
  }
  const active = subscriptions.filter((s) => !subscriptionEnded(s.status));
  const summary = {
    organization: { id: org.id, name: org.name },
    mode: options.mode,
    priceId,
    customerId: customer?.id ?? null,
  };
  if (options.action === "inspect")
    return {
      ...summary,
      subscriptions: subscriptions.map((s) => ({
        id: s.id,
        status: s.status,
        complimentary: s.metadata.accessSource === COMPLIMENTARY_SOURCE,
        cancelAtPeriodEnd: s.cancel_at_period_end,
        reason: s.metadata.reason ?? null,
      })),
    };
  if (org.stripeCheckoutSessionId) {
    const checkout = await client.checkout.sessions.retrieve(org.stripeCheckoutSessionId);
    if (checkout.status !== "expired")
      throw new BillingAdminError(
        "Finish or expire the existing Pro Checkout session before continuing.",
      );
  }
  if (active.length > 1)
    throw new BillingAdminError(
      "Multiple unfinished subscriptions exist. Reconcile them before continuing.",
    );
  if (active[0]) {
    await assertComplimentary(client, active[0], org, price);
    if (options.action === "grant") {
      if (!["active", "trialing"].includes(active[0].status))
        throw new BillingAdminError(
          "The complimentary subscription is unfinished or suspended. Reconcile it in Stripe before granting access.",
        );
      return {
        ...summary,
        result: "already-granted",
        subscriptionId: active[0].id,
        status: active[0].status,
      };
    }
    if (!options.apply)
      return {
        ...summary,
        result: "preview",
        action: "cancel-subscription",
        subscriptionId: active[0].id,
        reason: options.reason,
      };
    // Cancel, rather than remove its discount and turn it into a paid subscription.
    const canceled = await client.subscriptions.cancel(active[0].id, {
      invoice_now: false,
      prorate: false,
      cancellation_details: { comment: options.reason },
    });
    return {
      ...summary,
      result: "revoked",
      subscriptionId: canceled.id,
      status: canceled.status,
      synchronization: "Await the signed Stripe webhook, then refresh Billing.",
    };
  }
  if (options.action === "revoke") return { ...summary, result: "already-revoked" };
  if (customer?.balance)
    throw new BillingAdminError(
      "This customer has an invoice balance. Reconcile it before granting complimentary Pro.",
    );
  if (
    customer &&
    (await client.invoiceItems.list({ customer: customer.id, pending: true, limit: 1 })).data.length
  ) {
    throw new BillingAdminError(
      "This customer has pending invoice items. Reconcile them before granting complimentary Pro.",
    );
  }
  const productId = objectId(price.product);
  const couponId = `tidy-complimentary-${productId}`;
  let coupon: Stripe.Coupon | undefined;
  try {
    coupon = await client.coupons.retrieve(couponId);
  } catch (error) {
    if (!missing(error)) throw error;
  }
  if (coupon) assertComplimentaryCoupon(coupon, productId, live);
  if (!options.apply)
    return {
      ...summary,
      result: "preview",
      action: "create-subscription",
      couponId,
      createCoupon: !coupon,
      createCustomer: !customer,
      monthlyAmount: 0,
      discount: "100% forever",
      reason: options.reason,
    };
  if (!coupon) {
    try {
      coupon = await client.coupons.create(
        {
          id: couponId,
          name: "Complimentary Pro",
          percent_off: 100,
          duration: "forever",
          applies_to: { products: [productId] },
          metadata: { accessSource: COMPLIMENTARY_SOURCE },
        },
        { idempotencyKey: couponId },
      );
    } catch (error) {
      // Different organizations can race to create the same private coupon.
      if ((error as { code?: string }).code !== "resource_already_exists") throw error;
      coupon = await client.coupons.retrieve(couponId);
    }
    assertComplimentaryCoupon(coupon, productId, live);
  }
  const customerId =
    customer?.id ??
    (
      await client.customers.create(
        { email: org.ownerEmail, metadata: { organizationId: org.id } },
        { idempotencyKey: `tidy-pro-customer-${org.id}` },
      )
    ).id;
  const previous =
    subscriptions.sort((a, b) => b.created - a.created || b.id.localeCompare(a.id))[0]?.id ??
    "initial";
  const created = await client.subscriptions.create(
    {
      customer: customerId,
      items: [{ price: price.id, quantity: 1 }],
      discounts: [{ coupon: couponId }],
      payment_behavior: "default_incomplete",
      automatic_tax: { enabled: false },
      metadata: {
        organizationId: org.id,
        accessSource: COMPLIMENTARY_SOURCE,
        reason: options.reason!.trim(),
      },
      expand: ["latest_invoice", "discounts"],
    },
    { idempotencyKey: `tidy-comp-${org.id}-${price.id}-${previous}` },
  );
  const invoice = created.latest_invoice;
  if (
    created.status !== "active" ||
    !invoice ||
    typeof invoice === "string" ||
    invoice.amount_due !== 0 ||
    invoice.total !== 0
  ) {
    // default_incomplete avoids attempting payment if an unexpected charge exists.
    await client.subscriptions.cancel(created.id, { invoice_now: false, prorate: false });
    throw new BillingAdminError(
      "Complimentary subscription wasn't active with a $0 invoice; it was canceled. Inspect Stripe before retrying.",
    );
  }
  return {
    ...summary,
    customerId,
    result: "granted",
    subscriptionId: created.id,
    status: created.status,
    couponId,
    monthlyAmount: 0,
    synchronization: "Await the signed Stripe webhook, then refresh Billing.",
  };
}
