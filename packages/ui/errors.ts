/** Deliberate UI copy. Keep caught errors in cause, never in the display text. */
export class UserFacingError extends Error {
  constructor(
    readonly displayMessage: string,
    options?: ErrorOptions,
  ) {
    super(displayMessage, options);
    this.name = "UserFacingError";
  }
}

export function isCancellation(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

/** Presentation never mutates or replaces the diagnostic object. */
export function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof UserFacingError)
    return error.displayMessage.trim() ? error.displayMessage : fallback;
  const authMessages: Record<string, string> = {
    INVALID_EMAIL_OR_PASSWORD: "Check your email and password and try again.",
    INVALID_PASSWORD: "The current password is incorrect.",
    USER_ALREADY_EXISTS: "An account with this email already exists. Sign in instead.",
    EMAIL_NOT_VERIFIED: "Verify your email before signing in.",
    PASSWORD_TOO_SHORT: "Use a password with at least 8 characters.",
    INVALID_TOKEN: "This link is invalid or expired. Request a new one.",
  };
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string" &&
    Object.hasOwn(authMessages, error.code)
  )
    return authMessages[error.code] ?? fallback;
  if (error instanceof Error) {
    if (
      [
        "Failed to fetch",
        "Load failed",
        "NetworkError when attempting to fetch resource.",
      ].includes(error.message)
    )
      return "Could not connect to Tidy. Check your connection and try again.";
    if (error.name === "TimeoutError") return "This is taking too long. Please try again.";
    if (error.name === "QuotaExceededError")
      return "Your device is out of storage. Free some space and try again.";
  }
  return fallback;
}

/** Use the original value for capture, including non-Error rejections. */
export function diagnosticError(error: unknown): unknown {
  const visited = new Set<unknown>();
  while (error instanceof UserFacingError && Object.hasOwn(error, "cause") && !visited.has(error)) {
    visited.add(error);
    error = error.cause;
  }
  return error;
}

export function handleError(
  error: unknown,
  {
    fallback,
    report,
    notify,
  }: { fallback: string; report: (error: unknown) => void; notify: (message: string) => void },
): string {
  if (isCancellation(error)) return "";
  const original = diagnosticError(error);
  if (isCancellation(original)) return "";
  // Expected validation has no technical failure to report. Wrapped failures do.
  if (!(error instanceof UserFacingError) || Object.hasOwn(error, "cause")) {
    try {
      report(original);
    } catch {
      /* Diagnostics must never prevent feedback. */
    }
  }
  const message = errorMessage(error, fallback);
  notify(message);
  return message;
}
