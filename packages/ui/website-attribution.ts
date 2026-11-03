// This joins consented website and signup events. It never authenticates a
// visitor, merges person profiles, or grants permission for app analytics.
export const ATTRIBUTION_FRAGMENT = "tidy_website";
const storageKey = "tidy-website-attribution";
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
let incoming: string | undefined;
let receivedAt = 0;
const lifetime = 30 * 60_000;

export function readWebsiteAttribution() {
  if (typeof location === "undefined") return;
  const match = new RegExp(`^#${ATTRIBUTION_FRAGMENT}=([^&]+)$`).exec(location.hash);
  if (!match) return;
  if (uuid.test(match[1])) {
    incoming = match[1];
    receivedAt = Date.now();
  }
  // Fragments do not reach the server. Remove this one before replay or links
  // can copy it; other application fragments are left intact.
  history.replaceState(history.state, "", `${location.pathname}${location.search}`);
}

export function websiteAttribution(analyticsAllowed: boolean) {
  if (!analyticsAllowed) return undefined;
  if (incoming && Date.now() - receivedAt >= lifetime) {
    clearWebsiteAttribution();
    return;
  }
  if (incoming) {
    try {
      sessionStorage.setItem(storageKey, JSON.stringify({ id: incoming, at: receivedAt }));
    } catch {}
    return incoming;
  }
  try {
    const stored = JSON.parse(sessionStorage.getItem(storageKey) || "null");
    if (
      stored &&
      typeof stored.id === "string" &&
      uuid.test(stored.id) &&
      Number.isSafeInteger(stored.at) &&
      stored.at <= Date.now() &&
      Date.now() - stored.at < lifetime
    ) {
      incoming = stored.id;
      receivedAt = stored.at;
    }
    return incoming;
  } catch {
    return undefined;
  }
}

export function clearWebsiteAttribution() {
  incoming = undefined;
  receivedAt = 0;
  try {
    sessionStorage.removeItem(storageKey);
  } catch {}
}
