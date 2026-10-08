import {
  reservePersonalAttempts,
  PERSONAL_ATTEMPTS,
  PersonalBudgetError,
  type PersonalOperation,
} from "../../lib/security/personal-budget";
import { reserveLinearAttempts } from "../../lib/linear/attempt-budget";
import { reserveGitHubOAuthAttempts, GitHubOAuthBudgetError } from "../../lib/github/oauth-budget";
import {
  boundedLinearOperation,
  linearRequestSignal,
  consumeLinearBytes,
} from "../../lib/linear/work-budget";
import { ConnectorError } from "../../lib/connectors/error";
import { reserveFileManagement } from "../../lib/design/file-management-budget";
import { reserveClipboardTransfer } from "../../lib/design/clipboard-budget";
import { reserveImageOperation } from "../../lib/design/image-budget";
import { reserveClientRegistration } from "../../lib/auth/client-registration-budget";
import { reserveFeedbackUpload } from "../../lib/feedback/upload-budget";
import { APIError } from "better-auth/api";
import {
  reserveCommentMutation,
  reserveInvitationMutation,
  MutationBudgetError,
} from "../../lib/security/mutation-budget";
import { consumeEmailBudget } from "../../lib/auth/email-budget";
import { withRequestBodyLimit } from "../../lib/http/request-body";
import { AuthGuard } from "../../lib/auth/guard";
import { handleAuthRequest } from "../../lib/auth/request-boundary";
import { readMcpRequest } from "../../lib/mcp/scopes";
import {
  boundedGitHubOperation,
  reserveGitHubRequest,
  consumeGitHubResponseBytes,
  GitHubWorkLimitError,
} from "../../lib/github/work-budget";
export { AuthGuard };
const worker = {
  async fetch(request: Request, env: { AUTH_GUARD: DurableObjectNamespace<AuthGuard> }) {
    const path = new URL(request.url).pathname;
    // Same context mechanism OpenNext supplies to the production guard client.
    Object.assign(globalThis, { [Symbol.for("__cloudflare-context__")]: { env } });
    if (path === "/personal-attempts") {
      const url = new URL(request.url),
        kind = url.searchParams.get("kind");
      if (!kind || !Object.hasOwn(PERSONAL_ATTEMPTS, kind))
        return new Response(null, { status: 400 });
      try {
        await reservePersonalAttempts(
          kind as PersonalOperation,
          url.searchParams.get("user") ?? "one",
        );
        return new Response(null, { status: 204 });
      } catch (error) {
        if (error instanceof PersonalBudgetError)
          return new Response(null, { status: error.status });
        throw error;
      }
    }
    if (path === "/github-oauth-attempts") {
      const url = new URL(request.url);
      try {
        await reserveGitHubOAuthAttempts(
          url.searchParams.get("user") ?? "one",
          url.searchParams.get("organization") ?? "one",
        );
        return new Response(null, { status: 204 });
      } catch (error) {
        if (error instanceof GitHubOAuthBudgetError)
          return new Response(null, { status: error.status });
        throw error;
      }
    }
    if (path === "/linear-attempts") {
      const url = new URL(request.url);
      const kind = url.searchParams.get("kind");
      try {
        await reserveLinearAttempts(
          kind === "write" || kind === "oauth" ? kind : "read",
          url.searchParams.get("user") ?? "one",
          url.searchParams.get("organization") ?? "one",
        );
        return new Response(null, { status: 204 });
      } catch (error) {
        if (error instanceof ConnectorError) return new Response(null, { status: error.status });
        throw error;
      }
    }
    if (path === "/linear-work") {
      let admitted = 0;
      const inner = boundedLinearOperation(async () => {
        for (let i = 0; i < 10; i++) {
          linearRequestSignal();
          admitted++;
          await Promise.resolve();
        }
      });
      return Response.json(
        await boundedLinearOperation(async () => {
          const results = await Promise.allSettled([inner(), inner()]);
          let bytesLimited = false;
          try {
            consumeLinearBytes(2_000_001);
            consumeLinearBytes(2_000_000);
          } catch (error) {
            bytesLimited = error instanceof ConnectorError;
          }
          return {
            admitted,
            limited: results.every(
              (x) => x.status === "rejected" && x.reason instanceof ConnectorError,
            ),
            bytesLimited,
          };
        })(),
      );
    }
    if (path === "/github-budget") {
      let admitted = 0;
      const inner = boundedGitHubOperation(async () => {
        for (let count = 0; count < 25; count++) {
          reserveGitHubRequest();
          admitted++;
          await Promise.resolve();
        }
      });
      const operation = boundedGitHubOperation(async () => {
        const results = await Promise.allSettled([inner(), inner()]);
        return {
          admitted,
          limited: results.every(
            (result) =>
              result.status === "rejected" && result.reason instanceof GitHubWorkLimitError,
          ),
        };
      });
      return Response.json(await operation());
    }
    if (path === "/github-byte-budget") {
      const operation = boundedGitHubOperation(async () => {
        consumeGitHubResponseBytes(13 * 1024 * 1024);
        await Promise.resolve();
        try {
          consumeGitHubResponseBytes(13 * 1024 * 1024);
          return { limited: false };
        } catch (error) {
          return { limited: error instanceof GitHubWorkLimitError };
        }
      });
      return Response.json(await operation());
    }
    if (path === "/image-budget") {
      const url = new URL(request.url);
      try {
        await reserveImageOperation(
          url.searchParams.get("kind") === "thumbnail" ? "thumbnail" : "read",
          url.searchParams.get("user") ?? "one",
          url.searchParams.get("organization") ?? "one",
        );
        return new Response(null, { status: 204 });
      } catch (error) {
        if (error instanceof MutationBudgetError) return new Response(null, { status: 429 });
        throw error;
      }
    }
    if (path === "/file-management-budget") {
      const url = new URL(request.url);
      try {
        await reserveFileManagement(
          url.searchParams.get("user") ?? "one",
          url.searchParams.get("organization") ?? "one",
        );
        return new Response(null, { status: 204 });
      } catch (error) {
        if (error instanceof MutationBudgetError) return new Response(null, { status: 429 });
        throw error;
      }
    }
    if (path === "/clipboard-budget") {
      const url = new URL(request.url);
      try {
        await reserveClipboardTransfer(
          url.searchParams.get("user") ?? "one",
          url.searchParams.get("organization") ?? "one",
        );
        return new Response(null, { status: 204 });
      } catch (error) {
        if (error instanceof MutationBudgetError) return new Response(null, { status: 429 });
        throw error;
      }
    }
    if (path === "/feedback-budget") {
      try {
        await reserveFeedbackUpload(new URL(request.url).searchParams.get("user") ?? "one");
        return new Response(null, { status: 204 });
      } catch (error) {
        if (error instanceof MutationBudgetError) return new Response(null, { status: 429 });
        throw error;
      }
    }
    if (path === "/registration-budget") {
      try {
        await reserveClientRegistration();
        return new Response(null, { status: 204 });
      } catch (error) {
        if (error instanceof APIError && error.status === "TOO_MANY_REQUESTS")
          return new Response(null, { status: 429 });
        throw error;
      }
    }
    if (path === "/comment-budget" || path === "/invitation-budget") {
      const org = new URL(request.url).searchParams.get("organization") ?? "one";
      try {
        if (path === "/invitation-budget") await reserveInvitationMutation("same-actor", org);
        else await reserveCommentMutation("same-actor", org);
        return new Response(null, { status: 204 });
      } catch (error) {
        if (error instanceof MutationBudgetError) return new Response(null, { status: 429 });
        throw error;
      }
    }
    if (path === "/mcp") {
      try {
        // Next.js app routes wrap requests in a proxy that binds property reads
        // to the underlying request (proxyNextRequest / ReflectAdapter).
        const routeRequest = new Proxy(request, {
          get(target, property) {
            const value = Reflect.get(target, property, target);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
        const parsed = await readMcpRequest(routeRequest);
        return Response.json({ scopes: parsed.scopes, body: await parsed.request.json() });
      } catch (error) {
        return Response.json({ error: String(error) }, { status: 400 });
      }
    }
    if (path === "/bounded-body")
      return withRequestBodyLimit(
        async (bounded) => Response.json(await bounded.json()),
        32,
      )(request);
    const guard = env.AUTH_GUARD.get(env.AUTH_GUARD.idFromName("auth-test"));
    if (path === "/email")
      return Response.json({
        allowed: await consumeEmailBudget("test@example.test", (key, rule) =>
          guard.consume(key, rule),
        ),
      });
    if (path === "/limit")
      return Response.json(await guard.consume("concurrent", { window: 60, max: 3 }));
    if (path === "/metadata")
      return guard.fetch(
        new Request("https://internal.test/metadata", {
          method: "POST",
          body: JSON.stringify({ url: "https://client.example/metadata.json" }),
        }),
      );
    return handleAuthRequest(
      request,
      async () => {
        if (path === "/stall") return new Promise<Response>(() => {});
        if (path === "/body-stall")
          return new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new TextEncoder().encode("partial"));
              },
            }),
          );
        return Response.json(null);
      },
      50,
    );
  },
};
export default worker;
