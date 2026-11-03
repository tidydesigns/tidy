import { afterEach, expect, spyOn, test } from "bun:test";
import { consentCookie, consentRevision, CONSENT_VERSION } from "@tidy/ui/privacy-consent";
import { proxyAnalytics } from "./analytics";

const choice = {
  version: CONSENT_VERSION,
  at: Date.now(),
  analytics: true,
  replay: true,
  diagnostics: true,
};
const env = { ANALYTICS_APP_ORIGIN: "https://app.example" };
let network: ReturnType<typeof spyOn> | undefined;
afterEach(() => network?.mockRestore());
function request(
  path = "/api/t/e",
  extra: Record<string, string> = {},
  body: string | null = "{}",
) {
  return new Request(`https://site.example${path}`, {
    method: body === null ? "GET" : "POST",
    headers: {
      origin: "https://site.example",
      cookie: `${consentCookie(choice, choice.at)}; tidy_consent_receipt=${"a".repeat(64)}; auth-session=private`,
      "x-tidy-consent": consentRevision(choice),
      "x-tidy-receipt": "fixture-receipt",
      "x-tidy-privacy": "1",
      "content-type": "application/json",
      ...extra,
    },
    ...(body === null ? {} : { body }),
  });
}
test("absent, stale, expired and rejected consent cannot reach the app", async () => {
  network = spyOn(globalThis, "fetch").mockResolvedValue(Response.json({}));
  for (const headers of [
    { cookie: "" },
    { "x-tidy-consent": "stale" },
    { cookie: consentCookie({ analytics: false, replay: false, diagnostics: false }, choice.at) },
    { cookie: consentCookie(choice, choice.at - 200 * 86400000) },
  ] as Record<string, string>[])
    expect((await proxyAnalytics(request("/api/t/e", headers), env)).status).toBe(403);
  expect(network).not.toHaveBeenCalled();
});
test("proxy forwards consent material, not authentication, referrers, IPs or arbitrary parameters", async () => {
  network = spyOn(globalThis, "fetch").mockResolvedValue(
    Response.json({}, { headers: { "set-cookie": "provider=private" } }),
  );
  const result = await proxyAnalytics(
    request("/api/t/i/v0/e?secret=private&v=3", {
      authorization: "private",
      referer: "https://site.example/?private",
      "x-forwarded-for": "192.0.2.1",
    }),
    env,
  );
  expect(result.status).toBe(200);
  const [url, options] = network.mock.calls[0]!;
  expect(String(url)).toBe("https://app.example/api/t/i/v0/e?v=3");
  expect(options.headers.get("cookie")).not.toContain("auth-session");
  for (const key of ["authorization", "referer", "x-forwarded-for", "cf-connecting-ip"])
    expect(options.headers.has(key)).toBe(false);
  expect(options.headers.get("origin")).toBe("https://app.example");
  expect(result.headers.get("set-cookie")).toBeNull();
  expect(result.headers.get("cache-control")).toBe("no-store");
});
test("receipt proxy sets only host-only consent cookies and supports revoke-only fallback", async () => {
  const headers = new Headers();
  headers.append(
    "set-cookie",
    `tidy_consent_receipt=${"b".repeat(64)}; Path=/; HttpOnly; Secure; SameSite=Strict`,
  );
  headers.append("set-cookie", "session=private; Path=/");
  headers.append("set-cookie", "tidy_consent=bad; Domain=example");
  network = spyOn(globalThis, "fetch").mockResolvedValue(Response.json({}, { headers }));
  const response = await proxyAnalytics(
    request("/api/privacy/consent", { cookie: "" }, JSON.stringify({ revoke: true })),
    env,
  );
  expect(response.status).toBe(200);
  expect(response.headers.getSetCookie()).toEqual([
    `tidy_consent_receipt=${"b".repeat(64)}; Path=/; HttpOnly; Secure; SameSite=Strict`,
  ]);
});
test("cross-origin, unsupported routes, insecure targets, excessive bodies and redirects fail closed", async () => {
  network = spyOn(globalThis, "fetch").mockResolvedValue(Response.json({}));
  expect(
    (await proxyAnalytics(request("/api/t/e", { origin: "https://attacker.example" }), env)).status,
  ).toBe(403);
  expect((await proxyAnalytics(request("/api/t/flags"), env)).status).toBe(404);
  expect((await proxyAnalytics(request(), {})).status).toBe(503);
  for (const target of [
    "http://app.example",
    "https://user:password@app.example",
    "https://app.example/private",
    "https://app.example/?secret=private",
  ])
    expect((await proxyAnalytics(request(), { ANALYTICS_APP_ORIGIN: target })).status).toBe(503);
  expect(
    (await proxyAnalytics(request("/api/privacy/consent", {}, "a".repeat(1025)), env)).status,
  ).toBe(413);
  expect(network).not.toHaveBeenCalled();
  network.mockResolvedValue(
    new Response(null, { status: 302, headers: { location: "https://attacker.example" } }),
  );
  const result = await proxyAnalytics(request(), env);
  expect(result.status).toBe(503);
  expect(result.headers.get("location")).toBeNull();
});
test("SDK configuration GETs can omit Origin while replay still requires replay consent", async () => {
  network = spyOn(globalThis, "fetch").mockResolvedValue(Response.json({}));
  const config = request("/api/t/array/fixture/config", {}, null);
  config.headers.delete("origin");
  expect((await proxyAnalytics(config, env)).status).toBe(200);
  network.mockClear();
  const analytics = { ...choice, replay: false };
  expect(
    (
      await proxyAnalytics(
        request("/api/t/s", {
          cookie: consentCookie(analytics, analytics.at),
          "x-tidy-consent": consentRevision(analytics),
        }),
        env,
      )
    ).status,
  ).toBe(200);
  expect(network).not.toHaveBeenCalled();
});
