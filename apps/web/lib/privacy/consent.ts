export const CONSENT_COOKIE = "tidy_consent";
// Fresh consent is required for the recorded, account-linked restart scope.
export const CONSENT_VERSION = 4;
export const CONSENT_NOTICE_VERSION = "2026-10-15.analytics-1";
export const CONSENT_DAYS = 180;
export const CONSENT_EVENT = "tidy-consent-change";
export const CONSENT_MAX_AGE = CONSENT_DAYS * 24 * 60 * 60;
export type ConsentPurpose = "analytics" | "replay" | "diagnostics";
export type ConsentChoices = Record<ConsentPurpose, boolean>;
export type Consent = ConsentChoices & { version: number; at: number };
export const ESSENTIAL_ONLY: ConsentChoices = {
  analytics: false,
  replay: false,
  diagnostics: false,
};

// This parser is shared by the browser and every server collection boundary.
export function readConsent(cookie: string | null | undefined, now = Date.now()): Consent | null {
  const matches = cookie
    ?.split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${CONSENT_COOKIE}=`));
  if (matches?.length !== 1 || matches[0].length > 512) return null;
  try {
    const value = JSON.parse(decodeURIComponent(matches[0].slice(CONSENT_COOKIE.length + 1)));
    if (
      !value ||
      value.version !== CONSENT_VERSION ||
      !Number.isSafeInteger(value.at) ||
      value.at > now ||
      now - value.at >= CONSENT_MAX_AGE * 1000
    )
      return null;
    if (
      [value.analytics, value.replay, value.diagnostics].some(
        (choice) => typeof choice !== "boolean",
      )
    )
      return null;
    return {
      version: CONSENT_VERSION,
      at: value.at,
      analytics: value.analytics,
      replay: value.replay,
      diagnostics: value.diagnostics,
    };
  } catch {
    return null;
  }
}

export function consentCookie(choices: ConsentChoices, now = Date.now(), secure = true) {
  const value: Consent = { version: CONSENT_VERSION, at: now, ...choices };
  return `${CONSENT_COOKIE}=${encodeURIComponent(JSON.stringify(value))}; Path=/; Max-Age=${CONSENT_MAX_AGE}; SameSite=Lax${secure ? "; Secure" : ""}`;
}

let failedWrite = false;
export function browserConsent(): Consent | null {
  if (typeof document === "undefined" || failedWrite) return null;
  try {
    return readConsent(document.cookie);
  } catch {
    return null;
  }
}

export function chooseConsent(choices: ConsentChoices): boolean {
  failedWrite = false;
  const now = Date.now();
  try {
    document.cookie = consentCookie(choices, now, location.protocol === "https:");
    const saved = readConsent(document.cookie);
    failedWrite =
      !saved ||
      saved.at !== now ||
      saved.analytics !== choices.analytics ||
      saved.replay !== choices.replay ||
      saved.diagnostics !== choices.diagnostics;
  } catch {
    failedWrite = true;
  }
  // Dispatch synchronously: stop capture before the next user interaction.
  window.dispatchEvent(new Event(CONSENT_EVENT));
  try {
    localStorage.setItem(CONSENT_COOKIE, String(now));
  } catch {
    /* Cookie and focus checks still work. */
  }
  return !failedWrite;
}

export function subscribeConsent(listener: () => void) {
  const storage = (event: StorageEvent) => {
    if (event.key === CONSENT_COOKIE || event.key === null) {
      failedWrite = false;
      listener();
    }
  };
  window.addEventListener(CONSENT_EVENT, listener);
  window.addEventListener("storage", storage);
  window.addEventListener("focus", listener);
  document.addEventListener("visibilitychange", listener);
  return () => {
    window.removeEventListener(CONSENT_EVENT, listener);
    window.removeEventListener("storage", storage);
    window.removeEventListener("focus", listener);
    document.removeEventListener("visibilitychange", listener);
  };
}

export function hasOptionalConsent(consent: ConsentChoices | null) {
  return Boolean(consent && (consent.analytics || consent.replay || consent.diagnostics));
}

export function consentRevision(consent: Consent) {
  return `${consent.version}:${consent.at}:${Number(consent.analytics)}${Number(consent.replay)}${Number(consent.diagnostics)}`;
}
