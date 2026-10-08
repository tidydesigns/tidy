import { afterEach, expect, mock, test } from "bun:test";

mock.module("server-only", () => ({}));
const { checkoutPricing, validateCatalog } = await import("./server");
const originalPrice = process.env.STRIPE_PRO_PRICE_ID;
const originalCoupon = process.env.STRIPE_FIRST_MONTH_COUPON_ID;
afterEach(() => {
  if (originalPrice === undefined) Reflect.deleteProperty(process.env, "STRIPE_PRO_PRICE_ID");
  else process.env.STRIPE_PRO_PRICE_ID = originalPrice;
  if (originalCoupon === undefined)
    Reflect.deleteProperty(process.env, "STRIPE_FIRST_MONTH_COUPON_ID");
  else process.env.STRIPE_FIRST_MONTH_COUPON_ID = originalCoupon;
});

function catalog(
  amount: number,
  discount: number,
  duration = "once",
  percent = false,
  couponProducts = ["prod_pro"],
) {
  return {
    prices: {
      retrieve: async () => ({
        active: true,
        currency: "usd",
        unit_amount: amount,
        recurring: { interval: "month", interval_count: 1 },
        product: "prod_pro",
      }),
    },
    coupons: {
      retrieve: async () => ({
        valid: true,
        amount_off: percent ? null : discount,
        percent_off: percent ? discount : null,
        currency: percent ? null : "usd",
        duration,
        applies_to: { products: couponProducts },
      }),
    },
  } as unknown as Parameters<typeof validateCatalog>[0];
}

test("checkout accepts the $10 monthly Pro price and an equivalent first-month discount", async () => {
  process.env.STRIPE_PRO_PRICE_ID = "price_pro";
  process.env.STRIPE_FIRST_MONTH_COUPON_ID = "coupon_first_month";
  await expect(validateCatalog(catalog(1000, 500))).resolves.toBeUndefined();
  await expect(validateCatalog(catalog(1000, 50, "once", true))).resolves.toBeUndefined();
  await expect(validateCatalog(catalog(900, 500))).rejects.toThrow("$10 USD per month");
  await expect(
    validateCatalog(catalog(1000, 500, "once", false, ["different_product"])),
  ).rejects.toThrow("does not apply");
  await expect(validateCatalog(catalog(1000, 400))).rejects.toThrow("50% or $5 USD off once");
  await expect(validateCatalog(catalog(1000, 40, "once", true))).rejects.toThrow(
    "50% or $5 USD off once",
  );
  await expect(validateCatalog(catalog(1000, 500, "forever"))).rejects.toThrow(
    "50% or $5 USD off once",
  );
  expect(checkoutPricing(false)).toEqual({
    line_items: [{ price: "price_pro", quantity: 1 }],
    discounts: [{ coupon: "coupon_first_month" }],
  });
  expect(checkoutPricing(true)).toEqual({ line_items: [{ price: "price_pro", quantity: 1 }] });
});
