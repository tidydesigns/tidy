import "server-only";
import { google } from "better-auth/social-providers";
import { verifyProviderIdToken } from "@better-auth/core/oauth2";

function googleConfiguration(clientId: string, clientSecret: string) {
  const provider = google({ clientId, clientSecret });
  return {
    clientId,
    clientSecret,
    // The authorization-code adapter decodes the profile without verifying
    // its ID token. Use Better Auth's verifier before admitting those claims.
    getUserInfo: async (tokens: Parameters<typeof provider.getUserInfo>[0]) => {
      if (
        !tokens.idToken ||
        !(await verifyProviderIdToken(provider, tokens.idToken, tokens.expectedIdTokenNonce))
      )
        return null;
      return provider.getUserInfo(tokens);
    },
  };
}

// Sign-in credentials are separate from the GitHub repository connector.
export function socialProviderConfiguration() {
  const googleId = process.env.GOOGLE_CLIENT_ID?.trim();
  const googleSecret = process.env.GOOGLE_CLIENT_SECRET?.trim();
  const githubId = process.env.AUTH_GITHUB_CLIENT_ID?.trim();
  const githubSecret = process.env.AUTH_GITHUB_CLIENT_SECRET?.trim();
  return {
    ...(googleId && googleSecret ? { google: googleConfiguration(googleId, googleSecret) } : {}),
    ...(githubId && githubSecret
      ? { github: { clientId: githubId, clientSecret: githubSecret } }
      : {}),
  };
}

export function enabledSocialProviders(): ("google" | "github")[] {
  const providers = socialProviderConfiguration();
  return [
    ...(providers.google ? ["google" as const] : []),
    ...(providers.github ? ["github" as const] : []),
  ];
}
