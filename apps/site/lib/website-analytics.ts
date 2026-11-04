import type { PostHog } from "posthog-js";
import { clearAnalyticsStorage } from "@tidy/ui/analytics-storage";
import { ATTRIBUTION_FRAGMENT } from "@tidy/ui/website-attribution";
import {
  browserConsent,
  chooseConsent,
  consentRevision,
  CONSENT_EVENT,
  CONSENT_MAX_AGE,
  ESSENTIAL_ONLY,
  hasOptionalConsent,
  subscribeConsent,
} from "@tidy/ui/privacy-consent";
import { acquisitionProperties, redactWebsiteEvent, websiteUrl } from "./analytics-policy";

export const ANALYTICS_STATUS = "tidy-website-analytics-status";
let started = false;
let client: PostHog | undefined;
let generation = 0;
let choice = "";
let initialization = Promise.resolve();
let expiry: ReturnType<typeof setTimeout> | undefined;
let retry: ReturnType<typeof setTimeout> | undefined;
let delivery: Promise<unknown> = Promise.resolve();
let withdrawal: Promise<unknown> | undefined;
const links = new Map<HTMLAnchorElement, string>();
let visitor: string | undefined;
let status: "ready" | "pending" | "failed" = "ready";
let lastPageview = "";
let lastRecovery = 0;
const acquisitionKey = "tidy-website-acquisition";

function websiteAcquisition() {
  let properties = acquisitionProperties(location.href, document.referrer);
  try {
    const previous = JSON.parse(sessionStorage.getItem(acquisitionKey) || "null");
    if (
      previous &&
      Number.isSafeInteger(previous.at) &&
      previous.at <= Date.now() &&
      Date.now() - previous.at < 30 * 60_000
    ) {
      const params = new URLSearchParams();
      for (const key of ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term"])
        if (typeof previous.properties?.[key] === "string")
          params.set(key, previous.properties[key]);
      properties = {
        ...acquisitionProperties(
          `${location.origin}/?${params}`,
          previous.properties?.$referrer ?? "",
        ),
        ...properties,
      };
    }
    sessionStorage.setItem(acquisitionKey, JSON.stringify({ at: Date.now(), properties }));
  } catch {}
  return properties;
}

export function websiteCollectionEnabled() {
  return (
    process.env.NEXT_PUBLIC_POSTHOG_ENABLED === "1" &&
    Boolean(process.env.NEXT_PUBLIC_POSTHOG_KEY && process.env.NEXT_PUBLIC_POSTHOG_HOST)
  );
}

export function websiteAnalyticsStatus() {
  return status;
}
function setStatus(next: typeof status) {
  status = next;
  window.dispatchEvent(new Event(ANALYTICS_STATUS));
}

function stop() {
  const previous = client;
  client = undefined;
  visitor = undefined;
  for (const [link, href] of links) if (link.isConnected) link.href = href;
  links.clear();
  if (previous) {
    for (const action of [
      () => previous.set_config({ disable_persistence: true }),
      () => previous.opt_out_capturing(),
      () => previous.stopSessionRecording(),
      () => {
        void previous.shutdown().catch(() => {});
      },
    ])
      try {
        action();
      } catch {}
  }
  clearAnalyticsStorage();
}

export function linkWebsiteVisit() {
  if (!visitor || !browserConsent()?.analytics) return;
  const origin = new URL(process.env.NEXT_PUBLIC_APP_URL || "https://app.tidydesign.co").origin;
  for (const link of links.keys()) if (!link.isConnected) links.delete(link);
  for (const link of document.querySelectorAll<HTMLAnchorElement>("a[href]")) {
    const url = new URL(links.get(link) ?? link.href);
    if (url.origin !== origin || !["/login", "/sign-up"].includes(url.pathname) || url.hash)
      continue;
    links.set(link, url.href);
    url.hash = `${ATTRIBUTION_FRAGMENT}=${visitor}`;
    link.href = url.href;
  }
}

async function initialize() {
  const consent = browserConsent();
  const next = JSON.stringify(consent);
  if (next === choice) return;
  choice = next;
  const current = ++generation;
  const afterWithdrawal = Boolean(withdrawal);
  clearTimeout(expiry);
  clearTimeout(retry);
  stop();
  if (!consent?.analytics) {
    lastPageview = "";
    try {
      sessionStorage.removeItem(acquisitionKey);
    } catch {}
  }
  if (!consent || !websiteCollectionEnabled()) {
    setStatus("ready");
    return;
  }
  expiry = setTimeout(
    () => {
      choice = "";
      void refreshWebsiteConsent();
      window.dispatchEvent(new Event(CONSENT_EVENT));
    },
    Math.min(2147483647, Math.max(1, consent.at + CONSENT_MAX_AGE * 1000 - Date.now())),
  );
  setStatus("pending");
  try {
    // Serialize first receipt creation and later changes, including rejections.
    // A superseded callback cannot initialize a recorder or replace current UI.
    const task = delivery
      .catch(() => {})
      .then(async () => {
        if (current !== generation) return;
        // A revoke-only HTTP response can replace the projection cookie. Keep a
        // newer explicit choice made while that response was in flight.
        if (afterWithdrawal && JSON.stringify(browserConsent()) !== next) {
          chooseConsent(consent);
          return;
        }
        const send = async () => {
          if (current !== generation || JSON.stringify(browserConsent()) !== next) return;
          return fetch("/api/privacy/consent", {
            method: "POST",
            credentials: "same-origin",
            cache: "no-store",
            keepalive: true,
            headers: { "x-tidy-privacy": "1" },
            signal: AbortSignal.timeout(10_000),
          });
        };
        const response =
          typeof navigator !== "undefined" && navigator.locks
            ? await navigator.locks.request("tidy-privacy-receipt", send)
            : await send();
        if (!response) return;
        if (!response.ok) throw new Error("Consent receipt unavailable");
        return response.json() as Promise<{ id: string; browserId: string }>;
      });
    delivery = task;
    const receipt = await task;
    if (current !== generation || !receipt) return;
    if (!/^[a-f0-9-]{36}$/.test(receipt.id) || !/^[a-f0-9-]{36}$/.test(receipt.browserId))
      throw new Error("Invalid consent receipt");
    if (!hasOptionalConsent(consent)) {
      setStatus("ready");
      return;
    }
    const acquisition = consent.analytics ? websiteAcquisition() : {};
    const { PostHog: Client } = await import("posthog-js/full/no-external");
    if (current !== generation || JSON.stringify(browserConsent()) !== next) return;
    const sdk = new Client();
    client = sdk;
    sdk.init(process.env.NEXT_PUBLIC_POSTHOG_KEY!, {
      defaults: "2026-08-30",
      // Development uses tidy-dev/local fixtures, including automated browsers.
      opt_out_useragent_filter: process.env.NODE_ENV === "development",
      internal_or_test_user_hostname: null,
      api_host: `${location.origin}/api/t`,
      ui_host: process.env.NEXT_PUBLIC_POSTHOG_HOST?.includes("us.i.")
        ? "https://us.posthog.com"
        : "https://eu.posthog.com",
      request_headers: { "x-tidy-consent": consentRevision(consent), "x-tidy-receipt": receipt.id },
      bootstrap: { distinctID: receipt.browserId, isIdentifiedID: false },
      persistence: "cookie",
      cookie_expiration: 180,
      cross_subdomain_cookie: false,
      person_profiles: "never",
      ip: false,
      save_referrer: false,
      save_campaign_params: false,
      mask_personal_data_properties: true,
      disable_capture_url_hashes: true,
      autocapture: consent.analytics ? { capture_copied_text: false } : false,
      mask_all_text: true,
      mask_all_element_attributes: true,
      capture_pageview: consent.analytics ? "history_change" : false,
      capture_pageleave: consent.analytics,
      rageclick: consent.analytics,
      capture_dead_clicks: false,
      capture_heatmaps: false,
      disable_session_recording: !consent.replay,
      enable_recording_console_log: false,
      session_recording: {
        sampleRate: 0.2,
        maskAllInputs: true,
        maskTextSelector: "*",
        maskTextFn: (text, element) =>
          element?.closest(
            ".ph-no-capture, [data-ph-private], input, textarea, select, [contenteditable]",
          )
            ? "[hidden]"
            : text,
        maskAllElementAttributes: false,
        maskAttributeFn: (name, value) => {
          if (name === "class" || (name === "data-theme" && ["light", "dark"].includes(value)))
            return value;
          if (name === "style") return value.replace(/url\([^)]*\)/gi, "none");
          if (/^(width|height|colspan|rowspan)$/.test(name) && /^\d{1,5}$/.test(value))
            return value;
          return "";
        },
        blockSelector:
          ".ph-no-capture, [data-ph-private], input, textarea, select, [contenteditable], iframe, canvas, img, picture, svg, video, audio, object, embed, script, link:not([rel='stylesheet'])",
        captureCanvas: { recordCanvas: false },
        recordCrossOriginIframes: false,
        captureJsonLd: false,
        collectFonts: false,
        recordHeaders: false,
        recordBody: false,
        maskCapturedNetworkRequestFn: (request) =>
          request.method
            ? null
            : {
                name: websiteUrl(request.name),
                startTime: 0,
                duration: 0,
                entryType: "navigation",
              },
      },
      capture_performance: consent.diagnostics
        ? {
            web_vitals: true,
            web_vitals_allowed_metrics: ["LCP", "INP", "CLS", "FCP"],
            web_vitals_attribution: false,
            network_timing: false,
          }
        : false,
      capture_exceptions: consent.diagnostics
        ? {
            capture_unhandled_errors: true,
            capture_unhandled_rejections: true,
            capture_console_errors: false,
          }
        : false,
      logs: { captureConsoleLogs: false, beforeSend: () => null },
      disable_surveys: true,
      disable_surveys_automatic_display: true,
      advanced_disable_feature_flags: true,
      disable_conversations: true,
      disable_product_tours: true,
      disable_web_experiments: true,
      disable_external_dependency_loading: true,
      opt_in_site_apps: false,
      request_batching: false,
      on_request_error: (response) => {
        if (
          current !== generation ||
          response.statusCode !== 403 ||
          Date.now() - lastRecovery < 10_000
        )
          return;
        lastRecovery = Date.now();
        ++generation;
        stop();
        clearTimeout(retry);
        retry = setTimeout(() => {
          choice = "";
          void refreshWebsiteConsent();
        }, 1000);
      },
      api_transport: "fetch",
      disable_beacon: true,
      get_current_url: websiteUrl,
      before_send: (event) => {
        if (event?.event === "$pageview" && lastPageview === websiteUrl(location.href)) return null;
        const result =
          current === generation && event
            ? redactWebsiteEvent(
                {
                  ...event,
                  properties: {
                    ...event.properties,
                    tidy_consent_receipt: receipt.id,
                    website_visitor_id: receipt.browserId,
                  },
                },
                browserConsent() ?? ESSENTIAL_ONLY,
                location.href,
                acquisition,
              )
            : null;
        if (result?.event === "$pageview") lastPageview = websiteUrl(location.href);
        return result;
      },
    });
    visitor = consent.analytics ? receipt.browserId : undefined;
    linkWebsiteVisit();
    setStatus("ready");
  } catch {
    if (current !== generation) return;
    setStatus("failed");
    retry = setTimeout(() => {
      choice = "";
      void refreshWebsiteConsent();
    }, 10_000);
  }
}

export function refreshWebsiteConsent() {
  initialization = initialize();
  return initialization;
}

export function retryWebsiteConsent() {
  choice = "";
  return refreshWebsiteConsent();
}

export async function withdrawWebsiteConsent() {
  const current = generation;
  const task = delivery
    .catch(() => {})
    .then(async () => {
      if (current !== generation || !websiteCollectionEnabled()) return;
      try {
        const response = await fetch("/api/privacy/consent", {
          method: "POST",
          credentials: "same-origin",
          cache: "no-store",
          keepalive: true,
          headers: { "x-tidy-privacy": "1", "content-type": "application/json" },
          body: JSON.stringify({ revoke: true }),
          signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok) throw new Error("Withdrawal receipt unavailable");
      } catch {
        if (current === generation) setStatus("failed");
      }
    });
  delivery = task;
  withdrawal = task;
  void task.finally(() => {
    if (withdrawal === task) withdrawal = undefined;
  });
  await task;
}

export function captureWebsite(event: string, properties: Record<string, string>) {
  if (!browserConsent()?.analytics || !client) return;
  try {
    client.capture(event, properties);
  } catch {}
}

export function observeWebsiteSections() {
  if (!browserConsent()?.analytics || !client) return () => {};
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries)
        if (entry.isIntersecting) {
          captureWebsite("website_section_viewed", { section: entry.target.id });
          observer.unobserve(entry.target);
        }
    },
    // Tall sections may never fit 25% of their area in a short viewport.
    { threshold: 0, rootMargin: "0px 0px -20% 0px" },
  );
  for (const section of document.querySelectorAll("#product, #desktop-demo, #cloud-footer"))
    observer.observe(section);
  return () => observer.disconnect();
}

export function startWebsiteAnalytics() {
  if (started || typeof window === "undefined") return;
  started = true;
  subscribeConsent(() => {
    void refreshWebsiteConsent();
  });
  const click = (event: MouseEvent) => {
    if ((event.type === "auxclick" && event.button !== 1) || !(event.target instanceof Element))
      return;
    const link = event.target.closest<HTMLAnchorElement>("a[href]");
    if (!link || link.closest(".ph-no-capture")) return;
    const url = new URL(link.href);
    const app = new URL(process.env.NEXT_PUBLIC_APP_URL || "https://app.tidydesign.co");
    const action =
      url.pathname === "/download/mac" || link.dataset.analyticsAction === "download_mac"
        ? "download_mac"
        : url.origin === app.origin
          ? url.pathname === "/sign-up"
            ? "signup"
            : "open_tidy"
          : url.hostname === "github.com"
            ? url.hash === "#local-development"
              ? "documentation"
              : "github"
            : "navigation";
    const placement = link.closest("header")
      ? "header"
      : link.closest("footer")
        ? "footer"
        : link.closest("[data-analytics-placement='hero']")
          ? "hero"
          : "content";
    captureWebsite("website_cta_clicked", { action, placement });
  };
  document.addEventListener("click", click);
  document.addEventListener("auxclick", click);
  void refreshWebsiteConsent();
}
