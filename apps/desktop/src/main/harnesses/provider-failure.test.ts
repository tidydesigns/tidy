import { expect, test } from "bun:test";
import { codexFailure, providerFailureKind } from "./provider-failure";

for (const [code, kind] of [
  ["contextWindowExceeded", "context"],
  ["sessionBudgetExceeded", "budget"],
  ["usageLimitExceeded", "usage-limit"],
  ["usage_limit_exceeded", "usage-limit"],
  ["usage-limit-exceeded", "usage-limit"],
  ["usage_limit_reached", "usage-limit"],
  ["usage_limit", "usage-limit"],
  ["quota_exceeded", "usage-limit"],
  ["quota_exhausted", "usage-limit"],
  ["insufficient_quota", "billing"],
  ["rateLimitExceeded", "rate-limit"],
  ["flexUnavailable", "unavailable"],
  ["serverOverloaded", "unavailable"],
  ["modelNotFound", "model"],
  ["policyCapacityUnavailable", "unavailable"],
  ["cyberPolicy", "policy"],
  ["bioPolicy", "policy"],
  ["misalignmentPolicyViolation", "policy"],
  ["tooManyDenials", "permission"],
  ["internalServerError", "unavailable"],
  ["unauthorized", "authentication"],
  ["badRequest", "request"],
  ["threadRollbackFailed", "session"],
  ["sandboxError", "sandbox"],
  ["other", "unknown"],
  ["futureError", "unknown"],
  ["constructor", "unknown"],
] as const) {
  test(`structured error ${code} survives an uninformative message`, () => {
    expect(codexFailure({ message: "This turn failed.", codexErrorInfo: code }).kind).toBe(kind);
  });
}

for (const code of [
  "httpConnectionFailed",
  "responseStreamConnectionFailed",
  "responseStreamDisconnected",
  "responseTooManyFailedAttempts",
]) {
  test(`${code} reads a transport failure and its upstream status`, () => {
    expect(
      codexFailure({
        message: "Upstream failed",
        codexErrorInfo: { [code]: { httpStatusCode: null } },
      }).kind,
    ).toBe("connection");
    expect(
      codexFailure({
        message: "Upstream failed",
        codexErrorInfo: { [code]: { httpStatusCode: 401 } },
      }).kind,
    ).toBe("authentication");
  });
}

for (const [httpStatusCode, kind] of [
  [400, "request"],
  [402, "billing"],
  [403, "permission"],
  [408, "timeout"],
  [413, "request-size"],
  [429, "rate-limit"],
  [500, "unavailable"],
  [504, "timeout"],
] as const) {
  test(`upstream HTTP ${httpStatusCode} has actionable guidance`, () => {
    expect(
      codexFailure({
        message: "Upstream failed",
        codexErrorInfo: { httpConnectionFailed: { httpStatusCode } },
      }).kind,
    ).toBe(kind);
  });
}

test("specific failure codes take priority over incidental status text", () => {
  expect(
    codexFailure({ message: "Request blocked after HTTP 403", codexErrorInfo: "cyberPolicy" }).kind,
  ).toBe("policy");
  expect(
    codexFailure({ message: "Limit reached", codexErrorInfo: "sessionBudgetExceeded" }).kind,
  ).toBe("budget");
});

test("Codex usage-limit incident preserves the provider reset date", () => {
  const message =
    "You’ve hit your usage limit. Visit https://chatgpt.com/settings/usage to purchase more credits or try again at Nov 12th, 2026 9:02 PM.";
  for (const code of ["usageLimitExceeded", "usage_limit_exceeded", "rateLimitExceeded", ""]) {
    expect(providerFailureKind(message, code)).toBe("usage-limit");
    expect(codexFailure({ message, codexErrorInfo: code })).toMatchObject({
      kind: "usage-limit",
      message,
    });
  }
  for (const code of ["usageLimitExceeded", "httpConnectionFailed"]) {
    expect(
      codexFailure({
        message,
        codexErrorInfo: { [code]: { httpStatusCode: 429 } },
      }).kind,
    ).toBe("usage-limit");
  }
  for (const [code, kind] of [
    ["cyberPolicy", "policy"],
    ["sessionBudgetExceeded", "budget"],
    ["billing_error", "billing"],
    ["insufficient_quota", "billing"],
  ] as const) {
    expect(providerFailureKind(message, code)).toBe(kind);
  }
});

test("temporary rate limits retain their classification", () => {
  expect(providerFailureKind("Too many requests; resets in 30 seconds", "rateLimitExceeded")).toBe(
    "rate-limit",
  );
  expect(providerFailureKind("429 Too many requests", "")).toBe("rate-limit");
});

test("error details remain bounded without copying arbitrary provider payloads", () => {
  const error = codexFailure({
    message: "Failed",
    additionalDetails: "Useful explanation",
    codexErrorInfo: { futureCode: { secret: "not-visible" } },
  });
  expect(error.message).toBe("Failed\n\nUseful explanation");
  expect(error.kind).toBe("unknown");
  expect(codexFailure({ message: "x".repeat(6000) }).message.length).toBe(4000);
  expect(codexFailure(null).kind).toBe("unknown");
  expect(codexFailure({ message: 123 }).kind).toBe("unknown");
});

for (const [code, kind] of [
  ["authentication_failed", "authentication"],
  ["oauth_org_not_allowed", "account"],
  ["account_on_hold", "account"],
  ["verification_required", "account"],
  ["billing_error", "billing"],
  ["rate_limit", "rate-limit"],
  ["overloaded", "unavailable"],
  ["invalid_request", "request"],
  ["model_not_found", "model"],
  ["server_error", "unavailable"],
  ["unknown", "unknown"],
  ["max_output_tokens", "output"],
  ["cloud_credential_error", "authentication"],
  ["error_max_turns", "turn-limit"],
  ["error_max_budget_usd", "budget"],
  ["error_max_structured_output_retries", "output-format"],
  ["prompt_too_long", "context"],
  ["image_error", "attachment"],
  ["aborted_streaming", "interrupted"],
  ["aborted_tools", "interrupted"],
  ["malformed_tool_use_exhausted", "output-format"],
  ["hook_stopped", "configuration"],
  ["stop_hook_prevented", "configuration"],
  ["blocking_limit", "rate-limit"],
  ["rapid_refill_breaker", "rate-limit"],
  ["budget_exhausted", "budget"],
  ["structured_output_retry_exhausted", "output-format"],
  ["turn_setup_failed", "harness"],
  ["tool_deferred_unavailable", "request"],
] as const) {
  test(`provider code ${code} is classified without relying on prose`, () => {
    expect(providerFailureKind("", code)).toBe(kind);
  });
}

test("policy capacity is an availability failure rather than a refusal", () => {
  expect(
    codexFailure({
      message: "Safety policy capacity is unavailable",
      codexErrorInfo: "policyCapacityUnavailable",
    }).kind,
  ).toBe("unavailable");
});
