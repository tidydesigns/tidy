import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { consentCookie, consentRevision, CONSENT_VERSION } from "../lib/privacy/consent.ts";

const require = createRequire(import.meta.url);
const wranglerRequire = createRequire(require.resolve("wrangler/package.json"));
const { Miniflare, convertV4MiniflareOptions } = wranglerRequire("miniflare");
const build = await Bun.build({
  entrypoints: [fileURLToPath(new URL("./fixtures/telemetry-worker.ts", import.meta.url))],
  target: "browser",
  external: ["cloudflare:workers", "node:*"],
  define: {
    "process.env.NODE_ENV": JSON.stringify("production"),
    "process.env.NEXT_PUBLIC_POSTHOG_ENABLED": JSON.stringify("1"),
    "process.env.NEXT_PUBLIC_POSTHOG_HOST": JSON.stringify("https://t.tidydesign.co"),
    "process.env.NEXT_PUBLIC_POSTHOG_KEY": JSON.stringify("synthetic-worker-project"),
    "process.env.BETTER_AUTH_URL": JSON.stringify("https://telemetry.test"),
  },
  plugins: [
    {
      name: "synthetic-consent-receipt",
      setup(builder) {
        // Database receipt enforcement has separate integration coverage. This
        // fixture exercises the actual route and workerd's outbound fetch API.
        builder.onResolve({ filter: /^@\/lib\/privacy\/consent-store$/ }, () => ({
          path: "receipt",
          namespace: "synthetic-receipt",
        }));
        builder.onLoad({ filter: /.*/, namespace: "synthetic-receipt" }, () => ({
          contents: "export async function authorizeTelemetry() { return true; }",
          loader: "js",
        }));
      },
    },
  ],
});
if (!build.success) throw new AggregateError(build.logs, "Telemetry Worker fixture build failed");
const calls = [];
let upstreamStatus = 200;
const worker = new Miniflare(
  convertV4MiniflareOptions({
    modules: true,
    script: await build.outputs[0].text(),
    compatibilityDate: "2026-09-26",
    compatibilityFlags: ["nodejs_compat", "global_fetch_strictly_public"],
    outboundService: async (request) => {
      calls.push({
        url: request.url,
        headers: Object.fromEntries(request.headers),
        body: await request.text(),
      });
      return upstreamStatus === 200
        ? Response.json({ status: 1 }, { headers: { "Set-Cookie": "provider=untrusted" } })
        : new Response("redirect body", {
            status: upstreamStatus,
            headers: { Location: "https://redirect.invalid" },
          });
    },
  }),
);
const choice = {
  version: CONSENT_VERSION,
  at: Date.now(),
  analytics: true,
  replay: true,
  diagnostics: true,
};
const headers = {
  cookie: `${consentCookie(choice, choice.at)}; authentication=synthetic-secret`,
  origin: "https://telemetry.test",
  authorization: "Bearer synthetic-secret",
  "x-tidy-consent": consentRevision(choice),
  "x-tidy-receipt": "synthetic-receipt",
  "content-type": "application/json",
};
const send = (path, method = "POST") =>
  worker.dispatchFetch(`https://telemetry.test/api/t/${path}?private=secret&v=2`, {
    method,
    headers,
    ...(method === "POST" ? { body: JSON.stringify({ event: "$pageview" }) } : {}),
  });
try {
  await worker.ready;
  for (const path of ["e", "s", "flags"]) {
    const result = await send(path);
    assert.equal(result.status, 200, `${path} must work with the deployed Worker runtime`);
    assert.equal(result.headers.get("set-cookie"), null);
  }
  assert.equal((await send("array/synthetic-worker-project/config", "GET")).status, 200);
  assert.equal(calls.length, 4);
  assert.equal(new URL(calls[3].url).hostname, "t.tidydesign.co");
  for (const call of calls) {
    assert.equal(new URL(call.url).hostname, "t.tidydesign.co");
    assert.equal(call.headers.cookie, undefined);
    assert.equal(call.headers.authorization, undefined);
    assert.equal(call.headers["x-tidy-receipt"], undefined);
    assert.equal(new URL(call.url).searchParams.get("private"), null);
  }
  for (const status of [301, 302, 303, 307, 308]) {
    upstreamStatus = status;
    const before = calls.length;
    const result = await send("e");
    assert.equal(result.status, 503);
    assert.equal(result.headers.get("location"), null);
    assert.equal(await result.text(), "");
    assert.equal(
      calls.length,
      before + 1,
      "A redirect must never trigger another upstream request",
    );
    assert.equal(new URL(calls.at(-1).url).hostname, "t.tidydesign.co");
  }
  const before = calls.length;
  assert.equal(
    (await worker.dispatchFetch("https://telemetry.test/api/t/e", { method: "POST" })).status,
    200,
  );
  assert.equal(calls.length, before, "No consent must still prevent upstream traffic");
  console.log(
    "PASS: workerd forwards consented telemetry and rejects redirects without forwarding credentials",
  );
} finally {
  await worker.dispose();
}
