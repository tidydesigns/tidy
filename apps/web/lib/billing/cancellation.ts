import type Stripe from "stripe";

export function cancelsAtPeriodEnd(
  subscription: Pick<Stripe.Subscription, "cancel_at" | "cancel_at_period_end">,
  periodEnd: number | undefined,
) {
  return (
    subscription.cancel_at_period_end ||
    (periodEnd !== undefined && subscription.cancel_at === periodEnd)
  );
}
