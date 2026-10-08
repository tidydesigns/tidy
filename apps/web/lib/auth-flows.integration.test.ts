import { afterAll, beforeAll, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { generateKeyPair, exportJWK, SignJWT, decodeJwt } from "jose";
import { db } from "./db";
import { verificationCallbackPath, authReturnPath, socialSignInError } from "./auth-return-path";

// The harness owns this entire disposable cluster. Never run fixtures against
// an environment file's database or an existing local development database.
const url = process.env.AUTH_TEST_DATABASE_URL;
const enabled = Boolean(
  url &&
  url === process.env.DATABASE_URL &&
  new URL(url).hostname === "127.0.0.1" &&
  new URL(url).pathname === "/tidy_auth_test",
);
const integration = enabled ? test : test.skip;
mock.module("server-only", () => ({}));
let auth: (typeof import("./auth"))["auth"];
const env: Record<string, string | undefined> = process.env;
const keys = [
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "AUTH_GITHUB_CLIENT_ID",
  "AUTH_GITHUB_CLIENT_SECRET",
  "CLOUDFLARE_EMAIL_API_TOKEN",
  "CLOUDFLARE_ACCOUNT_ID",
  "AUTH_EMAIL_FROM",
];
const originalEnvironment = new Map(keys.map((key) => [key, env[key]]));
const originalFetch = globalThis.fetch;
let fetchMock: ReturnType<typeof spyOn<typeof globalThis, "fetch">>;
let deliveries: { to: string[]; subject: string; text: string }[] = [];
let mailStatus = 200;
let identity = { email: "designer@example.test", verified: true, subject: "test-provider-user" };
let signingKey: Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];
let jwk: Awaited<ReturnType<typeof exportJWK>>;
let googleAudience = "test-google-client";
let googleTokenProblem: "signature" | "issuer" | "expired" | null = null;
let tokenRequests: URLSearchParams[] = [];
let nonce: string | undefined;
const origin = "http://localhost:3000";
const password = "disposable-auth-test-password";

function cookie(headers: Headers) {
  return headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
}
function mailUrl() {
  const link = deliveries.at(-1)?.text.match(/https?:\/\/\S+/)?.[0];
  if (!link) throw new Error("Expected a verification link in the test inbox.");
  return new URL(link);
}
async function signUp(email = identity.email, next = "/onboarding/organization") {
  return auth.api.signUpEmail({
    body: { name: "Designer", email, password, callbackURL: verificationCallbackPath(next) },
    returnHeaders: true,
  });
}
async function verify() {
  return auth.api.verifyEmail({
    query: { token: mailUrl().searchParams.get("token")! },
    returnHeaders: true,
  });
}
async function startSocial(provider: "google" | "github", next = "/accept-invitation/test-invite") {
  const result = await auth.api.signInSocial({
    body: { provider, callbackURL: next, newUserCallbackURL: next, errorCallbackURL: "/login" },
    returnHeaders: true,
  });
  const target = new URL(result.response.url!);
  nonce = target.searchParams.get("nonce") ?? undefined;
  return { target, cookie: cookie(result.headers) };
}
async function finishSocial(
  provider: "google" | "github",
  start: Awaited<ReturnType<typeof startSocial>>,
  state = start.target.searchParams.get("state")!,
) {
  return auth.handler(
    new Request(
      `${origin}/api/auth/callback/${provider}?code=test-code&state=${encodeURIComponent(state)}`,
      { headers: { cookie: start.cookie } },
    ),
  );
}

beforeAll(async () => {
  if (!enabled) return;
  env.GOOGLE_CLIENT_ID = "test-google-client";
  env.GOOGLE_CLIENT_SECRET = "test-google-secret";
  env.AUTH_GITHUB_CLIENT_ID = "test-github-client";
  env.AUTH_GITHUB_CLIENT_SECRET = "test-github-secret";
  env.CLOUDFLARE_EMAIL_API_TOKEN = "test-mail-key";
  env.CLOUDFLARE_ACCOUNT_ID = "auth-test";
  env.AUTH_EMAIL_FROM = "Tidy <accounts@example.test>";
  const pair = await generateKeyPair("RS256", { extractable: true });
  signingKey = pair.privateKey;
  jwk = { ...(await exportJWK(pair.publicKey)), kid: "test-google-key", alg: "RS256", use: "sig" };
  fetchMock = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const target = input instanceof Request ? input.url : String(input);
        if (
          target === "https://api.cloudflare.com/client/v4/accounts/auth-test/email/sending/send"
        ) {
          const delivery = JSON.parse(String(init?.body));
          deliveries.push(delivery);
          return Response.json(
            mailStatus === 200
              ? { success: true, result: { delivered: delivery.to } }
              : { success: false },
            { status: mailStatus },
          );
        }
        if (target === "https://oauth2.googleapis.com/token") {
          tokenRequests.push(new URLSearchParams(String(init?.body)));
          const idToken = await new SignJWT({
            sub: identity.subject,
            email: identity.email,
            email_verified: identity.verified,
            name: "Google Designer",
            ...(nonce ? { nonce } : {}),
          })
            .setProtectedHeader({ alg: "RS256", kid: "test-google-key" })
            .setIssuer(
              googleTokenProblem === "issuer"
                ? "https://other-issuer.example"
                : "https://accounts.google.com",
            )
            .setAudience(googleAudience)
            .setIssuedAt()
            .setExpirationTime(
              googleTokenProblem === "expired" ? Math.floor(Date.now() / 1000) - 10 : "1h",
            )
            .sign(
              googleTokenProblem === "signature"
                ? (await generateKeyPair("RS256")).privateKey
                : signingKey,
            );
          return Response.json({
            access_token: "test-google-access-token",
            token_type: "Bearer",
            expires_in: 3600,
            id_token: idToken,
          });
        }
        if (target === "https://www.googleapis.com/oauth2/v3/certs")
          return Response.json({ keys: [jwk] });
        if (target === "https://github.com/login/oauth/access_token") {
          tokenRequests.push(new URLSearchParams(String(init?.body)));
          return Response.json({
            access_token: "test-github-access-token",
            token_type: "bearer",
            scope: "read:user,user:email",
          });
        }
        // GitHub's public profile has no address; exercise private primary email lookup.
        if (target === "https://api.github.com/user")
          return Response.json({
            id: identity.subject,
            login: "designer",
            name: "GitHub Designer",
            email: null,
          });
        if (target === "https://api.github.com/user/emails")
          return Response.json([
            {
              email: identity.email,
              primary: true,
              verified: identity.verified,
              visibility: "private",
            },
          ]);
        if (target === `${origin}/api/auth/jwks`) return auth.handler(new Request(target));
        throw new Error(
          `Unexpected network request in isolated auth tests: ${new URL(target).origin}`,
        );
      },
      { preconnect: originalFetch.preconnect },
    ),
  );
  await db.query("drop schema public cascade; create schema public");
  for (const file of [
    "schema.sql",
    "schema-organization.sql",
    "schema-vault.sql",
    "schema-mcp.sql",
  ]) {
    await db.query(await readFile(new URL(`../../../migrations/${file}`, import.meta.url), "utf8"));
  }
  ({ auth } = await import("./auth"));
});
beforeEach(async () => {
  if (!enabled) return;
  await db.query('truncate "user", "verification" cascade');
  deliveries = [];
  mailStatus = 200;
  tokenRequests = [];
  identity = { email: "designer@example.test", verified: true, subject: "test-provider-user" };
  googleAudience = "test-google-client";
  googleTokenProblem = null;
});
afterAll(async () => {
  if (!enabled) return;
  fetchMock.mockRestore();
  for (const [key, value] of originalEnvironment) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  await db.end();
});

integration("sign-up sends a one-hour verification link and creates no session", async () => {
  const result = await signUp();
  expect(result.response.user.emailVerified).toBe(false);
  expect(result.response.token).toBeNull();
  expect(cookie(result.headers)).not.toContain("session_token");
  expect((await db.query('select * from "session"')).rowCount).toBe(0);
  expect(deliveries).toHaveLength(1);
  const link = mailUrl();
  expect(link.pathname).toBe("/api/auth/verify-email");
  expect(link.searchParams.get("callbackURL")).toBe(
    verificationCallbackPath("/onboarding/organization"),
  );
  const payload = decodeJwt(link.searchParams.get("token")!);
  expect(payload.exp! - payload.iat!).toBe(3600);
  expect(await auth.api.getSession({ headers: new Headers() })).toBeNull();
});

integration(
  "password sign-in resends verification and cannot create a session before verification",
  async () => {
    await signUp();
    await expect(
      auth.api.signInEmail({
        body: { email: identity.email, password, callbackURL: verificationCallbackPath("/") },
      }),
    ).rejects.toMatchObject({ body: { code: "EMAIL_NOT_VERIFIED" } });
    expect(deliveries).toHaveLength(2);
    expect((await db.query('select * from "session"')).rowCount).toBe(0);
    await expect(
      auth.api.signInEmail({ body: { email: identity.email, password: "wrong-password" } }),
    ).rejects.toBeDefined();
    expect(deliveries).toHaveLength(2);
  },
);

integration("verification signs in and preserves invitation and MCP destinations", async () => {
  for (const next of [
    "/accept-invitation/test-invite",
    "/mcp/consent?client_id=test&scope=mcp%3Aread",
  ]) {
    await db.query('truncate "user" cascade');
    await signUp(identity.email, next);
    const link = mailUrl();
    const response = await auth.handler(new Request(link));
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(verificationCallbackPath(next));
    const session = await auth.api.getSession({
      headers: new Headers({ cookie: cookie(response.headers) }),
    });
    expect(session?.user).toMatchObject({ email: identity.email, emailVerified: true });
    expect(
      (await auth.api.signInEmail({ body: { email: identity.email, password } })).user.id,
    ).toBe(session!.user.id);
  }
});

integration(
  "expired and tampered verification tokens cannot verify or create sessions",
  async () => {
    await signUp();
    const token = mailUrl().searchParams.get("token")!;
    const expired = await new SignJWT({ email: identity.email })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) - 10)
      .sign(new TextEncoder().encode(env.BETTER_AUTH_SECRET));
    for (const invalid of [token + "tampered", expired]) {
      const response = await auth.handler(
        new Request(
          `${origin}/api/auth/verify-email?token=${encodeURIComponent(invalid)}&callbackURL=${encodeURIComponent(verificationCallbackPath("/"))}`,
        ),
      );
      expect(response.status).toBe(302);
      expect(
        new URL(response.headers.get("location")!, origin).searchParams.get("error"),
      ).toBeTruthy();
      expect(cookie(response.headers)).not.toContain("session_token");
    }
    expect((await db.query('select "emailVerified" from "user"')).rows[0].emailVerified).toBe(
      false,
    );
  },
);

integration("resend avoids revealing unknown and already verified accounts", async () => {
  await signUp();
  await verify();
  deliveries = [];
  const known = await auth.api.sendVerificationEmail({
    body: { email: identity.email, callbackURL: verificationCallbackPath("/") },
  });
  const unknown = await auth.api.sendVerificationEmail({
    body: { email: "unknown@example.test", callbackURL: verificationCallbackPath("/") },
  });
  expect(known).toEqual(unknown);
  expect(deliveries).toHaveLength(0);
});

integration("delivery failure rolls back sign-up and a retry can recover", async () => {
  mailStatus = 422;
  await expect(signUp()).rejects.toThrow("Could not send the email");
  expect((await db.query('select * from "user"')).rowCount).toBe(0);
  expect((await db.query('select * from "session"')).rowCount).toBe(0);
  mailStatus = 200;
  await signUp();
  const verified = await verify();
  expect(
    await auth.api.getSession({ headers: new Headers({ cookie: cookie(verified.headers) }) }),
  ).not.toBeNull();
});

integration("failed resend reports the delivery error without verifying the account", async () => {
  await signUp();
  mailStatus = 422;
  await expect(
    auth.api.sendVerificationEmail({
      body: { email: identity.email, callbackURL: verificationCallbackPath("/") },
    }),
  ).rejects.toThrow("Could not send the email");
  expect((await db.query('select "emailVerified" from "user"')).rows[0].emailVerified).toBe(false);
  expect((await db.query('select * from "session"')).rowCount).toBe(0);
});

integration(
  "legacy unverified cookies cannot read sessions, mutate accounts or accept invitations",
  async () => {
    const account = await signUp();
    const result = await verify();
    const headers = new Headers({ cookie: cookie(result.headers) });
    await db.query('update "user" set "emailVerified"=false where "id"=$1', [
      account.response.user.id,
    ]);
    expect(await auth.api.getSession({ headers })).toBeNull();
    const sessionResponse = await auth.handler(
      new Request(`${origin}/api/auth/get-session`, { headers }),
    );
    expect(await sessionResponse.json()).toBeNull();
    await expect(auth.api.updateUser({ headers, body: { name: "Forged" } })).rejects.toMatchObject({
      body: { code: "EMAIL_NOT_VERIFIED" },
    });
    await expect(
      auth.api.acceptInvitation({ headers, body: { invitationId: "any-invitation" } }),
    ).rejects.toMatchObject({ body: { code: "EMAIL_NOT_VERIFIED" } });
    await auth.api.sendVerificationEmail({
      headers,
      body: { email: identity.email, callbackURL: verificationCallbackPath("/") },
    });
    await verify();
    expect((await auth.api.getSession({ headers }))?.user.emailVerified).toBe(true);
  },
);

integration("legacy MCP grants cannot authorize an account whose email is unverified", async () => {
  const account = await signUp();
  const verified = await verify();
  const session = (await auth.api.getSession({
    headers: new Headers({ cookie: cookie(verified.headers) }),
  }))!;
  const registered = await auth.handler(
    new Request(`${origin}/api/auth/oauth2/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: "Verification test agent",
        redirect_uris: ["http://127.0.0.1:4319/callback"],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code"],
        response_types: ["code"],
        scope: "mcp:read",
      }),
    }),
  );
  expect(registered.status).toBe(201);
  const client = (await registered.json()) as { client_id: string };
  const resource = `${origin}/api/mcp`;
  await db.query(
    `insert into "oauthConsent" ("id","clientId","userId","resources","scopes","createdAt","updatedAt")
    values ($1,$2,$3,$4::jsonb,'["mcp:read"]',now(),now())`,
    [crypto.randomUUID(), client.client_id, account.response.user.id, JSON.stringify([resource])],
  );
  const claims = {
    sub: account.response.user.id,
    client_id: client.client_id,
    sid: session.session.id,
    exp: Math.floor(Date.now() / 1000) + 900,
  };
  const { hasMcpAuthorization } = await import("./mcp/authorizations");
  expect(await hasMcpAuthorization(claims, resource)).toBe(true);
  await db.query('update "user" set "emailVerified"=false where "id"=$1', [
    account.response.user.id,
  ]);
  expect(await hasMcpAuthorization(claims, resource)).toBe(false);
});

for (const provider of ["google", "github"] as const) {
  integration(
    `${provider} completes verified social sign-up using the real provider adapter`,
    async () => {
      const start = await startSocial(provider);
      expect(start.target.searchParams.get("client_id")).toBe(`test-${provider}-client`);
      expect(start.target.searchParams.get("redirect_uri")).toBe(
        `${origin}/api/auth/callback/${provider}`,
      );
      expect(start.target.searchParams.get("state")).toBeTruthy();
      if (provider === "google") {
        expect(start.target.searchParams.get("code_challenge_method")).toBe("S256");
        expect(start.target.searchParams.get("code_challenge")).toBeTruthy();
      }
      const response = await finishSocial(provider, start);
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("/accept-invitation/test-invite");
      const session = await auth.api.getSession({
        headers: new Headers({ cookie: cookie(response.headers) }),
      });
      expect(session?.user).toMatchObject({ email: identity.email, emailVerified: true });
      expect(deliveries).toHaveLength(0);
      const stored = (
        await db.query('select "accessToken" from "account" where "providerId"=$1', [provider])
      ).rows[0];
      expect(stored.accessToken).not.toBe(`test-${provider}-access-token`);
      expect(tokenRequests[0].get("redirect_uri")).toBe(`${origin}/api/auth/callback/${provider}`);
      if (provider === "google") expect(tokenRequests[0].get("code_verifier")).toBeTruthy();
      const replay = await finishSocial(provider, start);
      expect(
        new URL(replay.headers.get("location")!, origin).searchParams.get("error"),
      ).toBeTruthy();
      expect(tokenRequests).toHaveLength(1);
    },
  );

  integration(`${provider} rejects an unverified provider email`, async () => {
    identity.verified = false;
    const response = await finishSocial(provider, await startSocial(provider));
    expect(new URL(response.headers.get("location")!, origin).searchParams.get("error")).toBe(
      "email_not_verified",
    );
    expect((await db.query('select * from "user"')).rowCount).toBe(0);
    expect(cookie(response.headers)).not.toContain("session_token");
  });

  integration(`${provider} lets any verified email sign in to an existing account`, async () => {
    identity.email = "another-designer@example.test";
    const first = await finishSocial(provider, await startSocial(provider));
    const firstSession = await auth.api.getSession({
      headers: new Headers({ cookie: cookie(first.headers) }),
    });
    expect(firstSession?.user).toMatchObject({ email: identity.email, emailVerified: true });
    const response = await finishSocial(provider, await startSocial(provider));
    expect(response.headers.get("location")).toBe("/accept-invitation/test-invite");
    const session = await auth.api.getSession({
      headers: new Headers({ cookie: cookie(response.headers) }),
    });
    expect(session?.user.id).toBe(firstSession!.user.id);
    expect((await db.query('select * from "user"')).rowCount).toBe(1);
  });

  integration(
    `${provider} links to a verified password account without a duplicate user`,
    async () => {
      const existing = await signUp();
      await verify();
      const response = await finishSocial(provider, await startSocial(provider));
      const session = await auth.api.getSession({
        headers: new Headers({ cookie: cookie(response.headers) }),
      });
      expect(session?.user.id).toBe(existing.response.user.id);
      expect((await db.query('select * from "user"')).rowCount).toBe(1);
      expect((await db.query('select * from "account"')).rowCount).toBe(2);
    },
  );

  integration(
    `${provider} cannot attach to a pre-registered unverified password account`,
    async () => {
      await signUp();
      const response = await finishSocial(provider, await startSocial(provider));
      expect(new URL(response.headers.get("location")!, origin).searchParams.get("error")).toBe(
        "account_not_linked",
      );
      expect((await db.query('select * from "account"')).rowCount).toBe(1);
      expect((await db.query('select * from "session"')).rowCount).toBe(0);
    },
  );

  integration(`${provider} rejects a callback with the wrong state`, async () => {
    const response = await finishSocial(provider, await startSocial(provider), "wrong-state");
    expect(response.status).toBe(302);
    expect(
      new URL(response.headers.get("location")!, origin).searchParams.get("error"),
    ).toBeTruthy();
    expect(tokenRequests).toHaveLength(0);
    expect((await db.query('select * from "session"')).rowCount).toBe(0);
  });
}

integration("Google rejects an ID token issued to another client", async () => {
  googleAudience = "another-google-client";
  const response = await finishSocial("google", await startSocial("google"));
  expect(new URL(response.headers.get("location")!, origin).searchParams.get("error")).toBeTruthy();
  expect((await db.query('select * from "session"')).rowCount).toBe(0);
});

for (const problem of ["signature", "issuer", "expired"] as const) {
  integration(`Google rejects an ID token with invalid ${problem}`, async () => {
    googleTokenProblem = problem;
    const response = await finishSocial("google", await startSocial("google"));
    expect(
      new URL(response.headers.get("location")!, origin).searchParams.get("error"),
    ).toBeTruthy();
    expect((await db.query('select * from "session"')).rowCount).toBe(0);
  });
}

integration(
  "an already-used verification link does not create another anonymous session",
  async () => {
    await signUp();
    const token = mailUrl().searchParams.get("token")!;
    await verify();
    const repeated = await auth.api.verifyEmail({ query: { token }, returnHeaders: true });
    expect(cookie(repeated.headers)).not.toContain("session_token");
    expect((await db.query('select * from "session"')).rowCount).toBe(1);
  },
);

test("auth destinations and provider errors remain bounded", () => {
  expect(authReturnPath("/onboarding/organization", "/")).toBe("/onboarding/organization");
  for (const value of [
    "https://evil.example",
    "//evil.example",
    "/\\evil.example",
    "/login?next=https://evil.example",
  ]) {
    expect(authReturnPath(value, "/")).toBe("/");
    expect(verificationCallbackPath(value)).toBe("/verify-email?next=%2F");
  }
  expect(socialSignInError("arbitrary-provider-details")).not.toContain(
    "arbitrary-provider-details",
  );
  expect(socialSignInError("account_not_linked")).toContain("inbox link");
});

test("provider configuration requires both dedicated credentials and does not reuse connector keys", async () => {
  const { socialProviderConfiguration, enabledSocialProviders } = await import("./auth-social");
  const previous = new Map(keys.map((key) => [key, env[key]]));
  try {
    for (const key of keys.slice(0, 4)) delete env[key];
    expect(socialProviderConfiguration()).toEqual({});
    expect(enabledSocialProviders()).toEqual([]);
    env.GOOGLE_CLIENT_ID = "only-id";
    env.AUTH_GITHUB_CLIENT_SECRET = "only-secret";
    expect(enabledSocialProviders()).toEqual([]);
    env.GOOGLE_CLIENT_SECRET = " google-secret ";
    env.AUTH_GITHUB_CLIENT_ID = "github-id";
    expect(enabledSocialProviders()).toEqual(["google", "github"]);
    expect(socialProviderConfiguration().google?.clientSecret).toBe("google-secret");
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete env[key];
      else env[key] = value;
    }
  }
});
