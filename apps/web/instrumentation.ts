import type { Instrumentation } from "next";

export const onRequestError: Instrumentation.onRequestError = async (error, request, context) => {
  const { createErrorReporter } = await import("./lib/posthog-server");
  await createErrorReporter()(error, {
    source: "next",
    event: "server_request_failed",
    route: request.path,
    method: request.method,
    phase: context.routeType,
  });
};
