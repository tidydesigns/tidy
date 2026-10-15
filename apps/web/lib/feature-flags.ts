import type { PostHog } from "posthog-js";
import { browserConsent } from "./privacy/consent";

export type FeatureFlag = "mcp-pi-gemini" | "github-connector" | "settings-connectors";

let flags: Record<string, boolean | string> = {};
let valid = () => false;
let binding = 0;
let unsubscribe: (() => void) | undefined;
const listeners = new Set<() => void>();

function notify() {
  for (const listener of listeners) listener();
}

export function featureFlagEnabled(flag: FeatureFlag): boolean {
  return browserConsent()?.analytics === true && valid() && flags[flag] === true;
}

export function subscribeFeatureFlags(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function clearFeatureFlags() {
  binding++;
  valid = () => false;
  flags = {};
  const previous = unsubscribe;
  unsubscribe = undefined;
  try {
    previous?.();
  } catch {
    // Optional SDK cleanup cannot preserve access to a hidden feature.
  }
  notify();
}

/** Use only the consent-aware SDK; never restore flags from another session. */
export function bindFeatureFlags(sdk: PostHog, isCurrent: () => boolean) {
  clearFeatureFlags();
  const generation = binding;
  valid = isCurrent;
  const stopReload = sdk.on("featureFlagsReloading", () => {
    if (generation !== binding) return;
    flags = {};
    notify();
  });
  const stopFlags = sdk.onFeatureFlags((_keys, variants, context) => {
    if (generation !== binding || !isCurrent()) return;
    // A failed refresh may include cached enabled values: discard those too.
    flags = context?.errorsLoading ? {} : { ...variants };
    notify();
  });
  unsubscribe = () => {
    stopReload();
    stopFlags();
  };
}
