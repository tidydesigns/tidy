const staticSegments = new Set([
  "api",
  "auth",
  "get-session",
  "login",
  "sign-up",
  "files",
  "health",
  "snapshot",
  "changes",
  "assets",
  "comments",
  "reactions",
  "versions",
  "presence-ticket",
  "live",
  "mcp",
  "vault",
  "settings",
  "github",
  "reviews",
  "captures",
  "feedback",
  "billing",
  "webhook",
  "organization",
  "onboarding",
  "team",
  "forgot-password",
  "reset-password",
  "sign-in",
  "email",
  "sign-out",
  "oauth2",
  "authorize",
  "token",
  "register",
  "consent",
  "jwks",
  "revoke",
  "introspect",
  ".well-known",
  "oauth-protected-resource",
  "oauth-authorization-server",
  "openid-configuration",
]);

export function normalizedRoute(url: string) {
  // Never log query strings, arbitrary user paths, file IDs, tickets, or tokens.
  return new URL(url).pathname
    .split("/")
    .map((part) => (!part || staticSegments.has(part) ? part : ":id"))
    .join("/");
}
