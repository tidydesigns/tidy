import { consentRevision, hasOptionalConsent, readConsent } from "@tidy/ui/privacy-consent";

export type AnalyticsEnvironment = { ANALYTICS_APP_ORIGIN?: string };
const noStore = { "Cache-Control": "no-store" };
const routes = new Set(["i/v0/e", "e", "s"]);

/** The static website uses the app's existing consent receipts and admission
 * limits. Authentication cookies and arbitrary destinations never cross here. */
export async function proxyAnalytics(request: Request, env: AnalyticsEnvironment) {
  const url = new URL(request.url);
  const privacy = url.pathname === "/api/privacy/consent";
  const route = url.pathname.replace(/^\/api\/t\//, "").replace(/\/$/, "");
  if (!privacy && !routes.has(route) && !/^array\/[a-zA-Z0-9_-]{1,200}\/config$/.test(route))
    return new Response(null, { status: 404, headers: noStore });
  if (
    !(
      (privacy && request.method === "POST") ||
      (!privacy && ["GET", "POST"].includes(request.method))
    )
  )
    return new Response(null, { status: 405, headers: noStore });
  if (
    (privacy && request.headers.get("origin") !== url.origin) ||
    (request.headers.get("origin") && request.headers.get("origin") !== url.origin) ||
    request.headers.get("sec-fetch-site") === "cross-site"
  )
    return new Response(null, { status: 403, headers: noStore });
  const cookie = request.headers.get("cookie");
  const consent = readConsent(cookie);
  if (
    privacy
      ? request.headers.get("x-tidy-privacy") !== "1"
      : !consent ||
        !hasOptionalConsent(consent) ||
        request.headers.get("x-tidy-consent") !== consentRevision(consent)
  )
    return new Response(null, { status: 403, headers: noStore });
  if (!privacy && route === "s" && !consent?.replay)
    return Response.json({ status: 1 }, { headers: noStore });
  try {
    if (!env.ANALYTICS_APP_ORIGIN) return new Response(null, { status: 503, headers: noStore });
    const upstream = new URL(env.ANALYTICS_APP_ORIGIN);
    const loopback =
      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) &&
      ["localhost", "127.0.0.1", "[::1]"].includes(upstream.hostname);
    if (
      (upstream.protocol !== "https:" && !(loopback && upstream.protocol === "http:")) ||
      upstream.username ||
      upstream.password ||
      upstream.pathname !== "/" ||
      upstream.search ||
      upstream.hash
    )
      return new Response(null, { status: 503, headers: noStore });
    const headers = new Headers({
      origin: upstream.origin,
      "x-tidy-surface": "website",
      "Content-Type": request.headers.get("content-type") || "application/json",
    });
    if (!privacy && request.headers.get("content-encoding") === "gzip")
      headers.set("Content-Encoding", "gzip");
    const cookies = (cookie ?? "")
      .split(";")
      .map((part) => part.trim())
      .filter((part) => /^(tidy_consent|tidy_consent_receipt)=/.test(part));
    if (cookies.length) headers.set("cookie", cookies.join("; "));
    for (const name of ["x-tidy-privacy", "x-tidy-consent", "x-tidy-receipt"])
      if (request.headers.has(name)) headers.set(name, request.headers.get(name)!);
    const reader = request.body?.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    let expired = false;
    const deadline = reader
      ? setTimeout(() => {
          expired = true;
          void reader.cancel().catch(() => {});
        }, 5000)
      : undefined;
    if (reader)
      try {
        while (true) {
          const result = await reader.read();
          if (expired) return new Response(null, { status: 408, headers: noStore });
          if (result.done) break;
          bytes += result.value.byteLength;
          if (bytes > (privacy ? 1024 : 5_000_000))
            return new Response(null, { status: 413, headers: noStore });
          chunks.push(result.value);
        }
      } finally {
        clearTimeout(deadline);
        void reader.cancel().catch(() => {});
      }
    const body = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    upstream.pathname = privacy ? "/api/privacy/consent" : `/api/t/${route}`;
    for (const name of ["v", "ver", "ip", "compression", "lib_version"])
      if (url.searchParams.has(name)) upstream.searchParams.set(name, url.searchParams.get(name)!);
    const response = await fetch(upstream, {
      method: request.method,
      headers,
      body: request.method === "POST" ? body : undefined,
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      return new Response(null, { status: 503, headers: noStore });
    }
    const outgoing = new Headers({ ...noStore, "Content-Type": "application/json" });
    if (response.headers.has("retry-after"))
      outgoing.set("retry-after", response.headers.get("retry-after")!);
    if (privacy)
      for (const value of response.headers.getSetCookie())
        if (/^(tidy_consent|tidy_consent_receipt)=/.test(value) && !/;\s*domain=/i.test(value))
          outgoing.append("set-cookie", value);
    return new Response(response.body, { status: response.status, headers: outgoing });
  } catch {
    return new Response(null, { status: 503, headers: noStore });
  }
}
