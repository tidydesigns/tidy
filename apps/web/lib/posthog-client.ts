import type { PostHog, PostHogConfig } from "posthog-js";
import {
  browserConsent,
  consentRevision,
  CONSENT_MAX_AGE,
  ESSENTIAL_ONLY,
  hasOptionalConsent,
  subscribeConsent,
  type Consent,
} from "./privacy/consent";
import { clearAnalyticsStorage } from "./privacy/browser-storage";
import { invalidateConsentReceipt, recordBrowserConsent } from "./privacy/receipt-client";
import { replayAttribute, replayText } from "./privacy/replay";
import type { AppErrorOperation } from "./privacy/error-diagnostics";
import {
  redactTelemetry,
  safeTelemetryUrl,
  telemetryAccount,
  type TelemetryAccount,
} from "./privacy/telemetry";

let client: PostHog | undefined;
let revision = 0;
let activeChoice = "";
let started = false;
let expiry: ReturnType<typeof setTimeout> | undefined;
let account: TelemetryAccount | undefined;
let retry: ReturnType<typeof setTimeout> | undefined;
let initialization = Promise.resolve();
let pendingCaptures = 0;
const AUTH_EVENT = "tidy-telemetry-auth-change";

export function browserCollectionEnabled() {
  return (
    process.env.NEXT_PUBLIC_POSTHOG_ENABLED === "1" &&
    Boolean(process.env.NEXT_PUBLIC_POSTHOG_KEY && process.env.NEXT_PUBLIC_POSTHOG_HOST)
  );
}

function current(purpose: "analytics" | "replay" | "diagnostics") {
  return browserCollectionEnabled() && browserConsent()?.[purpose] === true;
}

export function consentConfig(consent: Consent): Partial<PostHogConfig> {
  const host = new URL(process.env.NEXT_PUBLIC_POSTHOG_HOST || "https://eu.i.posthog.com");
  return {
    api_host: `${location.origin}/api/t`,
    ui_host:
      host.hostname === "us.i.posthog.com" ? "https://us.posthog.com" : "https://eu.posthog.com",
    request_headers: { "x-tidy-consent": consentRevision(consent) },
    persistence: "cookie",
    cookie_expiration: 180,
    cross_subdomain_cookie: false,
    person_profiles: "identified_only",
    ip: false,
    save_referrer: false,
    save_campaign_params: false,
    mask_personal_data_properties: true,
    disable_capture_url_hashes: true,
    autocapture: consent.analytics ? { capture_copied_text: false } : false,
    mask_all_text: true,
    mask_all_element_attributes: true,
    rageclick: consent.analytics,
    capture_pageview: consent.analytics ? "history_change" : false,
    capture_pageleave: consent.analytics,
    capture_dead_clicks: false,
    capture_heatmaps: false,
    logs: { captureConsoleLogs: false, beforeSend: () => null },
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
    disable_session_recording: !consent.replay,
    enable_recording_console_log: false,
    session_recording: {
      maskAllInputs: true,
      maskTextSelector: "*",
      maskTextFn: replayText,
      maskAllElementAttributes: false,
      maskAttributeFn: replayAttribute,
      blockSelector:
        ".ph-no-capture, [data-node-id], [data-design-font], input, textarea, select, [contenteditable], canvas, svg:not([data-ph-public], [data-ph-public] svg), img, picture, video, audio, iframe, object, embed, script, link:not([rel='stylesheet'])",
      captureCanvas: { recordCanvas: false },
      recordCrossOriginIframes: false,
      captureJsonLd: false,
      collectFonts: false,
      inlineStylesheet: true,
      recordHeaders: false,
      recordBody: false,
      maskCapturedNetworkRequestFn: (request) =>
        request.method
          ? null
          : {
              name: safeTelemetryUrl(request.name),
              startTime: 0,
              duration: 0,
              entryType: "navigation",
            },
    },
    disable_surveys: !consent.analytics,
    disable_surveys_automatic_display: !consent.analytics,
    // Functional rollouts are evaluated on Tidy's server without browser identity.
    advanced_disable_feature_flags: true,
    disable_conversations: true,
    disable_product_tours: true,
    disable_web_experiments: true,
    disable_external_dependency_loading: true,
    opt_in_site_apps: false,
    request_batching: false,
    api_transport: "fetch",
    disable_beacon: true,

    get_current_url: safeTelemetryUrl,
    before_send: (event) =>
      event
        ? redactTelemetry(event, browserConsent() ?? ESSENTIAL_ONLY, location.href, account)
        : null,
  };
}

function stop(clearStorage = true) {
  const previous = client;
  client = undefined;
  if (previous) {
    // Async recorder/config callbacks must not recreate storage after withdrawal.
    for (const action of [
      () => previous.set_config({ disable_persistence: true }),
      () => previous.opt_out_capturing(),
      () => previous.stopSessionRecording(),
    ]) {
      try {
        action();
      } catch {
        /* A broken optional SDK must not prevent withdrawal. */
      }
    }
    // The same-origin transport rejects the old consent revision, including retries.
    try {
      void previous.shutdown().catch(() => {});
    } catch {
      /* Optional SDK cleanup. */
    }
  }
  if (clearStorage) clearAnalyticsStorage();
}

function scheduleExpiry(consent: Consent) {
  expiry = setTimeout(
    () => {
      const latest = browserConsent();
      if (latest && JSON.stringify(latest) === activeChoice) {
        scheduleExpiry(latest);
        return;
      }
      activeChoice = "";
      void refresh();
      window.dispatchEvent(new Event("tidy-consent-change"));
    },
    Math.min(2147483647, Math.max(1, consent.at + CONSENT_MAX_AGE * 1000 - Date.now())),
  );
}

function refresh() {
  if (JSON.stringify(browserConsent()) === activeChoice) return initialization;
  initialization = initializeClient();
  return initialization;
}

async function initializeClient() {
  const consent = browserConsent();
  const choice = JSON.stringify(consent);
  if (choice === activeChoice) return;
  activeChoice = choice;
  const generation = ++revision;
  clearTimeout(expiry);
  clearTimeout(retry);
  // Resolve identity afresh on SDK initialization; never inherit profile traits
  // from a previous account's persisted cookie on a new document.
  stop();
  if (consent) scheduleExpiry(consent);
  if (!consent) return;
  try {
    // Record rejections/withdrawals as well as grants, before starting any SDK.
    const receipt = await recordBrowserConsent();
    if (generation !== revision || JSON.stringify(browserConsent()) !== choice) return;
    if (!browserCollectionEnabled() || !hasOptionalConsent(consent)) return;
    account = telemetryAccount(receipt.user?.id, receipt.user?.email);
    // No SDK, remote config, anonymous cookie, event buffer or identity request before consent.
    const { PostHog: Client } = await import("posthog-js/full/no-external");
    if (generation !== revision || JSON.stringify(browserConsent()) !== choice) return;
    const instance = new Client();
    client = instance;
    instance.init(process.env.NEXT_PUBLIC_POSTHOG_KEY!, {
      ...consentConfig(consent),
      request_headers: { "x-tidy-consent": consentRevision(consent), "x-tidy-receipt": receipt.id },
      // Never reuse another account's persisted identity before session resolution.
      bootstrap: { distinctID: receipt.browserId, isIdentifiedID: false },
      before_send: (event) =>
        generation === revision && event
          ? redactTelemetry(
              { ...event, properties: { ...event.properties, tidy_consent_receipt: receipt.id } },
              browserConsent() ?? ESSENTIAL_ONLY,
              location.href,
              account,
            )
          : null,
      loaded: (sdk) => {
        if (generation === revision && account && hasOptionalConsent(browserConsent()))
          sdk.identify(account.id, { email: account.email });
      },
    });
    instance.register({
      $app_version: process.env.NEXT_PUBLIC_APP_VERSION,
      tidy_consent_receipt: receipt.id,
    });
  } catch {
    // Retry failed essential receipt delivery. Capture stays stopped in the meantime.
    if (generation === revision)
      retry = setTimeout(() => {
        activeChoice = "";
        void refresh();
      }, 5000);
  }
}

export function startPostHogConsent() {
  if (started || typeof window === "undefined") return;
  started = true;
  subscribeConsent(() => void refresh());
  // OAuth, another tab or session expiry can change authentication without the
  // password-login callback. Recheck on return before sending further events.
  window.addEventListener("focus", () => void checkSessionIdentity());
  window.addEventListener("storage", (event) => {
    if (event.key !== AUTH_EVENT) return;
    // No identifiers or email are put in localStorage. Other tabs resolve the
    // current auth session after stopping the previous account's collection.
    account = undefined;
    invalidateConsentReceipt();
    activeChoice = "";
    void refresh();
  });
  void refresh();
}

function checkSessionIdentity() {
  if (!client || !hasOptionalConsent(browserConsent())) return;
  // Stop synchronously and resolve a fresh server receipt. A cached successful
  // receipt must never restore an old identity after session revalidation fails.
  invalidateConsentReceipt();
  activeChoice = "";
  void refresh();
}

function notifyAuthChange() {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(AUTH_EVENT, crypto.randomUUID());
  } catch {
    /* Optional sync. */
  }
}

function afterInitialization(deliver: (sdk: PostHog) => unknown) {
  // Focus/session revalidation briefly stops the client. Do not lose a feedback
  // click or boundary error during that window, or carry it to another account.
  if (!started || !browserCollectionEnabled() || pendingCaptures >= 20) return;
  const generation = revision;
  const identity = account?.id;
  pendingCaptures++;
  void initialization
    .then(() => {
      pendingCaptures--;
      if (generation === revision && identity === account?.id && client) deliver(client);
    })
    .catch(() => {});
}

/** Bind an async operation's optional capture to its starting session and consent. */
export function captureForCurrentSession(): PostHog["capture"] {
  const generation = revision;
  const identity = account?.id;
  const choice = JSON.stringify(browserConsent());
  return (event, properties) => {
    if (
      generation !== revision ||
      identity !== account?.id ||
      choice !== JSON.stringify(browserConsent())
    )
      return;
    return posthog.capture(event, properties);
  };
}

const posthog: Pick<PostHog, "capture" | "captureException" | "identify" | "reset"> = {
  capture: (event, properties) => {
    if (!hasOptionalConsent(browserConsent())) return;
    if (client) return client.capture(event, properties);
    afterInitialization((sdk) => sdk.capture(event, properties));
  },
  captureException: (error, properties) => {
    if (!current("diagnostics")) return;
    if (client) return client.captureException(error, properties);
    afterInitialization((sdk) => sdk.captureException(error, properties));
  },
  identify: (id, properties) => {
    account = telemetryAccount(id, properties?.email);
    invalidateConsentReceipt();
    activeChoice = "";
    void refresh();
    notifyAuthChange();
  },
  reset: () => {
    account = undefined;
    invalidateConsentReceipt();
    activeChoice = "";
    void refresh();
    notifyAuthChange();
  },
};
/** Bind diagnostics before starting an async operation, so account/consent
 * changes cannot attribute its eventual failure to somebody else. */
export function appErrorReporter(operation: AppErrorOperation) {
  const generation = revision;
  const identity = account?.id;
  const choice = JSON.stringify(browserConsent());
  return (error: unknown) => {
    if (
      generation !== revision ||
      identity !== account?.id ||
      choice !== JSON.stringify(browserConsent()) ||
      (error instanceof Error && error.name === "AbortError")
    )
      return;
    posthog.captureException(error, { app_error_operation: operation });
  };
}

export default posthog;
