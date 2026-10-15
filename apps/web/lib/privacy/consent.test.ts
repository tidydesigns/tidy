import { expect, test } from "bun:test";
import {
  CONSENT_MAX_AGE,
  CONSENT_VERSION,
  ESSENTIAL_ONLY,
  consentCookie,
  consentRevision,
  readConsent,
} from "./consent";
import { redactTelemetry } from "./telemetry";
import type { CaptureResult } from "posthog-js";

const now = 1791928800000;
const all = { analytics: true, replay: true, diagnostics: true };
const cookie = (value: unknown) => `tidy_consent=${encodeURIComponent(JSON.stringify(value))}`;

test("only explicit, current, unexpired, unambiguous choices grant consent", () => {
  const valid = { version: CONSENT_VERSION, at: now, ...all };
  expect(readConsent(cookie(valid), now)).toEqual(valid);
  for (const value of [
    null,
    {},
    { ...valid, version: 1 },
    { ...valid, version: 2 },
    { ...valid, at: now + 1 },
    { ...valid, at: now - CONSENT_MAX_AGE * 1000 },
    { ...valid, analytics: "true" },
    { ...valid, replay: undefined },
  ])
    expect(readConsent(cookie(value), now)).toBeNull();
  expect(readConsent(`${cookie(valid)}; ${cookie(valid)}`, now)).toBeNull();
  expect(readConsent("tidy_consent=%broken", now)).toBeNull();
  expect(readConsent(undefined, now)).toBeNull();
  expect(readConsent(consentCookie(ESSENTIAL_ONLY, now), now)).toMatchObject(ESSENTIAL_ONLY);
  expect(consentCookie(all, now)).toContain("SameSite=Lax; Secure");
  expect(consentCookie(all, now)).not.toContain("Domain=");
  expect(consentRevision(valid)).not.toBe(consentRevision({ ...valid, replay: false }));
});

test("editing remembered choices creates a fresh consent revision for every change", () => {
  let saved = readConsent(consentCookie(ESSENTIAL_ONLY, now), now)!;
  const purposes = [
    "analytics",
    "replay",
    "diagnostics",
    "replay",
    "analytics",
    "diagnostics",
  ] as const;
  for (const [index, purpose] of purposes.entries()) {
    const at = now + (index + 1) * 1000;
    const next = { ...saved, [purpose]: !saved[purpose] };
    const updated = readConsent(consentCookie(next, at), at);
    expect(updated).toEqual({ ...next, version: CONSENT_VERSION, at });
    expect(consentRevision(updated!)).not.toBe(consentRevision(saved));
    saved = updated!;
  }
  expect(saved).toMatchObject(ESSENTIAL_ONLY);
});

test("cookie writes own their version and timestamp instead of copying caller metadata", () => {
  const choices = {
    ...all,
    version: CONSENT_VERSION - 1,
    at: now - 1000,
    metadata: "not a purpose",
  };
  const stored = consentCookie(choices, now);
  expect(readConsent(stored, now)).toEqual({ ...all, version: CONSENT_VERSION, at: now });
  expect(decodeURIComponent(stored)).not.toContain("metadata");
});

function event(name: string, properties: Record<string, unknown> = {}): CaptureResult {
  return {
    event: name,
    properties: { token: "synthetic-key", distinct_id: "synthetic-person", ...properties },
  } as unknown as CaptureResult;
}
const url = "https://app.example/files/private-file-id?token=secret#private";
test("all eight combinations enforce independent purpose boundaries", () => {
  for (let bits = 0; bits < 8; bits++) {
    const choices = { analytics: !!(bits & 1), replay: !!(bits & 2), diagnostics: !!(bits & 4) };
    for (const [name, purpose] of [
      ["$pageview", "analytics"],
      ["survey sent", "analytics"],
      ["$snapshot", "replay"],
      ["$exception", "diagnostics"],
      ["$web_vitals", "diagnostics"],
    ] as const)
      expect(Boolean(redactTelemetry(event(name), choices, url))).toBe(choices[purpose]);
    expect(redactTelemetry(event("unreviewed-event"), choices, url)).toBeNull();
  }
});
test("events remove content, identity traits, raw URLs and DOM properties", () => {
  const result = redactTelemetry(
    event("$autocapture", {
      email: "private@example.com",
      name: "Private",
      $current_url: url,
      $elements: [{ text: "secret" }],
      $event_type: "click",
      $referrer: url,
      document: "private design",
    }),
    all,
    url,
  )!;
  expect(result.properties).toEqual({
    token: "synthetic-key",
    distinct_id: "synthetic-person",
    $current_url: "https://app.example/files/:id",
    $pathname: "/files/:id",
    $geoip_disable: true,
    $process_person_profile: false,
    $event_type: "click",
  });
});
test("identity requires a matching account and at least one selected purpose", () => {
  const account = { id: "synthetic-person", email: "account@example.test" };
  for (let bits = 0; bits < 8; bits++) {
    const choices = { analytics: !!(bits & 1), replay: !!(bits & 2), diagnostics: !!(bits & 4) };
    for (const name of ["$identify", "$set"]) {
      const input = event(name, {
        $set: { email: "wrong@example.test", name: "Private name" },
        $set_once: { private: "secret" },
        $anon_distinct_id: "consented-browser-id",
      });
      Object.assign(input, {
        $set: { email: "wrong@example.test" },
        $set_once: { private: "secret" },
      });
      const result = redactTelemetry(input, choices, url, account);
      expect(Boolean(result)).toBe(bits !== 0);
      if (result) {
        expect(result.properties.$set).toEqual({ email: account.email });
        expect(result.properties.$process_person_profile).toBe(true);
        expect(JSON.stringify(result)).not.toMatch(/wrong@example|Private name|secret|\$set_once/);
        expect(result.properties.$anon_distinct_id).toBe(
          name === "$identify" ? "consented-browser-id" : undefined,
        );
      }
      expect(redactTelemetry(input, choices, url)).toBeNull();
      expect(
        redactTelemetry(input, choices, url, { ...account, id: "different-account" }),
      ).toBeNull();
    }
  }
});
test("identified replay does not permit analytics or email on ordinary events", () => {
  const account = { id: "synthetic-person", email: "account@example.test" };
  const replayOnly = { analytics: false, replay: true, diagnostics: false };
  expect(redactTelemetry(event("$pageview"), replayOnly, url, account)).toBeNull();
  expect(redactTelemetry(event("$exception"), replayOnly, url, account)).toBeNull();
  const result = redactTelemetry(
    event("$snapshot", { email: account.email, $set: account }),
    replayOnly,
    url,
    account,
  )!;
  expect(result.properties.$process_person_profile).toBe(true);
  expect(JSON.stringify(result)).not.toContain(account.email);
  expect(
    redactTelemetry(event("$snapshot"), replayOnly, url)!.properties.$process_person_profile,
  ).toBe(false);
});
test("exceptions cannot forward messages, stacks, console arguments or arbitrary types", () => {
  const result = redactTelemetry(
    event("$exception", {
      $exception_list: [
        {
          type: "private name",
          value: "private message",
          stacktrace: { frames: [{ filename: url, vars: { password: "secret" } }] },
        },
      ],
      $exception_message: "secret",
    }),
    all,
    url,
  )!;
  expect(JSON.stringify(result)).not.toMatch(/private|secret|password/);
  expect(result.properties.$exception_list).toEqual([
    { type: "Error", value: "Application error (message removed for privacy)" },
  ]);
});
test("numeric performance metrics and explicitly submitted survey answers survive", () => {
  expect(
    redactTelemetry(
      event("$web_vitals", {
        $web_vitals_LCP_value: 123,
        $web_vitals_LCP_element: "private selector",
      }),
      all,
      url,
    )!.properties.$web_vitals_LCP_value,
  ).toBe(123);
  expect(
    redactTelemetry(
      event("survey sent", {
        $survey_id: "synthetic-survey",
        $survey_response: "Deliberate answer",
        private: "no",
      }),
      all,
      url,
    )!.properties.$survey_response,
  ).toBe("Deliberate answer");
});
