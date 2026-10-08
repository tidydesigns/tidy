import { authClient, identifyPostHogUser } from "@/lib/auth-client";
import posthog from "posthog-js";

const key = process.env.NEXT_PUBLIC_POSTHOG_KEY;
const host = process.env.NEXT_PUBLIC_POSTHOG_HOST;

if (!key || !host) {
  if (process.env.NODE_ENV !== "production") {
    const variable = key ? "NEXT_PUBLIC_POSTHOG_HOST" : "NEXT_PUBLIC_POSTHOG_KEY";
    throw new Error(
      `${variable} variable required by PostHog is missing or un-configured, this causes events to be silently missed. This error stops appearing once ${variable} is configured`,
    );
  }
} else {
  posthog.init(key, {
    api_host: host,
    capture_pageview: "history_change",
    capture_performance: {
      web_vitals: true,
      web_vitals_allowed_metrics: ["LCP", "INP", "CLS", "FCP"],
      web_vitals_attribution: false,
    },
    disable_session_recording: window.location.hostname !== "app.tidydesign.co",
    session_recording: {
      maskAllInputs: true,
    },
    capture_exceptions: {
      capture_unhandled_errors: true,
      capture_unhandled_rejections: true,
      capture_console_errors: false,
    },
  });

  posthog.register({ $app_version: process.env.NEXT_PUBLIC_APP_VERSION });

  void authClient
    .getSession()
    .then((result) => {
      if (result.data?.user) identifyPostHogUser(result.data.user);
    })
    .catch(() => {
      /* Analytics identification must not break the application. */
    });
}
