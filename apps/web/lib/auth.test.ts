import { expect, test } from "bun:test";
import { resolve } from "node:path";

test.each([false, true])(
  "OAuth discovery is database-independent (database available: %s)",
  (databaseAvailable) => {
    const child = Bun.spawnSync(
      [
        process.execPath,
        "--eval",
        `
    import { expect, mock } from "bun:test";
    mock.module("server-only", () => ({}));
    let connections = 0;
    mock.module("@/lib/db", () => ({ db: { connect: async () => {
      connections++;
      if (!${databaseAvailable}) throw new Error("Database unavailable");
      return { query: async () => ({ rows: [] }), release() {} };
    } } }));
    const { auth } = await import("./lib/auth.ts");
    const headers = { "x-forwarded-for": "127.0.0.1" };
    for (const path of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/api/mcp"]) {
      const response = await auth.handler(new Request("http://localhost:3000" + path, { headers }));
      expect(response.status).toBe(200);
      const metadata = await response.json();
      expect(metadata.resource).toBe("http://localhost:3000/api/mcp");
      expect(metadata.scopes_supported).toEqual(["mcp:read", "mcp:write", "linear:read", "linear:write"]);
      expect(response.headers.get("cache-control")).toContain("public");
      const head = await auth.handler(new Request("http://localhost:3000" + path, { method: "HEAD", headers }));
      expect(head.status).toBe(200);
      expect(await head.text()).toBe("");
    }
    const response = await auth.handler(new Request("http://localhost:3000/.well-known/oauth-authorization-server/api/auth", { headers }));
    expect(response.status).toBe(200);
    const metadata = await response.json();
    expect(metadata.scopes_supported).toContain("desktop:sync");
    expect(metadata.scopes_supported).toContain("mcp:read");
    for (const path of ["/api/auth/.well-known/oauth-authorization-server", "/api/auth/.well-known/openid-configuration"]) {
      const alias = await auth.handler(new Request("http://localhost:3000" + path, { headers }));
      expect(alias.status).toBe(200);
      expect(await alias.json()).toEqual(metadata);
      const head = await auth.handler(new Request("http://localhost:3000" + path, { method: "HEAD", headers }));
      expect(head.status).toBe(200);
      expect(await head.text()).toBe("");
      const post = await auth.handler(new Request("http://localhost:3000" + path, { method: "POST", headers }));
      expect(post.status).toBe(405);
      expect(post.headers.get("allow")).toBe("GET, HEAD");
    }
    expect(connections).toBe(0);
    if (${databaseAvailable}) {
      expect(metadata).toEqual(await auth.api.getOAuthServerConfig());
    } else {
      await expect(auth.handler(new Request("http://localhost:3000/api/auth/oauth2/register", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
      }))).rejects.toThrow("Database unavailable");
    }
    expect(connections).toBeGreaterThan(0);
    `,
      ],
      {
        cwd: resolve(import.meta.dir, ".."),
        env: {
          ...process.env,
          NODE_ENV: "production",
          BETTER_AUTH_URL: "http://localhost:3000",
          BETTER_AUTH_SECRET: "disposable-auth-test-secret-never-used-in-production",
        },
        stdout: "pipe",
        stderr: "pipe",
        timeout: 10_000,
      },
    );
    expect({ exitCode: child.exitCode, stderr: child.stderr.toString() }).toEqual({
      exitCode: 0,
      stderr: "",
    });
  },
);

test("a stalled Worker auth initialization cannot block a different request", () => {
  const child = Bun.spawnSync(
    [
      process.execPath,
      "--eval",
      `
    import { mock } from "bun:test";
    import { AsyncLocalStorage } from "node:async_hooks";
    const requests = new AsyncLocalStorage();
    let unblock;
    const blocked = new Promise(resolve => { unblock = resolve; });
    let started;
    const starting = new Promise(resolve => { started = resolve; });
    mock.module("server-only", () => ({}));
    mock.module("@opennextjs/cloudflare", () => ({ getCloudflareContext() {
      const context = requests.getStore();
      if (!context) throw new Error("Outside Worker request");
      return context;
    } }));
    mock.module("@/lib/db", () => ({ db: { connect: async () => ({
      query: async (sql) => {
        if (/"oauthResource"/.test(sql) && requests.getStore()?.stall) {
          started();
          await blocked;
        }
        return { rows: [] };
      }, release() {},
    }) } }));
    const { auth } = await import("./lib/auth.ts");
    const first = requests.run({ ctx: {}, stall: true }, () => auth.api.getSession({ headers: new Headers() }));
    await starting;
    let timer;
    const second = await Promise.race([
      requests.run({ ctx: {} }, () => auth.api.getSession({ headers: new Headers() })).then(() => "completed"),
      new Promise(resolve => { timer = setTimeout(() => resolve("blocked"), 200); }),
    ]);
    clearTimeout(timer);
    unblock();
    await first;
    console.log(JSON.stringify({ second }));
  `,
    ],
    {
      cwd: resolve(import.meta.dir, ".."),
      env: {
        ...process.env,
        NODE_ENV: "production",
        BETTER_AUTH_URL: "http://localhost:3000",
        BETTER_AUTH_SECRET: "disposable-auth-test-secret-never-used-in-production",
      },
      stdout: "pipe",
      stderr: "pipe",
      timeout: 5000,
    },
  );
  expect({ exitCode: child.exitCode, stderr: child.stderr.toString() }).toEqual({
    exitCode: 0,
    stderr: "",
  });
  expect(JSON.parse(child.stdout.toString())).toEqual({ second: "completed" });
});

test("production authentication does not wait on a shared schema introspection", () => {
  // Isolate module mocks and the singleton from the database integration suite.
  const child = Bun.spawnSync(
    [
      process.execPath,
      "--eval",
      `
    import { mock } from "bun:test";
    import { createHmac } from "node:crypto";
    let schemaQueries = 0;
    let sessionQueries = 0;
    mock.module("server-only", () => ({}));
    mock.module("@/lib/db", () => ({ db: {
      connect: async () => ({
        query: async (sql) => {
          if (/pg_catalog|information_schema/.test(sql)) {
            schemaQueries++;
            // Model an introspection that never receives a database response.
            return new Promise(() => {});
          }
          if (/\"session\"/.test(sql)) sessionQueries++;
          return { rows: [] };
        },
        release: () => {},
      }),
    } }));
    const { auth } = await import("./lib/auth.ts");
    const timeout = setTimeout(() => {
      console.error("Authentication is still waiting on schema introspection");
      process.exit(1);
    }, 2_000);
    const anonymous = await Promise.all([
      auth.api.getSession({ headers: new Headers() }),
      auth.api.getSession({ headers: new Headers() }),
    ]);
    const context = await auth.$context;
    const token = "unknown-session-token";
    const signature = createHmac("sha256", process.env.BETTER_AUTH_SECRET).update(token).digest("base64");
    const headers = new Headers({ cookie:
      context.authCookies.sessionToken.name + "=" + encodeURIComponent(token + "." + signature),
    });
    const unknownSession = await auth.api.getSession({ headers });
    clearTimeout(timeout);
    console.log(JSON.stringify({ anonymous, unknownSession, schemaQueries, sessionQueries }));
  `,
    ],
    {
      cwd: resolve(import.meta.dir, ".."),
      env: {
        ...process.env,
        NODE_ENV: "production",
        DATABASE_URL: "postgres://127.0.0.1:1/disposable-auth-test",
        BETTER_AUTH_URL: "http://localhost:3000",
        BETTER_AUTH_SECRET: "disposable-auth-test-secret-never-used-in-production",
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  expect({ exitCode: child.exitCode, stderr: child.stderr.toString() }).toEqual({
    exitCode: 0,
    stderr: "",
  });
  const result = JSON.parse(child.stdout.toString());
  expect(result.anonymous).toEqual([null, null]);
  expect(result.unknownSession).toBeNull();
  expect(result.schemaQueries).toBe(0);
  // Disabling introspection must still verify a signed session against Postgres.
  expect(result.sessionQueries).toBeGreaterThan(0);
});
