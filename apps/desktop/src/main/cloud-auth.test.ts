import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { connect } from "node:net";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CloudAuth, cloudOrigin, type CredentialProtection } from "./cloud-auth";
import { PrivateState } from "./private-state";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const protection: CredentialProtection = {
  available: () => true,
  // An injected test double for Electron safeStorage; production never uses this codec.
  encrypt: (value) => Buffer.from(value.split("").reverse().join("")),
  decrypt: (value) => value.toString().split("").reverse().join(""),
};
async function fixture(beforeCallback?: (callback: URL) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "tidy-cloud-auth-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const state = new PrivateState(directory);
  await state.initialize();
  let authorization: URL | undefined;
  let refreshes = 0,
    registrations = 0;
  let beforeRefresh: (() => Promise<void>) | undefined;
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/oauth2/register")) {
      registrations++;
      const registration = JSON.parse(String(init?.body));
      expect(registration.token_endpoint_auth_method).toBe("none");
      expect(registration.scope).toBe("desktop:sync offline_access");
      expect(registration.resources).toEqual(["https://example.test/api/desktop"]);
      return Response.json({ client_id: "desktop-fixture" });
    }
    if (url.endsWith("/oauth2/token")) {
      const body = init?.body as URLSearchParams;
      expect(body.get("resource")).toBe("https://example.test/api/desktop");
      if (body.get("grant_type") === "authorization_code") {
        expect(body.get("code")).toBe("single-use-code");
        expect(createHash("sha256").update(body.get("code_verifier")!).digest("base64url")).toBe(
          authorization!.searchParams.get("code_challenge")!,
        );
      } else {
        refreshes++;
        await beforeRefresh?.();
      }
      return Response.json({
        access_token: "access-fixture-value",
        refresh_token: "refresh-fixture-value",
        expires_in: 30,
        token_type: "Bearer",
      });
    }
    if (url.endsWith("/oauth2/revoke")) return Response.json({});
    if (url.endsWith("/api/desktop/account"))
      return Response.json({ id: "alice", organizations: [] });
    throw new Error(`Unexpected auth request: ${url}`);
  }) as typeof fetch;
  const auth = new CloudAuth(
    "https://example.test",
    state,
    protection,
    async (url) => {
      authorization = new URL(url);
      expect(authorization.searchParams.get("code_challenge_method")).toBe("S256");
      const callback = new URL(authorization.searchParams.get("redirect_uri")!);
      await beforeCallback?.(callback);
      expect(callback.hostname).toBe("127.0.0.1");
      const wrong = new URL(callback);
      wrong.searchParams.set("state", "wrong-state");
      wrong.searchParams.set("code", "single-use-code");
      expect((await fetch(wrong)).status).toBe(400);
      callback.searchParams.set("state", authorization.searchParams.get("state")!);
      callback.searchParams.set("code", "single-use-code");
      expect((await fetch(callback)).status).toBe(200);
    },
    fetcher,
  );
  await auth.initialize();
  return {
    auth,
    state,
    directory,
    fetcher,
    registrations: () => registrations,
    refreshes: () => refreshes,
    pauseRefresh: (callback: () => Promise<void>) => {
      beforeRefresh = callback;
    },
  };
}

test("native login binds the callback to state and PKCE and protects persisted credentials", async () => {
  const f = await fixture();
  await f.auth.signIn();
  expect(f.auth.accountId).toBe("alice");
  const stored = await readFile(join(f.directory, "credentials.json"), "utf8");
  expect(stored).not.toContain("access-fixture-value");
  expect(stored).not.toContain("refresh-fixture-value");
  const restored = new CloudAuth(
    "https://example.test",
    f.state,
    protection,
    async () => {},
    f.fetcher,
  );
  await restored.initialize();
  expect(restored.accountId).toBe("alice");
  const anotherOrigin = new CloudAuth(
    "https://other.test",
    f.state,
    protection,
    async () => {},
    f.fetcher,
  );
  await anotherOrigin.initialize();
  expect(anotherOrigin.accountId).toBeUndefined();
});

test("malformed loopback targets return 400 without interrupting the valid PKCE login", async () => {
  const f = await fixture(async (callback) => {
    const response = await new Promise<string>((resolve, reject) => {
      const socket = connect(Number(callback.port), "127.0.0.1", () => {
        socket.write("GET http://[ HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n");
      });
      let body = "";
      socket.setEncoding("utf8");
      socket.setTimeout(1000, () => socket.destroy(new Error("Callback timed out")));
      socket.on("data", (data) => {
        body += data;
      });
      socket.on("error", reject);
      socket.on("end", () => resolve(body));
    });
    expect(response).toStartWith("HTTP/1.1 400");
  });
  await f.auth.signIn();
  expect(f.auth.accountId).toBe("alice");
});

test("Retry-After blocks subsequent native API requests across files without another network call", async () => {
  const f = await fixture();
  await f.auth.signIn();
  let calls = 0;
  const throttled = new CloudAuth(
    "https://example.test",
    f.state,
    protection,
    async () => {},
    (async (input, init) => {
      if (String(input).includes("/api/desktop/")) {
        calls++;
        return new Response(null, { status: 429, headers: { "Retry-After": "120" } });
      }
      return f.fetcher(input, init);
    }) as typeof fetch,
  );
  await throttled.initialize();
  await expect(throttled.request("/api/desktop/account")).rejects.toMatchObject({
    status: 429,
    retryAfterMs: 120_000,
  });
  await expect(throttled.request("/api/desktop/manifest")).rejects.toMatchObject({ status: 429 });
  expect(calls).toBe(1);
});

test("concurrent cloud requests share a single refresh-token rotation", async () => {
  const f = await fixture();
  await Promise.all([f.auth.signIn(), f.auth.signIn()]);
  expect(f.registrations()).toBe(1);
  await Promise.all([
    f.auth.request("/api/desktop/account"),
    f.auth.request("/api/desktop/account"),
  ]);
  expect(f.refreshes()).toBe(1);
});

test("signing back in reuses the registered native client without retaining account tokens", async () => {
  const f = await fixture();
  await f.auth.signIn();
  await f.auth.signOut();
  expect(await f.state.read("credentials")).toBeUndefined();
  await f.auth.signIn();
  expect(f.auth.accountId).toBe("alice");
  expect(f.registrations()).toBe(1);
});

test("signing out during refresh cannot restore credentials or send the queued request", async () => {
  const f = await fixture();
  await f.auth.signIn();
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.pauseRefresh(async () => {
    entered();
    await gate;
  });
  const request = f.auth.request("/api/desktop/account");
  void request.catch(() => {});
  await started;
  await f.auth.signOut();
  release();
  await expect(request).rejects.toThrow("Sign in");
  expect(f.auth.accountId).toBeUndefined();
  expect(await f.state.read("credentials")).toBeUndefined();
});

test("protected storage is required and cloud origins cannot downgrade to arbitrary HTTP", async () => {
  expect(() => cloudOrigin("http://example.test")).toThrow();
  expect(() => cloudOrigin("https://user:password@example.test")).toThrow();
  expect(() => cloudOrigin("https://example.test/arbitrary")).toThrow();
  expect(cloudOrigin("http://127.0.0.1:3000")).toBe("http://127.0.0.1:3000");
  const f = await fixture();
  const unprotected = new CloudAuth(
    "https://example.test",
    f.state,
    { ...protection, available: () => false },
    async () => {},
    f.fetcher,
  );
  await expect(unprotected.signIn()).rejects.toThrow("protected credential storage");
  expect(await f.state.read("credentials")).toBeUndefined();
});

test("cancelling sign-in aborts a stalled registration without waiting for the network deadline", async () => {
  const f = await fixture();
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const stalled = (async (_input: unknown, init?: RequestInit) => {
    entered();
    return new Promise<Response>((_resolve, reject) => {
      init!.signal!.addEventListener("abort", () => reject(new Error("Registration cancelled")), {
        once: true,
      });
    });
  }) as typeof fetch;
  const auth = new CloudAuth("https://example.test", f.state, protection, async () => {}, stalled);
  const login = auth.signIn();
  void login.catch(() => {});
  await started;
  auth.cancelSignIn();
  await expect(login).rejects.toThrow("cancelled");
  expect(await f.state.read("credentials")).toBeUndefined();
});
