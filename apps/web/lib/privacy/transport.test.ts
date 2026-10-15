import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { consentCookie, consentRevision, CONSENT_VERSION } from "./consent";
mock.module("server-only", () => ({}));
const { GET, POST } = await import("../../app/api/t/[...path]/route");
const consentStore = await import("./consent-store");
let verify: ReturnType<typeof spyOn>;
const old = { ...process.env };
afterEach(() => {
  verify?.mockRestore();
  for (const key of [
    "NEXT_PUBLIC_POSTHOG_ENABLED",
    "NEXT_PUBLIC_POSTHOG_HOST",
    "NEXT_PUBLIC_POSTHOG_KEY",
    "BETTER_AUTH_URL",
    "POSTHOG_PREVIEW_HOST",
  ]) {
    if (old[key] === undefined) delete process.env[key];
    else process.env[key] = old[key];
  }
});
function setup() {
  verify = spyOn(consentStore, "authorizeTelemetry").mockResolvedValue(true);
  process.env.NEXT_PUBLIC_POSTHOG_ENABLED = "1";
  process.env.NEXT_PUBLIC_POSTHOG_HOST = "https://eu.i.posthog.com";
  process.env.NEXT_PUBLIC_POSTHOG_KEY = "synthetic-key";
  process.env.BETTER_AUTH_URL = "https://app.example";
  delete process.env.POSTHOG_PREVIEW_HOST;
}
const choices = {
  version: CONSENT_VERSION,
  at: Date.now(),
  analytics: true,
  replay: true,
  diagnostics: true,
};
function request(path: string, headers: Record<string, string> = {}, method = "POST") {
  return new Request(`https://app.example/api/t/${path}?secret=private&v=3`, {
    method,
    headers: {
      cookie: consentCookie(choices, choices.at),
      "x-tidy-consent": consentRevision(choices),
      "x-tidy-receipt": "00000000-0000-4000-8000-000000000001",
      origin: "https://app.example",
      "content-type": "application/json",
      ...headers,
    },
    ...(method === "POST" ? { body: JSON.stringify({ event: "$pageview" }) } : {}),
  });
}
const context = (route: string) => ({ params: Promise.resolve({ path: route.split("/") }) });
test("no opt-in, stale revision and release pause cannot reach the provider", async () => {
  setup();
  const transport = spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ status: 1 }));
  try {
    for (const headers of [
      { cookie: "" },
      { "x-tidy-consent": "previous-choice" },
      {
        cookie: consentCookie(
          { ...choices, analytics: false, replay: false, diagnostics: false },
          choices.at,
        ),
      },
    ] as Record<string, string>[])
      expect((await POST(request("e", headers), context("e"))).status).toBe(200);
    process.env.NEXT_PUBLIC_POSTHOG_ENABLED = "0";
    await POST(request("e"), context("e"));
    expect(transport).not.toHaveBeenCalled();
  } finally {
    transport.mockRestore();
  }
});
test("proxy strips identifying headers and arbitrary URL parameters", async () => {
  setup();
  const transport = spyOn(globalThis, "fetch").mockResolvedValue(
    Response.json({ status: "Ok" }, { headers: { "Set-Cookie": "provider=bad" } }),
  );
  try {
    const result = await POST(
      request("i/v0/e", {
        authorization: "private",
        referer: "https://app.example/?secret=private",
        "x-forwarded-for": "192.0.2.1",
      }),
      context("i/v0/e"),
    );
    expect(result.status).toBe(200);
    expect(result.headers.get("set-cookie")).toBeNull();
    expect(result.headers.get("cache-control")).toBe("no-store");
    const [url, options] = transport.mock.calls[0]!;
    expect(String(url)).toBe("https://eu.i.posthog.com/i/v0/e/?v=3&ip=0");
    expect(options?.headers).toEqual({ "Content-Type": "application/json" });
    expect(options?.redirect).toBe("manual");
  } finally {
    transport.mockRestore();
  }
});
test("config uses the regional assets host and unsafe paths/origins fail closed", async () => {
  setup();
  const transport = spyOn(globalThis, "fetch").mockResolvedValue(Response.json({}));
  try {
    const route = "array/synthetic-key/config";
    await GET(request(route, {}, "GET"), context(route));
    expect(String(transport.mock.calls[0]![0])).toStartWith(
      "https://eu-assets.i.posthog.com/array/synthetic-key/config?",
    );
    transport.mockClear();
    expect(
      (await POST(request("e", { origin: "https://attacker.example" }), context("e"))).status,
    ).toBe(403);
    expect((await POST(request("unknown"), context("unknown"))).status).toBe(404);
    process.env.NEXT_PUBLIC_POSTHOG_HOST = "https://attacker.example";
    expect((await POST(request("e"), context("e"))).status).toBe(503);
    expect(transport).not.toHaveBeenCalled();
  } finally {
    transport.mockRestore();
  }
});
test("managed proxy requires consent and forwards events and config without identifying headers", async () => {
  setup();
  process.env.NEXT_PUBLIC_POSTHOG_HOST = "https://t.tidydesign.co";
  const transport = spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(Response.json({}))
    .mockResolvedValueOnce(Response.json({}));
  try {
    expect((await POST(request("e", { cookie: "" }), context("e"))).status).toBe(200);
    verify.mockResolvedValueOnce(false);
    expect((await POST(request("e"), context("e"))).status).toBe(403);
    expect(transport).not.toHaveBeenCalled();
    const event = await POST(
      request("i/v0/e", {
        authorization: "private",
        referer: "https://app.example/?secret=private",
        "x-forwarded-for": "192.0.2.1",
      }),
      context("i/v0/e"),
    );
    expect(event.status).toBe(200);
    expect(String(transport.mock.calls[0]![0])).toBe("https://t.tidydesign.co/i/v0/e/?v=3&ip=0");
    expect(transport.mock.calls[0]![1]?.headers).toEqual({
      "Content-Type": "application/json",
    });
    const route = "array/synthetic-key/config";
    expect((await GET(request(route, {}, "GET"), context(route))).status).toBe(200);
    expect(String(transport.mock.calls[1]![0])).toBe(
      "https://t.tidydesign.co/array/synthetic-key/config?v=3&ip=0",
    );
  } finally {
    transport.mockRestore();
  }
});
test("managed proxy allowlist rejects lookalike hosts and unsafe URLs", async () => {
  setup();
  const transport = spyOn(globalThis, "fetch").mockResolvedValue(Response.json({}));
  try {
    for (const host of [
      "https://t.tidydesign.co.attacker.example",
      "https://other.tidydesign.co",
      "http://t.tidydesign.co",
      "https://t.tidydesign.co:8443",
      "https://user:password@t.tidydesign.co",
    ]) {
      process.env.NEXT_PUBLIC_POSTHOG_HOST = host;
      expect((await POST(request("e"), context("e"))).status).toBe(503);
    }
    expect(transport).not.toHaveBeenCalled();
  } finally {
    transport.mockRestore();
  }
});
test("replay and survey endpoints require their corresponding purpose", async () => {
  setup();
  const transport = spyOn(globalThis, "fetch").mockResolvedValue(Response.json({}));
  try {
    const diagnostics = { ...choices, analytics: false, replay: false };
    const headers = {
      cookie: consentCookie(diagnostics, diagnostics.at),
      "x-tidy-consent": consentRevision(diagnostics),
    };
    await POST(request("s", headers), context("s"));
    await GET(request("api/surveys", headers, "GET"), context("api/surveys"));
    expect(transport).not.toHaveBeenCalled();
  } finally {
    transport.mockRestore();
  }
});

test("unrecorded or superseded server consent cannot reach PostHog", async () => {
  setup();
  verify.mockResolvedValue(false);
  const transport = spyOn(globalThis, "fetch").mockResolvedValue(Response.json({}));
  try {
    expect((await POST(request("e"), context("e"))).status).toBe(403);
    expect(transport).not.toHaveBeenCalled();
  } finally {
    transport.mockRestore();
  }
});

test("even analytics consent cannot send browser flag or decide requests", async () => {
  setup();
  const transport = spyOn(globalThis, "fetch");
  try {
    for (const route of ["flags", "decide"])
      expect((await POST(request(route), context(route))).status).toBe(404);
    expect(transport).not.toHaveBeenCalled();
  } finally {
    transport.mockRestore();
  }
});

for (const status of [301, 302, 303, 307, 308]) {
  test(`proxy rejects an upstream ${status} without exposing its redirect`, async () => {
    setup();
    const transport = spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("redirect body", { status, headers: { Location: "https://attacker.example" } }),
    );
    try {
      const result = await POST(request("e"), context("e"));
      expect(result.status).toBe(503);
      expect(result.headers.get("location")).toBeNull();
      expect(await result.text()).toBe("");
      expect(transport).toHaveBeenCalledTimes(1);
      expect(transport.mock.calls[0]![1]?.redirect).toBe("manual");
    } finally {
      transport.mockRestore();
    }
  });
}

test("telemetry admission denies before consent lookup and byte exhaustion denies before upstream", async () => {
  setup();
  const budgets = await import("../security/public-budget");
  const attempt = spyOn(budgets, "reserveTelemetryAttempt").mockRejectedValue(
    new budgets.PublicBudgetError(17),
  );
  const bytes = spyOn(budgets, "reserveTelemetryBytes").mockResolvedValue();
  const transport = spyOn(globalThis, "fetch").mockResolvedValue(Response.json({}));
  try {
    const blocked = await POST(request("e"), context("e"));
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("retry-after")).toBe("17");
    expect(verify).not.toHaveBeenCalled();
    expect(transport).not.toHaveBeenCalled();
    attempt.mockResolvedValue();
    bytes.mockRejectedValue(new budgets.PublicBudgetError(31));
    expect((await POST(request("e"), context("e"))).status).toBe(429);
    expect(verify).toHaveBeenCalledTimes(1);
    expect(bytes.mock.calls[0]?.[1]).toBe(
      new TextEncoder().encode(JSON.stringify({ event: "$pageview" })).length,
    );
    expect(transport).not.toHaveBeenCalled();
    bytes.mockResolvedValue();
    expect((await POST(request("e"), context("e"))).status).toBe(200);
    expect(transport).toHaveBeenCalledTimes(1);
  } finally {
    attempt.mockRestore();
    bytes.mockRestore();
    transport.mockRestore();
  }
});
