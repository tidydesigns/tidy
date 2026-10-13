import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { createAuthMiddleware } from "better-auth/api";
import { getCurrentAuthEndpointContext } from "@better-auth/core/context";
import { handleAuthRequest } from "../../lib/auth/request-boundary";
import { traceAuthOperation } from "../../lib/auth/request-lifecycle";

const records = { user: [], session: [], account: [], verification: [] };

function createAuth() {
  return betterAuth({
    baseURL: "https://auth.test",
    secret: "disposable-worker-auth-context-secret-at-least-32-characters",
    database: memoryAdapter(records),
    advanced: { database: { validateSchema: false } },
    emailAndPassword: { enabled: true, requireEmailVerification: true },
    socialProviders: {
      github: { clientId: "fixture-client", clientSecret: "fixture-secret" },
      google: { clientId: "fixture-google-client", clientSecret: "fixture-google-secret" },
    },
    hooks: {
      before: createAuthMiddleware(async () => {
        const context = getCurrentAuthEndpointContext();
        await new Promise((resolve) => setTimeout(resolve, 5));
        if (getCurrentAuthEndpointContext() !== context)
          throw new Error("Concurrent authentication requests shared endpoint context.");
      }),
    },
  });
}

export default {
  fetch(request: Request) {
    // Match the app's request-scoped auth instances. Rebuilding an instance
    // cannot repair a pending import cached by the dependency's module.
    return handleAuthRequest(
      request,
      async (bounded) => {
        const auth = createAuth();
        const context = await traceAuthOperation("auth_initialization", () => auth.$context);
        // Only synthetic in-memory fixtures can use this verification helper.
        if (new URL(bounded.url).pathname === "/verify-fixture") {
          const account = await context.internalAdapter.findUserByEmail("password@example.test");
          if (!account) throw new Error("Expected synthetic password account.");
          await context.internalAdapter.updateUser(account.user.id, { emailVerified: true });
          return new Response(null, { status: 204 });
        }
        if (new URL(bounded.url).pathname === "/direct-session")
          return Response.json(
            await traceAuthOperation("auth_api", () =>
              auth.api.getSession({ headers: bounded.headers }),
            ),
          );
        return traceAuthOperation("auth_endpoint", () => auth.handler(bounded));
      },
      1000,
    );
  },
};
