import { expect, test } from "bun:test";
import { cancelsAtPeriodEnd } from "./cancellation";

test("recognizes period-end cancellation scheduled through either Stripe field", () => {
  const periodEnd = 1793393257;
  expect(cancelsAtPeriodEnd({ cancel_at_period_end: true, cancel_at: null }, periodEnd)).toBe(true);
  expect(cancelsAtPeriodEnd({ cancel_at_period_end: false, cancel_at: periodEnd }, periodEnd)).toBe(
    true,
  );
  expect(
    cancelsAtPeriodEnd({ cancel_at_period_end: false, cancel_at: periodEnd - 86400 }, periodEnd),
  ).toBe(false);
  expect(cancelsAtPeriodEnd({ cancel_at_period_end: false, cancel_at: null }, periodEnd)).toBe(
    false,
  );
});
