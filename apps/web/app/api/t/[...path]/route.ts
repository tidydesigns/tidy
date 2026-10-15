import {
  reserveTelemetryAttempt,
  reserveTelemetryBytes,
  PublicBudgetError,
} from "@/lib/security/public-budget";
import { boundedRequest, RequestBodyError } from "@/lib/http/request-body";
import { consentRevision, hasOptionalConsent, readConsent } from "@/lib/privacy/consent";
import { authorizeTelemetry } from "@/lib/privacy/consent-store";

const noStore = { "Cache-Control": "no-store" };
const allowedHosts = new Set(["eu.i.posthog.com", "us.i.posthog.com", "t.tidydesign.co"]);

/** Forward consented telemetry within budget, stripping identifying headers and
 * restricting the upstream destination. */
async function forward(request: Request, context: { params: Promise<{ path: string[] }> }) {
  const consent = readConsent(request.headers.get("cookie"));
  if (
    process.env.NEXT_PUBLIC_POSTHOG_ENABLED !== "1" ||
    !hasOptionalConsent(consent) ||
    !consent ||
    request.headers.get("x-tidy-consent") !== consentRevision(consent)
  )
    return Response.json({ status: 1 }, { headers: noStore });
  const expectedOrigin = new URL(process.env.BETTER_AUTH_URL || request.url).origin;
  if (
    (request.headers.get("origin") && request.headers.get("origin") !== expectedOrigin) ||
    request.headers.get("sec-fetch-site") === "cross-site"
  )
    return new Response(null, { status: 403, headers: noStore });
  const { path } = await context.params;
  const route = path.join("/");
  const token = process.env.NEXT_PUBLIC_POSTHOG_KEY;
  const configRoute = `array/${token}/config`;
  if (!["i/v0/e", "e", "s", "api/surveys", configRoute].includes(route))
    return new Response(null, { status: 404, headers: noStore });
  if ((route === "s" && !consent.replay) || (route === "api/surveys" && !consent.analytics))
    return Response.json({ status: 1 }, { headers: noStore });
  try {
    await reserveTelemetryAttempt(request);
    const receipt = request.headers.get("x-tidy-receipt");
    if (!receipt || receipt.length > 64 || !(await authorizeTelemetry(request, consent)))
      return new Response(null, { status: 403, headers: noStore });
    const upstream = new URL(
      process.env.POSTHOG_PREVIEW_HOST && process.env.NODE_ENV !== "production"
        ? process.env.POSTHOG_PREVIEW_HOST
        : process.env.NEXT_PUBLIC_POSTHOG_HOST || "",
    );
    const localPreview =
      process.env.NODE_ENV !== "production" &&
      ["localhost", "127.0.0.1"].includes(upstream.hostname);
    if (
      (!localPreview &&
        (upstream.protocol !== "https:" ||
          !allowedHosts.has(upstream.hostname) ||
          upstream.port !== "")) ||
      upstream.username ||
      upstream.password
    )
      return new Response(null, { status: 503, headers: noStore });
    if (route === configRoute && !localPreview)
      upstream.hostname = upstream.hostname.replace(".i.", "-assets.i.");
    upstream.search = "";
    upstream.hash = "";
    upstream.pathname = route === configRoute ? `/${route}` : `/${route}/`;
    // SDK protocol flags only. Never forward the page URL or arbitrary query strings.
    const query = new URL(request.url).searchParams;
    for (const key of ["v", "ver", "ip", "compression", "lib_version"])
      if (query.has(key)) upstream.searchParams.set(key, query.get(key)!);
    if (route === "api/surveys" && token) upstream.searchParams.set("token", token);
    upstream.searchParams.set("ip", "0");
    const body =
      request.method === "POST"
        ? await (await boundedRequest(request, 5_000_000)).arrayBuffer()
        : undefined;
    await reserveTelemetryBytes(receipt, body?.byteLength ?? 0);
    const response = await fetch(upstream, {
      method: request.method,
      headers: { "Content-Type": request.headers.get("content-type") || "application/json" },
      body,
      redirect: "manual",
      cache: "no-store",
      signal: AbortSignal.timeout(5000),
    });
    // Workers reject redirect: "error". Never follow or expose an upstream redirect.
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      return new Response(null, { status: 503, headers: noStore });
    }
    return new Response(response.body, {
      status: response.status,
      headers: { ...noStore, "Content-Type": "application/json" },
    });
  } catch (error) {
    if (error instanceof PublicBudgetError)
      return new Response(null, {
        status: 429,
        headers: { ...noStore, "Retry-After": String(error.retryAfter) },
      });
    if (error instanceof RequestBodyError)
      return new Response(null, { status: error.status, headers: noStore });
    return new Response(null, { status: 503, headers: noStore });
  }
}

export const GET = forward;
export const POST = forward;
