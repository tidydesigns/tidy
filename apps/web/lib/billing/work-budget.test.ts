import { expect, spyOn, test } from "bun:test";
import type Stripe from "stripe";
import { assertNoPendingSubscription, BillingWorkBudget } from "./work-budget";
import { runWithRequestSignal } from "../request-lifecycle";

test("billing history is bounded, paginated explicitly, and cannot overlook an active subscription", async () => {
  const calls: { starting_after?: string }[] = [];
  let status = "canceled",
    more = true;
  const client = {
    subscriptions: {
      list: async (params: { starting_after?: string }, options: Stripe.RequestOptions) => {
        expect(options.timeout).toBeLessThanOrEqual(5000);
        expect(options.maxNetworkRetries).toBe(0);
        calls.push(params);
        return { data: [{ id: `sub_${calls.length}`, status }], has_more: more };
      },
    },
  } as unknown as Stripe;
  await expect(
    assertNoPendingSubscription(client, "customer", new BillingWorkBudget()),
  ).rejects.toThrow("checked completely");
  expect(calls).toHaveLength(3);
  expect(calls.map((x) => x.starting_after)).toEqual([undefined, "sub_1", "sub_2"]);
  calls.length = 0;
  status = "active";
  await expect(
    assertNoPendingSubscription(client, "customer", new BillingWorkBudget()),
  ).rejects.toThrow("existing subscription");
  expect(calls).toHaveLength(1);
  calls.length = 0;
  status = "incomplete_expired";
  more = false;
  await expect(
    assertNoPendingSubscription(client, "customer", new BillingWorkBudget()),
  ).resolves.toBeUndefined();
  expect(calls).toHaveLength(1);
});

test("billing calls stop after cancellation, the request allowance, or the operation deadline", async () => {
  const work = new BillingWorkBudget();
  for (let i = 0; i < 10; i++) expect(work.options().maxNetworkRetries).toBe(0);
  expect(() => work.options()).toThrow("temporarily unavailable");
  const signal = AbortSignal.abort(new Error("Request ended"));
  await expect(
    runWithRequestSignal(signal, async () => new BillingWorkBudget().options()),
  ).rejects.toThrow("Request ended");
  const time = spyOn(Date, "now").mockReturnValue(1000);
  try {
    const expired = new BillingWorkBudget();
    time.mockReturnValue(16_001);
    expect(() => expired.options()).toThrow("temporarily unavailable");
  } finally {
    time.mockRestore();
  }
});
