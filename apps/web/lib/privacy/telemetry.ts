import type { CaptureResult } from "posthog-js";
import { hasOptionalConsent, type ConsentChoices, type ConsentPurpose } from "./consent";
import { normalizedRoute } from "../route-normalization";
import { browserExceptions } from "./browser-exceptions";

const customEvents = new Set([
  "vault_login_created",
  "github_installation_linked",
  "github_account_disconnected",
  "pull_request_linked",
  "review_feedback_added",
  "team_invitations_created",
  "onboarding_completed",
  "organization_switched",
  "organization_created",
  "design_file_created",
]);
const booleans = new Set([
  "in_folder",
  "invite_team",
  "has_design_layer",
  "has_implementation_point",
  "panels_open",
  "has_selection",
]);
const numbers = new Set([
  "frame_count",
  "invitation_count",
  "sample_rate",
  "interactions",
  "frames",
  "frame_ms_mean",
  "frame_ms_p95",
  "frame_ms_max",
  "frames_over_34_ms",
  "long_tasks",
  "long_task_ms",
]);
const baseStrings = new Set([
  "token",
  "distinct_id",
  "$device_id",
  "$session_id",
  "$window_id",
  "$lib",
  "$lib_version",
  "$app_version",
  "$browser",
  "$browser_version",
  "$os",
  "$os_version",
  "$device_type",
  "tidy_consent_receipt",
]);
const baseNumbers = new Set([
  "$screen_height",
  "$screen_width",
  "$viewport_height",
  "$viewport_width",
]);

export function telemetryPurpose(event: string): ConsentPurpose | null {
  if (event === "$snapshot") return "replay";
  if (
    event === "$exception" ||
    event === "$web_vitals" ||
    event === "editor_interaction_performance"
  )
    return "diagnostics";
  if (
    customEvents.has(event) ||
    [
      "$pageview",
      "$pageleave",
      "$autocapture",
      "$rageclick",
      "$feature_flag_called",
      "survey shown",
      "survey dismissed",
      "survey sent",
    ].includes(event)
  )
    return "analytics";
  return null;
}

export function safeTelemetryUrl(value: string) {
  try {
    const url = new URL(value, "https://app.tidydesign.co");
    return `${url.origin}${normalizedRoute(url.href)}`;
  } catch {
    return "https://app.tidydesign.co/:id";
  }
}

export type TelemetryAccount = { id: string; email: string };

export function telemetryAccount(id: unknown, email: unknown): TelemetryAccount | undefined {
  return typeof id === "string" &&
    id.length > 0 &&
    id.length <= 200 &&
    typeof email === "string" &&
    email.length > 0 &&
    email.length <= 320
    ? { id, email }
    : undefined;
}

export function redactTelemetry(
  event: CaptureResult,
  choices: ConsentChoices,
  pageUrl: string,
  account?: TelemetryAccount,
): CaptureResult | null {
  const identified = Boolean(account && event.properties.distinct_id === account.id);
  const identityEvent = event.event === "$identify" || event.event === "$set";
  const purpose = telemetryPurpose(event.event);
  // Identification supports each selected purpose, including replay-only users.
  // It never grants permission for an event belonging to another purpose.
  if (identityEvent ? !identified || !hasOptionalConsent(choices) : !purpose || !choices[purpose])
    return null;
  const source = event.properties;
  const properties: Record<string, unknown> = {
    $current_url: safeTelemetryUrl(pageUrl),
    $pathname: normalizedRoute(safeTelemetryUrl(pageUrl)),
    $geoip_disable: true,
    $process_person_profile: identified,
  };
  for (const [name, value] of Object.entries(source)) {
    if (
      (baseStrings.has(name) && typeof value === "string" && value.length < 200) ||
      (baseNumbers.has(name) && typeof value === "number" && Number.isFinite(value))
    )
      properties[name] = value;
    if (booleans.has(name) && typeof value === "boolean") properties[name] = value;
    if (numbers.has(name) && typeof value === "number" && Number.isFinite(value))
      properties[name] = Math.max(0, Math.min(value, 1e8));
    if (name === "interaction" && ["pointer", "wheel"].includes(String(value)))
      properties[name] = value;
    if (name === "node_bucket" && typeof value === "string" && /^[\d+<>=-]{1,20}$/.test(value))
      properties[name] = value;
    if (
      event.event === "$web_vitals" &&
      /^\$web_vitals_(LCP|INP|CLS|FCP)(_value)?$/.test(name) &&
      typeof value === "number" &&
      Number.isFinite(value)
    )
      properties[name] = value;
  }
  if (identified) properties.$is_identified = true;
  if (identityEvent && account) {
    // Email comes from the authenticated account, not arbitrary event properties.
    properties.$set = { email: account.email };
    if (
      event.event === "$identify" &&
      typeof source.$anon_distinct_id === "string" &&
      source.$anon_distinct_id.length <= 200
    )
      properties.$anon_distinct_id = source.$anon_distinct_id;
  }
  if (event.event === "$autocapture" || event.event === "$rageclick") {
    if (["click", "change", "submit"].includes(String(source.$event_type)))
      properties.$event_type = source.$event_type;
  }
  if (event.event === "$exception") {
    properties.$exception_list = browserExceptions(source.$exception_list, pageUrl);
    properties.$exception_level = "error";
    // Let PostHog group by sanitized code location rather than merging every
    // browser fault under a single fingerprint. Release IDs link source maps.
    if (typeof source.$release_id === "string" && /^[\w.-]{1,100}$/.test(source.$release_id))
      properties.$release_id = source.$release_id;
  }
  if (event.event === "$snapshot") {
    // rrweb masks text/attributes/inputs before capture. These fields are the recorder protocol.
    for (const name of [
      "$snapshot_data",
      "$snapshot_bytes",
      "$snapshot_encoded",
      "$lib",
      "$lib_version",
    ])
      if (source[name] !== undefined) properties[name] = source[name];
  }
  if (event.event === "$feature_flag_called") {
    if (typeof source.$feature_flag === "string" && /^[\w-]{1,100}$/.test(source.$feature_flag))
      properties.$feature_flag = source.$feature_flag;
    if (typeof source.$feature_flag_response === "boolean")
      properties.$feature_flag_response = source.$feature_flag_response;
  }
  if (event.event.startsWith("survey ")) {
    // Answers are deliberately supplied by the user in an optional survey.
    for (const [key, value] of Object.entries(source))
      if (
        /^\$survey_(id|submission_id|completed|response(?:_[\w-]+)?)$/.test(key) &&
        ((typeof value === "string" && value.length <= 10000) ||
          typeof value === "number" ||
          typeof value === "boolean")
      )
        properties[key] = value;
  }
  const result = { ...event, properties } as CaptureResult & {
    $set?: Record<string, unknown>;
    $set_once?: Record<string, unknown>;
  };
  // Some SDK paths use top-level person properties. Never forward automatic
  // traits, names, URLs or caller-supplied profile data through either location.
  delete result.$set;
  delete result.$set_once;
  return result;
}
