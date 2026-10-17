import { ingressResponse } from "../../lib/security/ingress-budget";
import {
  PublicBudgetError,
  reserveTelemetryAttempt,
  reserveTelemetryBytes,
  reserveHealthCheck,
} from "../../lib/security/public-budget";
import { healthResponse } from "../../lib/health-response";
import { AuthGuard } from "../../lib/auth/guard";
export { AuthGuard };
let admitted = 0;
let checks = 0; // Test-only instrumentation, never a production cache.
export default {
  async fetch(request: Request, env: CloudflareEnv, ctx: ExecutionContext) {
    const incoming = new URL(request.url);
    if (incoming.pathname.startsWith("/ingress/")) {
      incoming.pathname = incoming.pathname.slice("/ingress".length);
      const response = await ingressResponse(new Request(incoming, request), env);
      // This stands in for application/auth initialization and must not run on denial.
      if (response) return response;
      return new Response(null, {
        status: 204,
        headers: { "X-Test-Admitted": String(++admitted) },
      });
    }
    if (incoming.pathname === "/lease") {
      const guard = env.AUTH_GUARD.getByName("lease-test");
      const allowed = await guard.acquireConnection(
        "account",
        incoming.searchParams.get("id")!,
        Date.now() + 300_000,
      );
      return new Response(null, { status: allowed ? 204 : 429 });
    }
    Object.assign(globalThis, { [Symbol.for("__cloudflare-context__")]: { env, ctx } });
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      const key = new Request(
        `https://public.test/health/${url.searchParams.has("fail") ? "offline" : "online"}`,
      );
      const response = await healthResponse(
        key,
        async () => {
          checks++;
          if (url.searchParams.has("fail")) throw new Error("database offline");
        },
        reserveHealthCheck,
        await caches.open("tidy-readiness-v1"),
      );
      response.headers.set("X-Test-Checks", String(checks));
      return response;
    }
    try {
      if (url.pathname === "/bytes")
        await reserveTelemetryBytes(
          url.searchParams.get("receipt") || "one",
          Number(url.searchParams.get("bytes")),
        );
      else await reserveTelemetryAttempt(request);
      return new Response(null, { status: 204 });
    } catch (error) {
      return new Response(null, { status: error instanceof PublicBudgetError ? 429 : 503 });
    }
  },
} satisfies ExportedHandler<CloudflareEnv>;
