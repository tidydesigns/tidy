import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { createHmac } from "node:crypto";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { consentCookie, CONSENT_MAX_AGE, CONSENT_VERSION, type Consent } from "./consent";

mock.module("server-only", () => ({}));
const { claimSignupCompletion, recordSignupCompletion, SIGNUP_COMPLETION_COOKIE } =
  await import("./signup-completion");
const origin = "https://signup.example.test";
const now = Date.now();
const secret = `${crypto.randomUUID()}${crypto.randomUUID()}`;
const choices = { analytics: true, replay: false, diagnostics: false };
const old = { ...process.env };
let clock: ReturnType<typeof spyOn<typeof Date, "now">>;

beforeEach(() => {
  process.env.NEXT_PUBLIC_POSTHOG_ENABLED = "1";
  process.env.BETTER_AUTH_SECRET = secret;
  process.env.BETTER_AUTH_URL = origin;
  clock = spyOn(Date, "now").mockReturnValue(now);
});
afterEach(() => {
  clock.mockRestore();
  for (const key of ["NEXT_PUBLIC_POSTHOG_ENABLED", "BETTER_AUTH_SECRET", "BETTER_AUTH_URL"]) {
    if (old[key] === undefined) delete process.env[key];
    else process.env[key] = old[key];
  }
});

function issue(cookie = consentCookie(choices, now), path = "/sign-up/email", provider = "google") {
  const setCookie = mock(() => "");
  recordSignupCompletion("new-user-verification-only", {
    path,
    params: { id: provider },
    body: { provider, idToken: { token: "synthetic" } },
    headers: new Headers({ cookie }),
    context: { baseURL: `${origin}/api/auth` },
    setCookie,
  } as unknown as NonNullable<Parameters<typeof recordSignupCompletion>[1]>);
  const call = setCookie.mock.calls[0] as unknown as
    | [string, string, Record<string, unknown>]
    | undefined;
  return { setCookie, value: call?.[1], options: call?.[2] };
}

function request(value?: string, headers: Record<string, string> = {}) {
  return new Request(`${origin}/api/privacy/signup-completion`, {
    method: "POST",
    headers: {
      origin,
      "x-tidy-privacy": "1",
      "x-tidy-receipt": "00000000-0000-4000-8000-000000000001",
      cookie: `${consentCookie(choices, now).split(";")[0]}; ${SIGNUP_COMPLETION_COOKIE}=${value ?? ""}`,
      ...headers,
    },
  });
}
function dependencies(userId: string | null = null, allowed = true) {
  return {
    sessionUserId: mock<(request: Request) => Promise<string | null>>(async () => userId),
    authorizeTelemetry: mock<(request: Request, consent: Consent) => Promise<boolean>>(
      async () => allowed,
    ),
  };
}
function resigned(value: string, changes: Record<string, unknown>) {
  const marker = JSON.parse(Buffer.from(value.split(".")[0], "base64url").toString());
  const payload = Buffer.from(JSON.stringify({ ...marker, ...changes })).toString("base64url");
  const sig = createHmac("sha256", secret)
    .update("tidy:signup-completion:v1\0")
    .update(payload)
    .digest("base64url");
  return `${payload}.${sig}`;
}
function cookieUnchanged(response: Response) {
  // A delayed old response must not erase a newer signup marker.
  expect(response.headers.get("set-cookie")).toBeNull();
  expect(response.headers.get("cache-control")).toBe("private, no-store");
}

test("only consented new-account hooks issue signed, host-only, bounded HttpOnly markers", () => {
  const issued = issue();
  expect(issued.setCookie).toHaveBeenCalledTimes(1);
  expect(issued.options).toEqual({
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: 86400,
  });
  for (const cookie of [
    "",
    consentCookie({ ...choices, analytics: false, replay: true, diagnostics: true }, now),
    consentCookie(choices, now - CONSENT_MAX_AGE * 1000),
    `${consentCookie(choices, now)}; ${consentCookie(choices, now)}`,
  ])
    expect(issue(cookie).setCookie).not.toHaveBeenCalled();
  for (const path of ["/sign-in/email", "/verify-email", "/link-social", "/unknown"])
    expect(issue(undefined, path).setCookie).not.toHaveBeenCalled();
  expect(issue(undefined, "/callback/:id", "unknown").setCookie).not.toHaveBeenCalled();
  process.env.NEXT_PUBLIC_POSTHOG_ENABLED = "0";
  expect(issue().setCookie).not.toHaveBeenCalled();
});

test("signing and cookie failures cannot break account creation", () => {
  delete process.env.BETTER_AUTH_SECRET;
  expect(() => issue()).not.toThrow();
  expect(issue().setCookie).not.toHaveBeenCalled();
  process.env.BETTER_AUTH_SECRET = secret;
  recordSignupCompletion("new-user", null);
  expect(() =>
    recordSignupCompletion("new-user", {
      path: "/sign-up/email",
      headers: new Headers({ cookie: consentCookie(choices, now) }),
      context: { baseURL: origin },
      setCookie: () => {
        throw new Error("cookie fault");
      },
    } as unknown as NonNullable<Parameters<typeof recordSignupCompletion>[1]>),
  ).not.toThrow();
});

test("email insertion can claim before verification; races preserve UUID/time and hide user ID", async () => {
  const value = issue().value!;
  const deps = dependencies();
  const results = await Promise.all([
    claimSignupCompletion(request(value), deps),
    claimSignupCompletion(request(value), deps),
  ]);
  results.forEach(cookieUnchanged);
  const bodies = (await Promise.all(results.map((response) => response.json()))) as {
    eventId: string;
    at: number;
    method: string;
  }[];
  expect(bodies[0]).toEqual(bodies[1]);
  expect(bodies[0]).toEqual({ eventId: expect.any(String), at: now, method: "email" });
  expect(bodies[0].eventId).toMatch(/^[a-f0-9-]{36}$/);
  expect(JSON.stringify(bodies[0])).not.toContain("new-user");
  expect(deps.authorizeTelemetry).toHaveBeenCalledTimes(2);
  const noMarker = await claimSignupCompletion(request(), deps);
  expect(noMarker.status).toBe(204);
});

test("OAuth claims require the matching session; different account and anonymous OAuth fail", async () => {
  for (const provider of ["google", "github"]) {
    const value = issue(undefined, "/callback/:id", provider).value!;
    for (const userId of [null, "other-user"]) {
      const deps = dependencies(userId);
      const rejected = await claimSignupCompletion(request(value), deps);
      expect(rejected.status).toBe(403);
      cookieUnchanged(rejected);
      expect(deps.authorizeTelemetry).not.toHaveBeenCalled();
    }
    const accepted = await claimSignupCompletion(
      request(value),
      dependencies("new-user-verification-only"),
    );
    expect(await accepted.json()).toMatchObject({ method: provider, at: now });
    cookieUnchanged(accepted);
  }
  const rejected = await claimSignupCompletion(request(issue().value), dependencies("other-user"));
  expect(rejected.status).toBe(403);
  cookieUnchanged(rejected);
});

test("tampered, oversized, ambiguous and malformed signed markers collect nothing", async () => {
  const value = issue().value!;
  const [payload, sig] = value.split(".");
  const tampered = Buffer.from(
    JSON.stringify({
      ...JSON.parse(Buffer.from(payload, "base64url").toString()),
      method: "github",
    }),
  ).toString("base64url");
  for (const token of [
    `${tampered}.${sig}`,
    `${payload}.${sig[0] === "a" ? "b" : "a"}${sig.slice(1)}`,
    "malformed",
    "a".repeat(2049),
    `${value}; ${SIGNUP_COMPLETION_COOKIE}=${value}`,
    resigned(value, { method: "unknown" }),
    resigned(value, { eventId: "not-a-uuid" }),
    resigned(value, { at: now + 1 }),
    resigned(value, { userId: "" }),
  ]) {
    const deps = dependencies();
    const response = await claimSignupCompletion(request(token), deps);
    expect(response.status).toBe(204);
    cookieUnchanged(response);
    expect(deps.sessionUserId).not.toHaveBeenCalled();
    expect(deps.authorizeTelemetry).not.toHaveBeenCalled();
  }
  // A valid HMAC from another purpose is not a signup proof.
  const other = createHmac("sha256", secret).update(payload).digest("base64url");
  expect((await claimSignupCompletion(request(`${payload}.${other}`), dependencies())).status).toBe(
    204,
  );
});

test("claims expire at 24 hours, or earlier when occurrence consent expires", async () => {
  const value = issue().value!;
  clock.mockReturnValue(now + 86400 * 1000 - 1);
  expect((await claimSignupCompletion(request(value), dependencies())).status).toBe(200);
  clock.mockReturnValue(now + 86400 * 1000);
  const expired = await claimSignupCompletion(request(value), dependencies());
  expect(expired.status).toBe(204);
  cookieUnchanged(expired);
  clock.mockReturnValue(now);
  const consent = consentCookie(choices, now - CONSENT_MAX_AGE * 1000 + 1000).split(";")[0];
  const shorter = issue(consent).value!;
  clock.mockReturnValue(now + 1000);
  const response = await claimSignupCompletion(
    request(shorter, { cookie: `${consent}; ${SIGNUP_COMPLETION_COOKIE}=${shorter}` }),
    dependencies(),
  );
  expect(response.status).toBe(204);
  cookieUnchanged(response);
});

test("withdrawal, regrant, revision changes and disabled collection invalidate the marker", async () => {
  const value = issue().value!;
  clock.mockReturnValue(now + 1);
  for (const cookie of [
    "",
    consentCookie({ ...choices, analytics: false }, now),
    consentCookie(choices, now + 1),
    consentCookie({ ...choices, replay: true }, now),
    `tidy_consent=${encodeURIComponent(JSON.stringify({ ...choices, at: now, version: CONSENT_VERSION - 1 }))}`,
  ]) {
    const deps = dependencies();
    const response = await claimSignupCompletion(
      request(value, { cookie: `${cookie}; ${SIGNUP_COMPLETION_COOKIE}=${value}` }),
      deps,
    );
    expect(response.status).toBe(204);
    cookieUnchanged(response);
    expect(deps.authorizeTelemetry).not.toHaveBeenCalled();
  }
  process.env.NEXT_PUBLIC_POSTHOG_ENABLED = "0";
  const disabled = await claimSignupCompletion(request(value), dependencies());
  expect(disabled.status).toBe(204);
  cookieUnchanged(disabled);
});

test("same-origin privacy header and recorded current receipt are mandatory", async () => {
  const value = issue().value!;
  for (const headers of [
    { origin: "https://attacker.example" },
    { origin: "" },
    { "x-tidy-privacy": "" },
    { "sec-fetch-site": "cross-site" },
  ] as Record<string, string>[]) {
    const deps = dependencies();
    const response = await claimSignupCompletion(request(value, headers), deps);
    expect(response.status).toBe(403);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(deps.sessionUserId).not.toHaveBeenCalled();
  }
  for (const receipt of ["", "a".repeat(65)]) {
    const deps = dependencies();
    const response = await claimSignupCompletion(
      request(value, { "x-tidy-receipt": receipt }),
      deps,
    );
    expect(response.status).toBe(403);
    cookieUnchanged(response);
    expect(deps.authorizeTelemetry).not.toHaveBeenCalled();
  }
  const deps = dependencies(null, false);
  const response = await claimSignupCompletion(request(value), deps);
  expect(response.status).toBe(403);
  cookieUnchanged(response);
  expect(deps.authorizeTelemetry.mock.calls[0]?.[0].headers.get("x-tidy-receipt")).toBeTruthy();
});

test("temporary receipt failures collect nothing and retain the marker for bounded retry", async () => {
  const response = await claimSignupCompletion(request(issue().value), {
    ...dependencies(),
    authorizeTelemetry: async () => {
      throw new Error("temporary fixture fault");
    },
  });
  expect(response.status).toBe(503);
  expect(response.headers.get("set-cookie")).toBeNull();
  expect(await response.text()).toBe("");
});

// Exercise installed Better Auth hooks with a disposable in-memory adapter;
// token exchange is synthetic and no application DB or provider is contacted.
for (const provider of ["google", "github"] as const) {
  test(`${provider}: actual new creation issues a marker; returning login/linking never do`, async () => {
    const records = { user: [], session: [], account: [], verification: [] };
    let email = `${provider}@example.test`;
    let verificationUrl = "";
    const profile = async () => ({
      user: { name: "Fixture", email, emailVerified: true },
      data: { sub: `${provider}-${email}`, id: `${provider}-${email}` },
    });
    const fixture = betterAuth({
      baseURL: origin,
      secret,
      database: memoryAdapter(records),
      advanced: { database: { validateSchema: false } },
      rateLimit: { enabled: false },
      emailAndPassword: { enabled: true, requireEmailVerification: true },
      emailVerification: {
        sendOnSignUp: true,
        autoSignInAfterVerification: true,
        sendVerificationEmail: async ({ url }) => {
          verificationUrl = url;
        },
      },
      socialProviders: {
        [provider]: { clientId: "fixture", clientSecret: "fixture", getUserInfo: profile },
      },
      databaseHooks: {
        user: {
          create: { after: async (user, context) => recordSignupCompletion(user.id, context) },
        },
      },
    });
    const transport = spyOn(globalThis, "fetch").mockImplementation(
      Object.assign(async (input: Parameters<typeof fetch>[0]) => {
        const url = input instanceof Request ? input.url : String(input);
        if (
          ![
            "https://github.com/login/oauth/access_token",
            "https://oauth2.googleapis.com/token",
          ].includes(url)
        )
          throw new Error("Unexpected fixture network request");
        return Response.json({
          access_token: "fixture-access",
          token_type: "Bearer",
          expires_in: 3600,
        });
      }, globalThis.fetch),
    );
    const cookies = (headers: Headers) =>
      headers
        .getSetCookie()
        .map((part) => part.split(";")[0])
        .join("; ");
    const social = async () => {
      const start = await fixture.api.signInSocial({
        body: { provider, callbackURL: "/files" },
        headers: new Headers({ cookie: consentCookie(choices, now) }),
        returnHeaders: true,
      });
      const state = new URL(start.response.url!).searchParams.get("state")!;
      return fixture.handler(
        new Request(
          `${origin}/api/auth/callback/${provider}?code=fixture&state=${encodeURIComponent(state)}`,
          { headers: { cookie: `${cookies(start.headers)}; ${consentCookie(choices, now)}` } },
        ),
      );
    };
    try {
      const created = await social();
      expect(created.status).toBe(302);
      expect(created.headers.get("set-cookie")).toContain(`${SIGNUP_COMPLETION_COOKIE}=`);
      expect((await social()).headers.get("set-cookie")).not.toContain(
        `${SIGNUP_COMPLETION_COOKIE}=`,
      );
      expect(records.user).toHaveLength(1);
      email = `linked-${provider}@example.test`;
      const signup = await fixture.api.signUpEmail({
        body: { name: "Fixture", email, password: "synthetic-long-password" },
        headers: new Headers({ cookie: consentCookie(choices, now) }),
        returnHeaders: true,
      });
      expect(signup.response.token).toBeNull();
      expect(signup.headers.get("set-cookie")).toContain(`${SIGNUP_COMPLETION_COOKIE}=`);
      const verified = await fixture.api.verifyEmail({
        query: { token: new URL(verificationUrl).searchParams.get("token")! },
        headers: new Headers({ cookie: consentCookie(choices, now) }),
        returnHeaders: true,
      });
      expect(verified.headers.get("set-cookie")).not.toContain(`${SIGNUP_COMPLETION_COOKIE}=`);
      const login = await fixture.api.signInEmail({
        body: { email, password: "synthetic-long-password" },
        headers: new Headers({ cookie: consentCookie(choices, now) }),
        returnHeaders: true,
      });
      expect(login.headers.get("set-cookie")).not.toContain(`${SIGNUP_COMPLETION_COOKIE}=`);
      const linked = await social();
      expect(linked.status).toBe(302);
      expect(linked.headers.get("set-cookie")).not.toContain(`${SIGNUP_COMPLETION_COOKIE}=`);
      expect(records.user).toHaveLength(2);
      expect(records.account).toHaveLength(3);
    } finally {
      transport.mockRestore();
    }
  });
}
