import type { CaptureResult } from "posthog-js";
import type { ConsentChoices } from "@tidy/ui/privacy-consent";

export function websiteUrl(value: string) {
  const origin = typeof location === "undefined" ? "https://tidydesign.co" : location.origin;
  try {
    const url = new URL(value, origin);
    if (!["http:", "https:"].includes(url.protocol)) throw new Error("Not a website URL");
    const path = url.pathname.replace(/\/$/, "") || "/";
    const publicPath = /^(\/|\/(about|privacy|changelog|blog)|\/blog\/[a-z0-9-]{1,100})$/.test(
      path,
    );
    return `${url.origin}${publicPath ? path : "/:unknown"}`;
  } catch {
    return `${origin}/:unknown`;
  }
}

export function acquisitionProperties(page: string, referrer: string) {
  const properties: Record<string, string> = {};
  try {
    const url = new URL(page);
    for (const key of ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term"])
      if (/^[a-z0-9_-]{1,80}$/i.test(url.searchParams.get(key) ?? ""))
        properties[key] = url.searchParams.get(key)!;
    const source = new URL(referrer);
    if (source.origin !== url.origin && ["https:", "http:"].includes(source.protocol)) {
      properties.$referrer = source.origin;
      properties.$referring_domain = source.hostname;
    }
  } catch {}
  return properties;
}

const strings = new Set([
  "token",
  "distinct_id",
  "$device_id",
  "$session_id",
  "$window_id",
  "$pageview_id",
  "$lib",
  "$lib_version",
  "$browser",
  "$browser_version",
  "$os",
  "$os_version",
  "$device_type",
  "tidy_consent_receipt",
]);
const numbers = new Set([
  "$screen_height",
  "$screen_width",
  "$viewport_height",
  "$viewport_width",
  "$prev_pageview_duration",
  "$prev_pageview_max_scroll_percentage",
  "$prev_pageview_max_content_percentage",
]);
const actions = ["open_tidy", "signup", "download_mac", "github", "documentation", "navigation"];

export function redactWebsiteEvent(
  event: CaptureResult,
  choices: ConsentChoices,
  page: string,
  acquisition: Record<string, string>,
): CaptureResult | null {
  const purpose =
    event.event === "$snapshot"
      ? "replay"
      : ["$exception", "$web_vitals"].includes(event.event)
        ? "diagnostics"
        : [
              "$pageview",
              "$pageleave",
              "$autocapture",
              "$rageclick",
              "website_cta_clicked",
              "website_section_viewed",
            ].includes(event.event)
          ? "analytics"
          : null;
  if (!purpose || !choices[purpose]) return null;
  const source = event.properties;
  const safe = websiteUrl(page);
  const properties: Record<string, unknown> = {
    surface: "website",
    $current_url: safe,
    $pathname: new URL(safe).pathname,
    $geoip_disable: true,
    $process_person_profile: false,
  };
  for (const [key, value] of Object.entries(source)) {
    if (strings.has(key) && typeof value === "string" && value.length < 200)
      properties[key] = value;
    if (
      (numbers.has(key) || /^\$web_vitals_(LCP|INP|CLS|FCP)(_value)?$/.test(key)) &&
      typeof value === "number" &&
      Number.isFinite(value)
    )
      properties[key] = Math.max(0, Math.min(value, 1e8));
  }
  if (purpose === "analytics") Object.assign(properties, acquisition);
  if (
    purpose === "analytics" &&
    typeof source.website_visitor_id === "string" &&
    /^[a-f0-9-]{36}$/.test(source.website_visitor_id)
  )
    properties.website_visitor_id = source.website_visitor_id;
  if (["click", "change", "submit"].includes(String(source.$event_type)))
    properties.$event_type = source.$event_type;
  // Keep structural click targets, never DOM text, field values, links or arbitrary attributes.
  if (Array.isArray(source.$elements))
    properties.$elements = source.$elements
      .slice(0, 10)
      .filter((item) => item && typeof item === "object")
      .map((item) => ({
        tag_name:
          typeof item.tag_name === "string" && /^[a-z0-9-]{1,20}$/.test(item.tag_name)
            ? item.tag_name
            : "unknown",
        ...(Number.isSafeInteger(item.nth_child) ? { nth_child: item.nth_child } : {}),
        ...(Number.isSafeInteger(item.nth_of_type) ? { nth_of_type: item.nth_of_type } : {}),
      }));
  if (event.event === "website_cta_clicked") {
    if (!actions.includes(String(source.action))) return null;
    properties.action = source.action;
    if (["header", "hero", "footer", "content"].includes(String(source.placement)))
      properties.placement = source.placement;
  }
  if (event.event === "website_section_viewed") {
    if (!["product", "desktop-demo", "cloud-footer"].includes(String(source.section))) return null;
    properties.section = source.section;
  }
  if (event.event === "$snapshot") {
    for (const key of ["$snapshot_data", "$snapshot_bytes", "$snapshot_encoded"])
      if (source[key] !== undefined) properties[key] = source[key];
    if (Array.isArray(source.$snapshot_data))
      properties.$snapshot_data = source.$snapshot_data.map((snapshot) =>
        snapshot?.type === 4 && snapshot.data
          ? { ...snapshot, data: { ...snapshot.data, href: safe } }
          : snapshot,
      );
  }
  if (event.event === "$exception") {
    // Retain only shipped code locations. Error messages and local/extension URLs are private.
    const exceptions = Array.isArray(source.$exception_list) ? source.$exception_list : [];
    const frames = exceptions
      .flatMap((error) => error?.stacktrace?.frames ?? [])
      .flatMap((frame) => {
        try {
          const url = new URL(frame.filename);
          if (
            url.origin === new URL(page).origin &&
            /^\/_next\/static\/[\w/.[\]%()-]+\.m?js$/.test(url.pathname) &&
            Number.isSafeInteger(frame.lineno) &&
            Number.isSafeInteger(frame.colno)
          )
            return [
              {
                filename: `${url.origin}${url.pathname}`,
                function: "<redacted>",
                lineno: frame.lineno,
                colno: frame.colno,
                platform: "web:javascript",
                in_app: true,
              },
            ];
        } catch {}
        return [];
      })
      .slice(-40);
    if (!frames.length) return null;
    properties.$exception_list = [
      { type: "Error", value: "Website error", stacktrace: { frames } },
    ];
  }
  return { ...event, properties };
}
