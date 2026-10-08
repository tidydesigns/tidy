import type { Instrumentation } from "next";

export const onRequestError: Instrumentation.onRequestError = async (error, request, context) => {
  const { createErrorReporter } = await import("./lib/posthog-server");
  const headers = new Headers();
  for (const name of ["cookie", "cf-ray"]) {
    const value = request.headers[name];
    if (value) headers.set(name, Array.isArray(value) ? value.join("; ") : value);
  }
  const digest =
    error instanceof Error && "digest" in error && typeof error.digest === "string"
      ? error.digest
      : undefined;
  await createErrorReporter(headers)(error, {
    source: "next",
    event: "server_request_failed",
    route: context.routePath,
    method: request.method,
    phase: context.routeType,
    digest,
  });
};
