export function authReturnPath(value: string | string[] | undefined, fallback: string) {
  return typeof value === "string" &&
    (value === "/" ||
      value === "/onboarding/organization" ||
      /^\/api\/feedback\/attachments\/[0-9a-f-]{36}\/[0-2]$/.test(value) ||
      /^\/accept-invitation\/[a-zA-Z0-9_-]+$/.test(value) ||
      /^\/mcp\/consent\?[^\r\n#]*$/.test(value))
    ? value
    : fallback;
}

export function verificationCallbackPath(next: string) {
  return `/verify-email?next=${encodeURIComponent(authReturnPath(next, "/"))}`;
}

export function socialSignInError(error: unknown) {
  if (typeof error !== "string" || !error) return "";
  if (error === "email_not_verified")
    return "Verify your email with your sign-in provider before continuing.";
  if (["account_not_linked", "email_not_verified_local"].includes(error))
    return "Verify your Tidy email using its inbox link, then try this sign-in provider again.";
  return "Unable to complete sign-in. Try again or use your email and password.";
}
