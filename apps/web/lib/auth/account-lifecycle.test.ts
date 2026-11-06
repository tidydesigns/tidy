import { expect, test } from "bun:test";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { createAuthClient } from "better-auth/client";
import { SignJWT } from "jose";

const origin = "http://localhost:43567";
const secret = "dummy-account-lifecycle-test-secret-0123456789";

function fixture() {
  const messages: { kind: "confirmation" | "verification"; email: string; url: string }[] = [];
  const memory = memoryAdapter({ user: [], session: [], account: [], verification: [] });
  let failDeletion = false;
  let failDeletionLookup = false;
  let sessionCreation:
    | {
        entered: ReturnType<typeof Promise.withResolvers<void>>;
        release: ReturnType<typeof Promise.withResolvers<void>>;
      }
    | undefined;
  const database: typeof memory = (options) => {
    const adapter = memory(options);
    return {
      ...adapter,
      async create(input) {
        if (input.model === "session" && sessionCreation) {
          const paused = sessionCreation;
          sessionCreation = undefined;
          paused.entered.resolve();
          await paused.release.promise;
        }
        return adapter.create(input);
      },
      async findMany(input) {
        if (failDeletionLookup && input.model === "session")
          throw new Error("Test session lookup unavailable");
        return adapter.findMany(input);
      },
      async delete(input) {
        if (failDeletion && input.model === "session") throw new Error("Test deletion unavailable");
        return adapter.delete(input);
      },
    };
  };
  const auth = betterAuth({
    baseURL: origin,
    secret,
    database,
    logger: { disabled: true },
    emailAndPassword: { enabled: true, requireEmailVerification: true },
    user: {
      changeEmail: {
        enabled: true,
        updateEmailWithoutVerification: false,
        async sendChangeEmailConfirmation({ user, url }) {
          messages.push({ kind: "confirmation", email: user.email, url });
        },
      },
    },
    emailVerification: {
      expiresIn: 3600,
      sendOnSignUp: true,
      autoSignInAfterVerification: true,
      async sendVerificationEmail({ user, url }) {
        messages.push({ kind: "verification", email: user.email, url });
      },
    },
    databaseHooks: {
      session: {
        create: {
          async before({ userId }, context) {
            const user = await context?.context.internalAdapter.findUserById(userId);
            if (!user?.emailVerified) throw new Error("Verify your email before signing in.");
          },
        },
      },
    },
  });
  function request(path: string, body?: object, cookie?: string) {
    const headers = new Headers({ origin });
    if (body) headers.set("content-type", "application/json");
    if (cookie) headers.set("cookie", cookie);
    return auth.handler(
      new Request(`${origin}/api/auth${path}`, {
        method: body ? "POST" : "GET",
        headers,
        body: body ? JSON.stringify(body) : undefined,
      }),
    );
  }
  function cookie(response: Response) {
    return response.headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .filter((value) => !value.endsWith("="))
      .join("; ");
  }
  function message(kind: "confirmation" | "verification", email: string) {
    const result = messages.findLast((message) => message.kind === kind && message.email === email);
    if (!result) throw new Error("Expected test email was not sent.");
    return result.url;
  }
  function follow(link: string, cookie?: string) {
    const url = new URL(link);
    return request(`${url.pathname.slice("/api/auth".length)}${url.search}`, undefined, cookie);
  }
  function session(cookie: string) {
    return auth.api.getSession({ headers: new Headers({ cookie }) });
  }
  async function signup(email: string) {
    expect(
      (
        await request("/sign-up/email", {
          email,
          name: "Test user",
          password: "dummy-password-123456789",
        })
      ).status,
    ).toBe(200);
    const verified = await follow(message("verification", email));
    expect(verified.status).toBeLessThan(400);
    const value = cookie(verified);
    const signedIn = await session(value);
    if (!signedIn) throw new Error("Expected a verified test session.");
    return { cookie: value, id: signedIn.user.id };
  }
  async function change(from: string, to: string, cookie: string) {
    expect((await request("/change-email", { newEmail: to }, cookie)).status).toBe(200);
    expect((await follow(message("confirmation", from))).status).toBeLessThan(400);
    const verified = await follow(message("verification", to));
    expect(verified.status).toBeLessThan(400);
    return verified;
  }
  return {
    request,
    cookie,
    message,
    follow,
    session,
    signup,
    change,
    client(cookie: string) {
      return createAuthClient({
        baseURL: origin,
        fetchOptions: {
          customFetchImpl: Object.assign(
            async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
              const request = new Request(input, init);
              request.headers.set("origin", origin);
              request.headers.set("cookie", cookie);
              return auth.handler(request);
            },
            { preconnect: fetch.preconnect },
          ),
        },
      });
    },
    failDeletionLookup(value: boolean) {
      failDeletionLookup = value;
    },
    failDeletion(value: boolean) {
      failDeletion = value;
    },
    pauseNextSessionCreation() {
      const entered = Promise.withResolvers<void>(),
        release = Promise.withResolvers<void>();
      sessionCreation = { entered, release };
      return { entered: entered.promise, release: release.resolve };
    },
  };
}

test("both stages of email change stay bound to the original account after address reuse", async () => {
  const f = fixture();
  const alice = await f.signup("original@example.test");
  const bob = await f.signup("successor@example.test");
  expect(alice.id).not.toBe(bob.id);
  expect(
    (await f.request("/change-email", { newEmail: "retained@example.test" }, alice.cookie)).status,
  ).toBe(200);
  const confirmation = f.message("confirmation", "original@example.test");
  expect((await f.follow(confirmation)).status).toBeLessThan(400);
  const verification = f.message("verification", "retained@example.test");

  const moved = await f.change("original@example.test", "moved@example.test", alice.cookie);
  expect((await f.session(f.cookie(moved)))?.user.id).toBe(alice.id);
  const reassigned = await f.change("successor@example.test", "original@example.test", bob.cookie);
  const bobCookie = f.cookie(reassigned);
  expect((await f.session(bobCookie))?.user.id).toBe(bob.id);
  for (const link of [confirmation, verification]) {
    const rejected = await f.follow(link);
    expect(rejected.headers.get("location")).toContain("error=INVALID_TOKEN");
    expect(f.cookie(rejected)).toBe("");
  }
  expect((await f.session(bobCookie))?.user.email).toBe("original@example.test");
  expect((await f.session(f.cookie(moved)))?.user.email).toBe("moved@example.test");
});

test("legacy unbound email-change links are rejected while ordinary verification still works", async () => {
  const f = fixture();
  const account = await f.signup("legacy@example.test");
  const token = await new SignJWT({
    email: "legacy@example.test",
    updateTo: "unbound@example.test",
    requestType: "change-email-verification",
  })
    .setProtectedHeader({ alg: "HS256" })
    .setExpirationTime("1h")
    .sign(new TextEncoder().encode(secret));
  const response = await f.request(`/verify-email?token=${token}`);
  expect(response.status).toBe(401);
  expect((await f.session(account.cookie))?.user.email).toBe("legacy@example.test");
});

test("email change cannot mutate a successor account when address reuse occurs after proof validation", async () => {
  const f = fixture();
  const alice = await f.signup("original@example.test");
  const bob = await f.signup("successor@example.test");
  await f.request("/change-email", { newEmail: "retained@example.test" }, alice.cookie);
  await f.follow(f.message("confirmation", "original@example.test"));
  const paused = f.pauseNextSessionCreation();
  const redeeming = f.follow(f.message("verification", "retained@example.test"));
  let bobCookie = "";
  try {
    await paused.entered;
    await f.change("original@example.test", "moved@example.test", alice.cookie);
    bobCookie = f.cookie(
      await f.change("successor@example.test", "original@example.test", bob.cookie),
    );
  } finally {
    paused.release();
  }
  const redeemed = await redeeming;
  expect((await f.session(f.cookie(redeemed)))?.user.id).toBe(alice.id);
  expect((await f.session(bobCookie))?.user.email).toBe("original@example.test");
});

test("failed session revocation reports failure, retains retry capability and normal sign-out revokes", async () => {
  const f = fixture();
  const account = await f.signup("logout@example.test");
  f.failDeletion(true);
  const failed = await f.request("/sign-out", {}, account.cookie);
  expect(failed.status).toBe(503);
  expect(failed.headers.getSetCookie().some((value) => value.includes("Max-Age=0"))).toBe(false);
  f.failDeletion(false);
  expect((await f.session(account.cookie))?.user.id).toBe(account.id);
  const retried = await f.request("/sign-out", {}, account.cookie);
  expect(retried.status).toBe(200);
  expect(retried.headers.getSetCookie().some((value) => value.includes("Max-Age=0"))).toBe(true);
  expect(await f.session(account.cookie)).toBeNull();
  expect((await f.request("/sign-out", {})).status).toBe(200);
});

test("the authentication client keeps normal email changes compatible with the existing flow", async () => {
  const f = fixture();
  const account = await f.signup("before@example.test");
  const result = await f.client(account.cookie).changeEmail({ newEmail: "after@example.test" });
  expect(result.error).toBeNull();
  expect(result.data).toEqual({ status: true });
  expect((await f.session(account.cookie))?.user.email).toBe("before@example.test");
  await f.follow(f.message("confirmation", "before@example.test"));
  const verified = await f.follow(f.message("verification", "after@example.test"));
  expect((await f.session(f.cookie(verified)))?.user).toMatchObject({
    id: account.id,
    email: "after@example.test",
    emailVerified: true,
  });
});

test("the sign-out client returns the error the existing UI handles and succeeds on retry", async () => {
  const f = fixture();
  const account = await f.signup("client@example.test");
  const client = f.client(account.cookie);
  f.failDeletion(true);
  const failed = await client.signOut();
  expect(failed.data).toBeNull();
  expect(failed.error).toMatchObject({
    status: 503,
    message: "Unable to sign out. Please try again.",
  });
  f.failDeletion(false);
  expect((await f.session(account.cookie))?.user.id).toBe(account.id);
  const retried = await client.signOut();
  expect(retried.error).toBeNull();
  expect(retried.data).toMatchObject({ success: true });
  expect(retried.data?.url).toBeUndefined();
  expect(retried.data?.redirect).toBeUndefined();
  expect(await f.session(account.cookie)).toBeNull();
});

test("failed revocation lookup retains the session cookie and allows a successful retry", async () => {
  const f = fixture();
  const account = await f.signup("lookup@example.test");
  f.failDeletionLookup(true);
  const failed = await f.request("/sign-out", {}, account.cookie);
  expect(failed.status).toBe(503);
  expect(failed.headers.getSetCookie().some((value) => value.includes("Max-Age=0"))).toBe(false);
  f.failDeletionLookup(false);
  expect((await f.session(account.cookie))?.user.id).toBe(account.id);
  expect((await f.request("/sign-out", {}, account.cookie)).status).toBe(200);
  expect(await f.session(account.cookie)).toBeNull();
});

for (const kind of ["confirmation", "verification"] as const) {
  test(`email-change ${kind} accepts its account session and rejects a different signed-in account`, async () => {
    const f = fixture();
    const alice = await f.signup("alice@example.test");
    const bob = await f.signup("bob@example.test");
    await f.request("/change-email", { newEmail: "changed@example.test" }, alice.cookie);
    const confirmation = f.message("confirmation", "alice@example.test");
    if (kind === "verification") await f.follow(confirmation, alice.cookie);
    const link =
      kind === "confirmation" ? confirmation : f.message("verification", "changed@example.test");
    const rejected = await f.follow(link, bob.cookie);
    expect(rejected.headers.get("location")).toContain("error=INVALID_USER");
    expect(f.cookie(rejected)).toBe("");
    expect((await f.session(alice.cookie))?.user.email).toBe("alice@example.test");
    expect((await f.session(bob.cookie))?.user.email).toBe("bob@example.test");
    const accepted = await f.follow(link, alice.cookie);
    expect(accepted.status).toBeLessThan(400);
    if (kind === "verification") {
      expect((await f.session(f.cookie(accepted)))?.user).toMatchObject({
        id: alice.id,
        email: "changed@example.test",
        emailVerified: true,
      });
    } else {
      const verified = await f.follow(
        f.message("verification", "changed@example.test"),
        alice.cookie,
      );
      expect((await f.session(f.cookie(verified)))?.user.id).toBe(alice.id);
    }
  });
}

test("sign-out of an already revoked session remains idempotent", async () => {
  const f = fixture();
  const account = await f.signup("repeat@example.test");
  expect((await f.request("/sign-out", {}, account.cookie)).status).toBe(200);
  expect(await f.session(account.cookie)).toBeNull();
  const repeated = await f.request("/sign-out", {}, account.cookie);
  expect(repeated.status).toBe(200);
  expect(repeated.headers.getSetCookie().some((value) => value.includes("Max-Age=0"))).toBe(true);
});
