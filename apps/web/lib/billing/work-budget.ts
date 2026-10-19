import type Stripe from "stripe";
import { assertRequestActive } from "../request-lifecycle";

/** Admission bounds actual provider calls, including failures. SDK timeouts stop
 * each fetch; checking the parent before every call prevents work after cancel. */
export class BillingWorkBudget {
  private requests = 0;
  private deadline = Date.now() + 15_000;
  options(extra: Stripe.RequestOptions = {}): Stripe.RequestOptions {
    assertRequestActive();
    const remaining = this.deadline - Date.now();
    if (remaining <= 0 || ++this.requests > 10)
      throw new Error("Billing is temporarily unavailable. Try again shortly.");
    return { ...extra, timeout: Math.min(5000, remaining), maxNetworkRetries: 0 };
  }
}

/** Inspect a bounded history and stop safely if older subscriptions remain. */
export async function assertNoPendingSubscription(
  client: Stripe,
  customerId: string,
  work: BillingWorkBudget,
) {
  let after: string | undefined;
  for (let page = 0; page < 3; page++) {
    const result = await client.subscriptions.list(
      {
        customer: customerId,
        status: "all",
        limit: 100,
        ...(after ? { starting_after: after } : {}),
      },
      work.options(),
    );
    if (
      result.data.some(
        (subscription) => !["canceled", "incomplete_expired"].includes(subscription.status),
      )
    )
      throw new Error("An existing subscription is processing. Return to Billing in a moment.");
    if (!result.has_more) return;
    const last = result.data.at(-1)?.id;
    if (!last || last === after) break;
    after = last;
  }
  throw new Error(
    "Billing history could not be checked completely. Contact support before starting checkout.",
  );
}
