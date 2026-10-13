import type { PostHog } from "posthog-js";

// Keep existing call sites inert without loading the SDK, buffering events,
// reading analytics storage or transmitting identities. Re-enabling collection
// requires replacing this facade with a reviewed consent-aware implementation.
const posthog: Pick<PostHog, "capture" | "captureException" | "identify" | "reset"> = {
  capture: () => undefined,
  captureException: () => undefined,
  identify: () => {},
  reset: () => {},
};

export default posthog;
