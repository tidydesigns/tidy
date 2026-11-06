import { expect, test } from "bun:test";
import { describeHarnessFailure } from "./harness-failure";
import { harnessFailureKindSchema } from "../contracts/harness-failure";

const usageLimitIncident =
  "You’ve hit your usage limit. Visit https://chatgpt.com/settings/usage to purchase more credits or try again at Nov 12th, 2026 9:02 PM.";

for (const [message, kind] of [
  [
    "This content was flagged for possible cybersecurity risk. Apply for Daybreak access.",
    "policy",
  ],
  ["content_policy_violation: request blocked", "policy"],
  ["insufficient_quota: check billing", "billing"],
  ["429 Too many requests", "rate-limit"],
  ["Your usage limit has been reached", "usage-limit"],
  [usageLimitIncident, "usage-limit"],
  ["usage_limit_exceeded", "usage-limit"],
  ["Quota exhausted; resets tomorrow", "usage-limit"],
  ["Your quota resets at 9 PM", "usage-limit"],
  ["429 Too many requests; try again in 30 seconds", "rate-limit"],
  ["Rate limit exceeded; resets in one minute", "rate-limit"],
  ["401 authentication_error: token expired", "authentication"],
  ["context_length_exceeded", "context"],
  ["Context window limit exceeded", "context"],
  ["Model does not exist", "model"],
  ["403 permission denied", "permission"],
  ["ECONNRESET", "connection"],
  ["Request timed out", "timeout"],
  ["503 service unavailable", "unavailable"],
  ["The harness returned an invalid event.", "harness"],
  ["You’ve hit your limit · resets this afternoon", "usage-limit"],
  ["Out of credits", "billing"],
  ["Session not found", "session"],
  ["Unknown session identifier", "session"],
  ["No rollout found for this session", "session"],
  ["Provider deadline exceeded", "timeout"],
  ["EAI_AGAIN", "connection"],
  ["Diagnostic request 140142941350320", "unknown"],
  ["Connection refused", "connection"],
  ["The model encountered an unknown error", "unknown"],
  ["The quota has been exceeded", "usage-limit"],
  ["HTTP 402", "billing"],
  ["HTTP 504", "timeout"],
  ["HTTP 529", "unavailable"],
  ["Maximum number of turns reached", "turn-limit"],
  ["max_output_tokens", "output"],
  ["error_max_structured_output_retries", "output-format"],
  ["Run budget exhausted", "budget"],
  ["shared rollout token budget exhausted", "budget"],
  ["Account is on hold", "account"],
  ["verification_required", "account"],
  ["oauth_org_not_allowed", "account"],
  ["cloud_credential_error", "authentication"],
  ["API key is invalid", "authentication"],
  ["No thread with id: missing", "session"],
  ["Input is too long", "context"],
  ["Request too large", "request-size"],
  ["Invalid image data", "attachment"],
  ["Unsupported media type", "attachment"],
  ["Unknown model selected", "model"],
  ["Sandbox setup failed", "sandbox"],
  ["ENOSPC: no space left on device", "storage"],
  ["EDQUOT: disk quota exceeded", "storage"],
  ["EROFS: read-only file system", "storage"],
  ["Thread changes could not be written to disk.", "storage"],
  ["Project folder not found", "workspace"],
  ["Turn is still active", "busy"],
  ["The harness turn was interrupted.", "interrupted"],
  ["Unrecognized argument --model-setting", "configuration"],
  ["HTTP 400 invalid request", "request"],
  ["HTTP 422 unsupported parameter", "request"],
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

test("structured classifications survive generic messages, with legacy text as a fallback", () => {
  expect(describeHarnessFailure("Something went wrong", "sandbox").kind).toBe("sandbox");
  expect(describeHarnessFailure("Authentication failed", "unknown").kind).toBe("authentication");
});

test("usage limits have a supported contract and distinct guidance", () => {
  expect(harnessFailureKindSchema.parse("usage-limit")).toBe("usage-limit");
  const usage = describeHarnessFailure(usageLimitIncident);
  expect(usage.title).toBe("Usage limit reached");
  expect(usage.guidance).toContain("resets");
  expect(usage.title).not.toBe(describeHarnessFailure("", "billing").title);
  expect(usage.title).not.toBe(describeHarnessFailure("", "rate-limit").title);
});

test("legacy rate-limit errors recover quota guidance without overriding other known kinds", () => {
  expect(describeHarnessFailure(usageLimitIncident, "rate-limit").kind).toBe("usage-limit");
  expect(describeHarnessFailure("Quota exceeded", "rate-limit").kind).toBe("usage-limit");
  expect(describeHarnessFailure("Too many requests; resets in 30 seconds", "rate-limit").kind).toBe(
    "rate-limit",
  );
  expect(describeHarnessFailure("Unknown failure", "rate-limit").kind).toBe("rate-limit");
  for (const kind of ["policy", "budget", "billing"] as const) {
    expect(describeHarnessFailure(usageLimitIncident, kind).kind).toBe(kind);
  }
});

for (const [message, kind] of [
  ["Content policy violation; usage limit reached", "policy"],
  ["Run budget exhausted; usage limit reached", "budget"],
  ["Insufficient quota; usage limit reached", "billing"],
  ["Billing error; usage limit reached", "billing"],
  ["EDQUOT: disk quota exceeded", "storage"],
] as const) {
  test(`${kind} keeps precedence over usage-limit prose`, () => {
    expect(describeHarnessFailure(message).kind).toBe(kind);
    expect(describeHarnessFailure(message, "rate-limit").kind).toBe("rate-limit");
  });
}

for (const [message, kind] of [
  ["permission_error", "permission"],
  ["not_found_error", "request"],
  ["request_too_large", "request-size"],
  ["api_error", "unavailable"],
  ["timeout_error", "timeout"],
  ["rate_limit_error", "rate-limit"],
  ["authentication_error", "authentication"],
  ["billing_error", "billing"],
  ["overloaded_error", "unavailable"],
] as const) {
  test(`API error type ${message} has specific guidance`, () => {
    expect(describeHarnessFailure(message).kind).toBe(kind);
  });
}
