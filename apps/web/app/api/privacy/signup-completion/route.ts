import { auth } from "@/lib/auth";
import { authorizeTelemetry } from "@/lib/privacy/consent-store";
import { claimSignupCompletion } from "@/lib/privacy/signup-completion";

export async function POST(request: Request) {
  return claimSignupCompletion(request, {
    authorizeTelemetry,
    sessionUserId: async (current) => {
      const session = await auth.api.getSession({
        headers: current.headers,
        query: { disableCookieCache: true },
      });
      return session?.user.id ?? null;
    },
  });
}
