import { expect, test } from "bun:test";
import type { CaptureResult } from "posthog-js";
import { redactTelemetry } from "./telemetry";

const account = { id: "synthetic-account", email: "synthetic@example.test" };
const page = "https://app.example/org/private-id/files?secret=private";
const metadata = {
  source: "web_sidebar",
  variant: "cloud-light",
  platform: "macos",
  channel: "beta",
};
function download(properties: Record<string, unknown> = {}): CaptureResult {
  return {
    uuid: "00000000-0000-4000-8000-000000000001",
    event: "desktop_download_clicked",
    properties: { distinct_id: account.id, ...metadata, ...properties },
  } as CaptureResult;
}

test("download clicks require analytics consent and the current authenticated identity", () => {
  for (let bits = 0; bits < 8; bits++) {
    const choices = { analytics: !!(bits & 1), replay: !!(bits & 2), diagnostics: !!(bits & 4) };
    expect(Boolean(redactTelemetry(download(), choices, page, account))).toBe(choices.analytics);
    expect(redactTelemetry(download(), choices, page)).toBeNull();
    expect(
      redactTelemetry(download({ distinct_id: "previous-account" }), choices, page, account),
    ).toBeNull();
  }
});

test("download metadata survives redaction without URLs, email or release details", () => {
  const choices = { analytics: true, replay: false, diagnostics: false };
  for (const variant of ["cloud-light", "spectrum-glint", "prism-edge"]) {
    const input = download({
      variant,
      href: "https://private.example",
      email: account.email,
      version: "private-release",
      $set: { email: "untrusted@example.test" },
    });
    const result = redactTelemetry(input, choices, page, account)!;
    expect(result.properties).toMatchObject({
      ...metadata,
      variant,
      distinct_id: account.id,
      $is_identified: true,
    });
    expect(result.properties).not.toHaveProperty("href");
    expect(result.properties).not.toHaveProperty("email");
    expect(result.properties).not.toHaveProperty("version");
    expect(result.properties).not.toHaveProperty("$set");
    const otherEvent = redactTelemetry(
      { ...input, event: "design_file_created" },
      choices,
      page,
      account,
    )!;
    for (const key of Object.keys(metadata)) expect(otherEvent.properties).not.toHaveProperty(key);
  }
  for (const value of ["private text", ["cloud-light"], {}, 42, null]) {
    const properties = Object.fromEntries(Object.keys(metadata).map((key) => [key, value]));
    const result = redactTelemetry(download(properties), choices, page, account)!;
    for (const key of Object.keys(metadata)) expect(result.properties).not.toHaveProperty(key);
  }
});
