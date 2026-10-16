import { buildWorkerFixture } from "./fixtures/build-worker.mjs";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const wranglerRequire = createRequire(require.resolve("wrangler/package.json"));
const { Miniflare, convertV4MiniflareOptions } = wranglerRequire("miniflare");
const fixture = fileURLToPath(new URL("./fixtures/auth-context-worker.ts", import.meta.url));
const build = await buildWorkerFixture({
  entrypoints: [fixture],
  target: "browser",
  conditions: ["workerd"],
  external: ["cloudflare:workers", "node:*"],
  plugins: [
    {
      name: "canceled-runtime-import",
      setup(builder) {
        // Fault injection: model an import left pending by an ended Worker
        // invocation. Static imports remain native and available at startup.
        builder.onResolve({ filter: /^node:async_hooks$/ }, (args) =>
          args.kind === "dynamic-import"
            ? { path: args.path, namespace: "canceled-runtime-import" }
            : undefined,
        );
        builder.onLoad({ filter: /.*/, namespace: "canceled-runtime-import" }, () => ({
          contents: "export const AsyncLocalStorage = await new Promise(() => {});",
          loader: "js",
        }));
      },
    },
  ],
});
if (!build.success) throw new AggregateError(build.logs, "Auth context fixture build failed");
const worker = new Miniflare(
  convertV4MiniflareOptions({
    modules: true,
    script: await build.outputs[0].text(),
    compatibilityDate: "2026-09-26",
    compatibilityFlags: ["nodejs_compat"],
    outboundService: () => {
      throw new Error("Authentication context regression must not contact external services.");
    },
  }),
);
try {
  await worker.ready;
  // A completed request must not leave subsequent instances waiting on an
  // isolate-wide promise. Exercise both entry points seen in production.
  for (const path of ["/api/auth/get-session", "/direct-session", "/api/auth/get-session"]) {
    const response = await worker.dispatchFetch(`https://auth.test${path}`);
    assert.equal(response.status, 200, `${path} must complete after a canceled runtime import`);
    assert.equal(await response.json(), null);
  }
  const post = (path, body) =>
    worker.dispatchFetch(`https://auth.test${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://auth.test" },
      body: JSON.stringify(body),
    });
  const credentials = { email: "password@example.test", password: "synthetic-worker-password" };
  assert.equal(
    (await post("/api/auth/sign-up/email", { ...credentials, name: "Worker fixture" })).status,
    200,
  );
  assert.equal(
    (await post("/api/auth/sign-in/email", credentials)).status,
    403,
    "Password accounts must still verify their email",
  );
  assert.equal((await worker.dispatchFetch("https://auth.test/verify-fixture")).status, 204);
  assert.equal(
    (await post("/api/auth/sign-in/email", { ...credentials, password: "wrong-password" })).status,
    401,
    "Incorrect passwords must still be rejected",
  );
  const password = await post("/api/auth/sign-in/email", credentials);
  assert.equal(password.status, 200, "Verified password sign-in must complete");
  const cookie = password.headers
    .getSetCookie()
    .map((value) => value.split(";", 1)[0])
    .join("; ");
  assert(cookie, "Password sign-in must set a session cookie");
  for (const path of ["/api/auth/get-session", "/direct-session"]) {
    const response = await worker.dispatchFetch(`https://auth.test${path}`, {
      headers: { cookie },
    });
    assert.equal(response.status, 200);
    const session = await response.json();
    assert.equal(session.user.email, credentials.email);
    assert.equal(session.user.emailVerified, true);
  }
  const responses = await Promise.all(
    Array.from({ length: 12 }, (_, index) =>
      post("/api/auth/sign-in/social", {
        provider: index % 2 ? "google" : "github",
        callbackURL: "/files",
        disableRedirect: true,
      }),
    ),
  );
  const states = new Set();
  for (const [index, response] of responses.entries()) {
    const provider = index % 2 ? "google" : "github";
    assert.equal(response.status, 200, `${provider} sign-in must return its authorization URL`);
    const result = await response.json();
    const url = new URL(result.url);
    assert.equal(
      url.origin,
      provider === "github" ? "https://github.com" : "https://accounts.google.com",
    );
    assert.equal(
      url.pathname,
      provider === "github" ? "/login/oauth/authorize" : "/o/oauth2/v2/auth",
    );
    assert.equal(
      url.searchParams.get("redirect_uri"),
      `https://auth.test/api/auth/callback/${provider}`,
    );
    const state = url.searchParams.get("state");
    assert(state, "OAuth state must be present");
    states.add(state);
  }
  assert.equal(
    states.size,
    responses.length,
    "Concurrent sign-ins must have distinct OAuth states",
  );
  console.log(
    "PASS: workerd password, Google, GitHub and authenticated session reads survive a pending runtime import",
  );
} finally {
  await worker.dispose();
}
