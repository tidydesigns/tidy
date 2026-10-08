// OpenNext generates this module during build:worker.
import handler from "./.open-next/worker.js";
import { production as buildEnv } from "./.open-next/cloudflare/next-env.mjs";
import { upgradeFileRoom } from "./lib/realtime/upgrade";
import { observeRequest } from "./lib/request-observability";
import { handleRequest, requestDeadline } from "./lib/request-boundary";
import { createErrorReporter } from "./lib/posthog-server";
import { handleAuthRequest, isAuthRequest } from "./lib/auth/request-boundary";
export { AuthGuard } from "./lib/auth/guard";
export { FileRoom } from "./lib/realtime/file-room";
export default {
  async fetch(request, env, ctx) {
    const monitoringEnv = buildEnv as Record<string, string>;
    const tracingEnv = env as CloudflareEnv & {
      POSTHOG_TRACING_ENABLED?: string;
      NEXTJS_ENV?: string;
    };
    const runtime = {
      // The outer Worker runs before OpenNext populates process.env.
      key: monitoringEnv.NEXT_PUBLIC_POSTHOG_KEY,
      host: monitoringEnv.NEXT_PUBLIC_POSTHOG_HOST,
      release: monitoringEnv.NEXT_PUBLIC_APP_VERSION,
      deploymentId: env.CF_VERSION_METADATA.id,
      enabled: tracingEnv.POSTHOG_TRACING_ENABLED ?? monitoringEnv.POSTHOG_TRACING_ENABLED,
      environment: tracingEnv.NEXTJS_ENV ?? "production",
      waitUntil: (task: Promise<unknown>) => ctx.waitUntil(task),
    };
    const report = createErrorReporter(request.headers, runtime);
    if (isAuthRequest(new URL(request.url).pathname)) {
      return observeRequest(
        request,
        () =>
          handleAuthRequest(
            request,
            async (bounded) => handler.fetch(bounded, env, ctx),
            requestDeadline(request),
            report,
          ),
        report,
        runtime,
      );
    }
    // Keep the deadline and its error report inside the request trace, so the
    // root records the actual 503 response rather than an internal abort.
    return observeRequest(
      request,
      () =>
        handleRequest(
          request,
          async (bounded) => {
            const live = await upgradeFileRoom(bounded, env);
            if (live) return live;
            return handler.fetch(bounded, env, ctx);
          },
          undefined,
          report,
        ),
      report,
      runtime,
    );
  },
} satisfies ExportedHandler<CloudflareEnv>;
