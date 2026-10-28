import { expect, test } from "bun:test";
import { describeHarnessFailure } from "./harness-failure";

for (const [message, kind] of [
  [
    "This content was flagged for possible cybersecurity risk. Apply for Daybreak access.",
    "policy",
  ],
  ["content_policy_violation: request blocked", "policy"],
  ["insufficient_quota: check billing", "billing"],
  ["429 Too many requests", "rate-limit"],
  ["Your usage limit has been reached", "rate-limit"],
  ["401 authentication_error: token expired", "authentication"],
  ["context_length_exceeded", "context"],
  ["Context window limit exceeded", "context"],
  ["Model does not exist", "model"],
  ["403 permission denied", "permission"],
  ["ECONNRESET", "connection"],
  ["Request timed out", "connection"],
  ["503 service unavailable", "unavailable"],
  ["The harness returned an invalid event.", "harness"],
  ["Unexpected response", "unknown"],
  ["", "unknown"],
] as const) {
  test(`classifies ${message || "an empty error"}`, () => {
    expect(describeHarnessFailure(message).kind).toBe(kind);
  });
}

test("only offers Daybreak when the provider explicitly mentions it", () => {
  expect(describeHarnessFailure("content policy violation")).toMatchObject({ daybreak: false });
  expect(describeHarnessFailure("Apply for Daybreak access")).toMatchObject({ daybreak: true });
});
