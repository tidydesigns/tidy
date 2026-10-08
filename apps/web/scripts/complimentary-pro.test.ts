import { expect, mock, test } from "bun:test";
import type Stripe from "stripe";
import { manageComplimentaryPro, type Organization, type Options } from "./complimentary-pro";
import { parseOptions } from "./billing-pro";
import { COMPLIMENTARY_SOURCE } from "../lib/billing/complimentary";

const org: Organization = {
  id: "org_design",
  name: "Design",
  ownerEmail: "owner@example.com",
  stripeCustomerId: null,
  stripeSubscriptionId: null,
  stripeCheckoutSessionId: null,
};
const options: Options = { action: "grant", mode: "test", apply: false, reason: "Partner" };
function fixture() {
  const price = {
    id: "price_pro",
    active: true,
    livemode: false,
    currency: "usd",
    unit_amount: 1000,
    product: "prod_pro",
    recurring: { interval: "month", interval_count: 1, usage_type: "licensed" },
  };
  const coupon = {
    id: "tidy-complimentary-prod_pro",
    valid: true,
    livemode: false,
    percent_off: 100,
    amount_off: null,
    duration: "forever",
    applies_to: { products: ["prod_pro"] },
  };
  const customer = {
    id: "cus_org",
    livemode: false,
    metadata: { organizationId: org.id },
    balance: 0,
  };
  const state = {
    customer: null as typeof customer | null,
    customers: [] as (typeof customer)[],
    coupon: null as typeof coupon | null,
    subscriptions: [] as Stripe.Subscription[],
    pendingItems: [] as object[],
    checkoutStatus: "expired",
    invoiceAmount: 0,
  };
  const client = {
    prices: { retrieve: mock(async () => price) },
    customers: {
      retrieve: mock(async () => state.customer),
      list: mock(() => state.customers),
      create: mock(async (params: Stripe.CustomerCreateParams, request: Stripe.RequestOptions) => {
        void params;
        void request;
        state.customer = customer;
        state.customers.push(customer);
        return customer;
      }),
    },
    coupons: {
      retrieve: mock(async () => {
        if (!state.coupon) throw Object.assign(new Error("Missing"), { code: "resource_missing" });
        return state.coupon;
      }),
      create: mock(async (params: Stripe.CouponCreateParams, request: Stripe.RequestOptions) => {
        void params;
        void request;
        state.coupon = coupon;
        return coupon;
      }),
    },
    checkout: { sessions: { retrieve: mock(async () => ({ status: state.checkoutStatus })) } },
    invoiceItems: { list: mock(async () => ({ data: state.pendingItems })) },
    subscriptions: {
      list: mock(() => state.subscriptions),
      create: mock(
        async (params: Stripe.SubscriptionCreateParams, request: Stripe.RequestOptions) => {
          void request;
          const subscription = {
            id: `sub_${state.subscriptions.length}`,
            status: state.invoiceAmount ? "incomplete" : "active",
            created: state.subscriptions.length + 1,
            customer: customer.id,
            metadata: params.metadata,
            items: { has_more: false, data: [{ price, quantity: 1 }] },
            discounts: [{ end: null, source: { coupon } }],
            latest_invoice: { amount_due: state.invoiceAmount, total: state.invoiceAmount },
          } as unknown as Stripe.Subscription;
          state.subscriptions.push(subscription);
          return subscription;
        },
      ),
      cancel: mock(async (id: string, params: Stripe.SubscriptionCancelParams) => {
        void params;
        const subscription = state.subscriptions.find((s) => s.id === id)!;
        subscription.status = "canceled";
        return subscription;
      }),
    },
  };
  const sdk = client as unknown as Stripe;
  const run = (changes: Partial<Options> = {}, organization: Organization = org) =>
    manageComplimentaryPro(sdk, organization, { ...options, ...changes }, price.id);
  const writes = () =>
    client.coupons.create.mock.calls.length +
    client.customers.create.mock.calls.length +
    client.subscriptions.create.mock.calls.length +
    client.subscriptions.cancel.mock.calls.length;
  return { price, coupon, customer, state, client, run, writes };
}

test("preview plans a $0 subscription without any Stripe writes", async () => {
  const f = fixture();
  expect(await f.run()).toMatchObject({
    result: "preview",
    monthlyAmount: 0,
    createCoupon: true,
    createCustomer: true,
  });
  expect(f.writes()).toBe(0);
});

test("grant creates the regular Pro subscription with a private permanent discount and org metadata", async () => {
  const f = fixture();
  expect(await f.run({ apply: true })).toMatchObject({ result: "granted", monthlyAmount: 0 });
  expect(f.client.coupons.create.mock.calls[0][0]).toMatchObject({
    percent_off: 100,
    duration: "forever",
    applies_to: { products: ["prod_pro"] },
  });
  expect(f.client.subscriptions.create.mock.calls[0][0]).toMatchObject({
    items: [{ price: "price_pro", quantity: 1 }],
    discounts: [{ coupon: f.coupon.id }],
    payment_behavior: "default_incomplete",
    metadata: { organizationId: org.id, accessSource: COMPLIMENTARY_SOURCE, reason: "Partner" },
  });
  expect(await f.run({ apply: true })).toMatchObject({ result: "already-granted" });
  expect(f.client.subscriptions.create).toHaveBeenCalledTimes(1);
});

test("revoke previews, then cancels without invoicing or removing the discount", async () => {
  const f = fixture();
  await f.run({ apply: true });
  expect(await f.run({ action: "revoke" })).toMatchObject({
    result: "preview",
    action: "cancel-subscription",
  });
  expect(f.client.subscriptions.cancel).not.toHaveBeenCalled();
  expect(await f.run({ action: "revoke", apply: true })).toMatchObject({
    result: "revoked",
    status: "canceled",
  });
  expect(f.client.subscriptions.cancel.mock.calls[0][1]).toEqual({
    invoice_now: false,
    prorate: false,
    cancellation_details: { comment: "Partner" },
  });
  expect(await f.run({ action: "revoke", apply: true })).toMatchObject({
    result: "already-revoked",
  });
});

test("regrant after cancellation uses a new idempotency generation", async () => {
  const f = fixture();
  await f.run({ apply: true });
  await f.run({ action: "revoke", apply: true });
  await f.run({ apply: true });
  expect(f.client.subscriptions.create.mock.calls[0][1].idempotencyKey).toEndWith("initial");
  expect(f.client.subscriptions.create.mock.calls[1][1].idempotencyKey).toEndWith("sub_0");
});

test("paid subscriptions are never changed by grant or revoke", async () => {
  const f = fixture();
  await f.run({ apply: true });
  f.state.subscriptions[0].metadata.accessSource = "paid";
  const count = f.writes();
  await expect(f.run({ apply: true })).rejects.toThrow("isn't a script-managed");
  await expect(f.run({ action: "revoke", apply: true })).rejects.toThrow("isn't a script-managed");
  expect(f.writes()).toBe(count);
});

test("inspect reports paid subscriptions without modifying them", async () => {
  const f = fixture();
  await f.run({ apply: true });
  f.state.subscriptions[0].metadata.accessSource = "paid";
  const count = f.writes();
  expect(await f.run({ action: "inspect", reason: undefined })).toMatchObject({
    subscriptions: [{ complimentary: false }],
  });
  expect(f.writes()).toBe(count);
});

test("invalid catalog and Stripe mode fail before writes", async () => {
  for (const change of [
    { unit_amount: 900 },
    { livemode: true },
    { recurring: { interval: "month", interval_count: 2, usage_type: "licensed" } },
  ]) {
    const f = fixture();
    Object.assign(f.price, change);
    await expect(f.run({ apply: true })).rejects.toThrow("$10 USD monthly");
    expect(f.writes()).toBe(0);
  }
  for (const change of [
    { percent_off: 50 },
    { duration: "once" },
    { applies_to: { products: ["prod_other"] } },
    { applies_to: undefined },
  ]) {
    const f = fixture();
    f.state.coupon = Object.assign(f.coupon, change);
    await expect(f.run({ apply: true })).rejects.toThrow("100% off forever");
    expect(f.writes()).toBe(0);
  }
});

test("customer mismatch, pending Checkout and stale database subscription fail closed", async () => {
  const f = fixture();
  f.state.customer = f.customer;
  f.customer.metadata.organizationId = "other";
  await expect(f.run({ apply: true }, { ...org, stripeCustomerId: f.customer.id })).rejects.toThrow(
    "customer does not match",
  );
  for (const status of ["open", "complete"]) {
    const f = fixture();
    f.state.checkoutStatus = status;
    await expect(
      f.run({ apply: true }, { ...org, stripeCheckoutSessionId: "cs_open" }),
    ).rejects.toThrow("Finish or expire");
    expect(f.writes()).toBe(0);
  }
  await expect(
    f.run({ apply: true }, { ...org, stripeSubscriptionId: "sub_missing" }),
  ).rejects.toThrow("wasn't found");
});

test("customer balances and pending invoice items can't enter a complimentary invoice", async () => {
  for (const balance of [100, -100]) {
    const f = fixture();
    f.state.customer = f.customer;
    f.state.customers.push(f.customer);
    f.customer.balance = balance;
    await expect(f.run({ apply: true })).rejects.toThrow("invoice balance");
    expect(f.writes()).toBe(0);
  }
  const f = fixture();
  f.state.customers.push(f.customer);
  f.state.pendingItems.push({});
  await expect(f.run({ apply: true })).rejects.toThrow("pending invoice items");
  expect(f.writes()).toBe(0);
});

test("an unexpected nonzero invoice is canceled without attempting payment", async () => {
  const f = fixture();
  f.state.invoiceAmount = 100;
  await expect(f.run({ apply: true })).rejects.toThrow("$0 invoice");
  expect(f.client.subscriptions.create.mock.calls[0][0].payment_behavior).toBe(
    "default_incomplete",
  );
  expect(f.client.subscriptions.cancel).toHaveBeenCalledTimes(1);
});

test("discounts removed or changed in Stripe protect the subscription from admin revocation", async () => {
  const f = fixture();
  await f.run({ apply: true });
  f.state.subscriptions[0].discounts = [];
  await expect(f.run({ action: "revoke", apply: true })).rejects.toThrow("isn't a script-managed");
  expect(f.client.subscriptions.cancel).not.toHaveBeenCalled();
});

test("an incomplete complimentary subscription is not reported as granted", async () => {
  const f = fixture();
  await f.run({ apply: true });
  f.state.subscriptions[0].status = "incomplete";
  await expect(f.run({ apply: true })).rejects.toThrow("unfinished or suspended");
  expect(f.client.subscriptions.create).toHaveBeenCalledTimes(1);
});

test("an archived coupon can still identify an existing complimentary subscription", async () => {
  const f = fixture();
  await f.run({ apply: true });
  f.coupon.valid = false;
  expect(await f.run({ action: "revoke", apply: true })).toMatchObject({ result: "revoked" });
});

test("CLI requires explicit organization, mode and reason; defaults to preview", () => {
  expect(
    parseOptions(["grant", "--org=org_design", "--mode=live", "--reason=Founder"]),
  ).toMatchObject({ apply: false, action: "grant" });
  for (const args of [
    ["grant", "--org=org_design"],
    ["grant", "--org=org_design", "--mode=live"],
    ["grant", "--email=x@example.com", "--mode=live"],
    ["inspect", "--org=org_design", "--mode=live", "--apply"],
  ])
    expect(() => parseOptions(args)).toThrow();
  expect(parseOptions(["inspect", "--email=x@example.com", "--mode=live"])).toMatchObject({
    email: "x@example.com",
    action: "inspect",
  });
  expect(parseOptions(["--help"])).toBeNull();
});
