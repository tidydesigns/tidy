import type Stripe from "stripe";

export const COMPLIMENTARY_SOURCE = "tidy-complimentary-pro-v1";
export class BillingAdminError extends Error {}
export const subscriptionEnded = (status: string) =>
  status === "canceled" || status === "incomplete_expired";

export function assertProPrice(price: Stripe.Price, live: boolean) {
  if (
    price.livemode !== live ||
    !price.active ||
    price.currency !== "usd" ||
    price.unit_amount !== 1000 ||
    price.recurring?.interval !== "month" ||
    price.recurring.interval_count !== 1 ||
    price.recurring.usage_type !== "licensed"
  ) {
    throw new BillingAdminError(
      "Expected the configured $10 USD monthly Pro Price in the selected Stripe mode.",
    );
  }
}

export function assertComplimentaryCoupon(
  coupon: Stripe.Coupon,
  productId: string,
  live: boolean,
  applied = false,
) {
  // An archived coupon still discounts subscriptions that already use it.
  if (
    (!applied && !coupon.valid) ||
    coupon.livemode !== live ||
    coupon.percent_off !== 100 ||
    coupon.amount_off !== null ||
    coupon.duration !== "forever" ||
    coupon.applies_to?.products.length !== 1 ||
    coupon.applies_to.products[0] !== productId
  ) {
    throw new BillingAdminError(
      "The complimentary coupon must give 100% off forever, restricted to the Pro product in the selected mode.",
    );
  }
}
