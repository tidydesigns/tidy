import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

// Use Wrangler's matching Miniflare/workerd version. Never contact production.
const require = createRequire(import.meta.url);
const wranglerRequire = createRequire(require.resolve("wrangler/package.json"));
const { Miniflare, convertV4MiniflareOptions } = wranglerRequire("miniflare");
const fixture = fileURLToPath(new URL("./fixtures/auth-worker.ts", import.meta.url));
const build = await Bun.build({
  entrypoints: [fixture],
  target: "browser",
  external: ["cloudflare:workers", "node:*"],
  minify: false,
});
if (!build.success) throw new AggregateError(build.logs, "Worker fixture build failed");
const metadataUrl = "https://client.example/metadata.json";
let metadataFetches = 0;
const outboundService = async (request) => {
  assert.equal(request.url, metadataUrl);
  metadataFetches++;
  return Response.json(
    {
      client_id: metadataUrl,
      client_name: "Local test",
      redirect_uris: ["http://127.0.0.1/callback"],
      application_type: "native",
      token_endpoint_auth_method: "none",
    },
    { headers: { "Cache-Control": "max-age=60" } },
  );
};

const worker = new Miniflare(
  convertV4MiniflareOptions({
    modules: true,
    script: await build.outputs[0].text(),
    compatibilityDate: "2026-09-26",
    compatibilityFlags: ["nodejs_compat", "global_fetch_strictly_public"],
    bindings: { BETTER_AUTH_SECRET: "worker-fixture-budget-secret-at-least-32-characters" },
    durableObjects: { AUTH_GUARD: { className: "AuthGuard", useSQLite: true } },
    outboundService,
  }),
);
try {
  await worker.ready;
  for (const [group, max] of [
    ["account", 10],
    ["workspace", 30],
  ]) {
    const attempts = await Promise.all(
      Array.from({ length: max + 5 }, (_, i) =>
        worker.dispatchFetch(
          `https://auth.test/github-oauth-attempts?user=${group === "account" ? "github-actor" : `github-${i}`}&organization=${group === "workspace" ? "github-shared" : `github-${i}`}`,
        ),
      ),
    );
    assert.equal(attempts.filter((r) => r.status === 204).length, max);
    assert.equal(attempts.filter((r) => r.status === 429).length, 5);
  }
  assert.equal(
    (
      await worker.dispatchFetch(
        "https://auth.test/github-oauth-attempts?user=fresh-github&organization=fresh-github",
      )
    ).status,
    204,
  );
  console.log("PASS: workerd enforces shared GitHub OAuth account/workspace attempts");
  for (const [kind, max] of [
    ["account-sessions", 120],
    ["session-revoke", 20],
    ["oauth-authorizations", 120],
    ["oauth-revoke", 20],
    ["vault-read", 120],
    ["vault-write", 60],
    ["agent-status", 120],
    ["agent-refresh", 120],
    ["agent-login", 6],
    ["agent-disconnect", 10],
  ]) {
    const attempts = await Promise.all(
      Array.from({ length: max + 5 }, () =>
        worker.dispatchFetch(
          `https://auth.test/personal-attempts?kind=${kind}&user=personal-actor`,
        ),
      ),
    );
    assert.equal(attempts.filter((x) => x.status === 204).length, max);
    assert.equal(attempts.filter((x) => x.status === 429).length, 5);
    assert.equal(
      (
        await worker.dispatchFetch(
          `https://auth.test/personal-attempts?kind=${kind}&user=fresh-actor`,
        )
      ).status,
      204,
    );
  }
  console.log(
    "PASS: workerd applies independent personal credential/session/consent budgets with shared account counters",
  );
  const linearWork = await Promise.all(
    Array.from({ length: 2 }, async () =>
      (await worker.dispatchFetch("https://auth.test/linear-work")).json(),
    ),
  );
  assert.deepEqual(linearWork, [
    { admitted: 12, limited: true, bytesLimited: true },
    { admitted: 12, limited: true, bytesLimited: true },
  ]);
  console.log(
    "PASS: workerd shares nested Linear request and byte limits while isolating independent calls",
  );
  for (const [kind, accountMax, workspaceMax] of [
    ["read", 60, 300],
    ["write", 20, 100],
    ["oauth", 10, 30],
  ]) {
    const attempts = await Promise.all(
      Array.from({ length: accountMax + 5 }, (_, i) =>
        worker.dispatchFetch(
          `https://auth.test/linear-attempts?kind=${kind}&user=linear-actor&organization=linear-${i}`,
        ),
      ),
    );
    assert.equal(attempts.filter((x) => x.status === 204).length, accountMax);
    assert.equal(attempts.filter((x) => x.status === 429).length, 5);
    const shared = await Promise.all(
      Array.from({ length: workspaceMax + 5 }, (_, i) =>
        worker.dispatchFetch(
          `https://auth.test/linear-attempts?kind=${kind}&user=linear-actor-${i}&organization=linear-shared`,
        ),
      ),
    );
    assert.equal(shared.filter((x) => x.status === 204).length, workspaceMax);
    assert.equal(shared.filter((x) => x.status === 429).length, 5);
  }
  console.log(
    "PASS: workerd enforces separate Linear read/write/OAuth attempts across workspaces and actors",
  );
  const githubWork = await Promise.all(
    Array.from({ length: 2 }, async () =>
      (await worker.dispatchFetch("https://auth.test/github-budget")).json(),
    ),
  );
  assert.deepEqual(githubWork, [
    { admitted: 40, limited: true },
    { admitted: 40, limited: true },
  ]);
  assert.deepEqual(
    await (await worker.dispatchFetch("https://auth.test/github-byte-budget")).json(),
    { limited: true },
  );
  console.log("PASS: workerd shares nested GitHub work limits while isolating separate requests");
  const fileAccount = await Promise.all(
    Array.from({ length: 25 }, (_, index) =>
      worker.dispatchFetch(
        `https://auth.test/file-management-budget?user=file-editor&organization=file-${index}`,
      ),
    ),
  );
  assert.equal(fileAccount.filter((response) => response.status === 204).length, 20);
  assert.equal(fileAccount.filter((response) => response.status === 429).length, 5);
  const fileWorkspace = await Promise.all(
    Array.from({ length: 105 }, (_, index) =>
      worker.dispatchFetch(
        `https://auth.test/file-management-budget?user=file-editor-${index}&organization=shared-files`,
      ),
    ),
  );
  assert.equal(fileWorkspace.filter((response) => response.status === 204).length, 100);
  assert.equal(fileWorkspace.filter((response) => response.status === 429).length, 5);
  console.log(
    "PASS: workerd shares file-management account attempts across workspaces and workspace attempts across actors",
  );
  const reads = await Promise.all(
    Array.from({ length: 250 }, (_, index) =>
      worker.dispatchFetch(`https://auth.test/image-budget?user=reader&organization=read-${index}`),
    ),
  );
  assert.equal(reads.filter((response) => response.status === 204).length, 240);
  assert.equal(reads.filter((response) => response.status === 429).length, 10);
  const thumbnails = await Promise.all(
    Array.from({ length: 65 }, (_, index) =>
      worker.dispatchFetch(
        `https://auth.test/image-budget?kind=thumbnail&user=renderer&organization=thumbnail-${index}`,
      ),
    ),
  );
  assert.equal(thumbnails.filter((response) => response.status === 204).length, 60);
  assert.equal(thumbnails.filter((response) => response.status === 429).length, 5);
  const workspaceImages = await Promise.all(
    Array.from({ length: 305 }, (_, index) =>
      worker.dispatchFetch(
        `https://auth.test/image-budget?kind=thumbnail&user=render-${index}&organization=shared-images`,
      ),
    ),
  );
  assert.equal(workspaceImages.filter((response) => response.status === 204).length, 300);
  assert.equal(workspaceImages.filter((response) => response.status === 429).length, 5);
  assert.equal(
    (
      await worker.dispatchFetch(
        "https://auth.test/image-budget?kind=thumbnail&user=reader&organization=fresh-image-workspace",
      )
    ).status,
    204,
  );
  console.log(
    "PASS: private image reads and thumbnail publication enforce separate account/workspace budgets",
  );
  const clipboardAttempts = await Promise.all(
    Array.from({ length: 20 }, (_, index) =>
      worker.dispatchFetch(`https://auth.test/clipboard-budget?organization=destination-${index}`),
    ),
  );
  assert.equal(clipboardAttempts.filter((response) => response.status === 204).length, 10);
  assert.equal(clipboardAttempts.filter((response) => response.status === 429).length, 10);
  const workspaceCopies = await Promise.all(
    Array.from({ length: 35 }, (_, index) =>
      worker.dispatchFetch(
        `https://auth.test/clipboard-budget?user=copy-${index}&organization=shared`,
      ),
    ),
  );
  assert.equal(workspaceCopies.filter((response) => response.status === 204).length, 30);
  assert.equal(workspaceCopies.filter((response) => response.status === 429).length, 5);
  assert.equal(
    (
      await worker.dispatchFetch(
        "https://auth.test/clipboard-budget?user=fresh&organization=separate",
      )
    ).status,
    204,
  );
  console.log(
    "PASS: clipboard attempts share account limits across destinations and enforce workspace capacity",
  );
  const feedbackAttempts = await Promise.all(
    Array.from({ length: 10 }, () => worker.dispatchFetch("https://auth.test/feedback-budget")),
  );
  assert.equal(feedbackAttempts.filter((response) => response.status === 204).length, 5);
  assert.equal(feedbackAttempts.filter((response) => response.status === 429).length, 5);
  const feedbackAccounts = await Promise.all(
    Array.from({ length: 35 }, (_, index) =>
      worker.dispatchFetch(`https://auth.test/feedback-budget?user=other-${index}`),
    ),
  );
  assert.equal(feedbackAccounts.filter((response) => response.status === 204).length, 25);
  assert.equal(feedbackAccounts.filter((response) => response.status === 429).length, 10);
  console.log("PASS: feedback upload attempts enforce per-account and shared global ceilings");
  const commentAttempts = await Promise.all(
    Array.from({ length: 80 }, () =>
      worker.dispatchFetch("https://auth.test/comment-budget?organization=one"),
    ),
  );
  assert.equal(commentAttempts.filter((response) => response.status === 204).length, 60);
  assert.equal(commentAttempts.filter((response) => response.status === 429).length, 20);
  assert.equal(
    (await worker.dispatchFetch("https://auth.test/comment-budget?organization=two")).status,
    204,
  );
  console.log("PASS: hosted comment budgets enforce actor limits and isolate organization shards");
  const inviteAttempts = await Promise.all(
    Array.from({ length: 20 }, () =>
      worker.dispatchFetch("https://auth.test/invitation-budget?organization=one"),
    ),
  );
  assert.equal(inviteAttempts.filter((response) => response.status === 204).length, 10);
  assert.equal(inviteAttempts.filter((response) => response.status === 429).length, 10);
  assert.equal(
    (await worker.dispatchFetch("https://auth.test/invitation-budget?organization=two")).status,
    204,
  );
  console.log("PASS: invitation budgets have separate counters and organization scope");
  const registrations = await Promise.all(
    Array.from({ length: 80 }, () => worker.dispatchFetch("https://auth.test/registration-budget")),
  );
  assert.equal(registrations.filter((response) => response.status === 204).length, 60);
  assert.equal(registrations.filter((response) => response.status === 429).length, 20);
  console.log("PASS: OAuth registrations share a hosted global attempt budget");
  const initialize = {
    jsonrpc: "2.0",
    id: 0,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "codex", version: "0.160.0" },
    },
  };
  const mcpResponse = await worker.dispatchFetch("https://auth.test/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(initialize),
  });
  const mcpResult = await mcpResponse.json();
  assert.equal(mcpResponse.status, 200, JSON.stringify(mcpResult));
  assert.deepEqual(mcpResult, { scopes: ["mcp:read"], body: initialize });
  console.log("PASS: workerd preserves a valid MCP initialize request after scope inspection");
  const responses = await Promise.all(
    Array.from({ length: 20 }, async () =>
      (await worker.dispatchFetch("https://auth.test/limit")).json(),
    ),
  );
  assert.equal(responses.filter((response) => response.allowed).length, 3);
  assert.equal(responses.filter((response) => !response.allowed).length, 17);
  console.log("PASS: 20 concurrent Worker requests share one atomic auth budget");
  const emailResponses = await Promise.all(
    Array.from({ length: 20 }, async (_, index) =>
      (
        await worker.dispatchFetch("https://auth.test/email", {
          headers: { "cf-connecting-ip": `192.0.2.${index}` },
        })
      ).json(),
    ),
  );
  assert.equal(emailResponses.filter((response) => response.allowed).length, 1);
  console.log("PASS: independent Worker requests share recipient email cooldown regardless of IP");
  const small = await worker.dispatchFetch("https://auth.test/bounded-body", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: '{"value":true}',
  });
  assert.equal(small.status, 200);
  assert.deepEqual(await small.json(), { value: true });
  const large = await worker.dispatchFetch("https://auth.test/bounded-body", {
    method: "POST",
    body: "x".repeat(33),
  });
  assert.equal(large.status, 413);
  console.log("PASS: workerd preserves bounded request bodies and rejects oversized input");
  for (const path of ["/stall", "/body-stall"]) {
    const started = performance.now();
    const response = await worker.dispatchFetch(`https://auth.test${path}`, {
      headers: { Accept: "text/html" },
    });
    assert.equal(response.status, 503);
    assert.ok(performance.now() - started < 2000);
    assert.match(await response.text(), /Try again/);
    assert.equal(response.headers.get("Referrer-Policy"), "no-referrer");
  }
  assert.equal((await worker.dispatchFetch("https://auth.test/healthy")).status, 200);
  console.log(
    "PASS: workerd returns bounded retry pages for handler and body stalls; subsequent requests succeed",
  );
  for (let i = 0; i < 3; i++) {
    const response = await worker.dispatchFetch("https://auth.test/metadata");
    assert.equal(response.status, 200);
    assert.equal((await response.json()).client_id, metadataUrl);
  }
  assert.equal(metadataFetches, 1);
  console.log("PASS: separate Worker requests reuse only completed, validated CIMD metadata");
} finally {
  await worker.dispose();
}
