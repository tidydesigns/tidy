import { verifyOAuthQueryParams } from "@better-auth/oauth-provider";

// Matches the canonical signed query format used by the installed Better Auth OAuth provider.
export async function verifyConsentQuery(query: URLSearchParams, secret: string) {
  const signatures = query.getAll("sig");
  if (signatures.length !== 1 || !signatures[0] || query.getAll("exp").length !== 1) return false;
  return verifyOAuthQueryParams(query.toString(), secret);
}
