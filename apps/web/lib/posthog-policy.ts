import { readConsent, type ConsentPurpose } from "./privacy/consent";

// A new release switch is deliberate: old credentials/preferences cannot lift
// the previous pause. Enable only after the notice/processor rollout is reviewed.
export function posthogCollectionEnabled(
  cookie?: string | null,
  purpose: ConsentPurpose = "diagnostics",
): boolean {
  return process.env.NEXT_PUBLIC_POSTHOG_ENABLED === "1" && readConsent(cookie)?.[purpose] === true;
}

// Core server fault reporting has no browser cookie/consent dependency.
// Explicit runtime values (including "0") override the environment fallback.
export function posthogServerErrorsEnabled(runtimeValue?: string): boolean {
  return (runtimeValue ?? process.env.POSTHOG_SERVER_ERRORS_ENABLED) === "1";
}
