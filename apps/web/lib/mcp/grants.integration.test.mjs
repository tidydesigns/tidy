import { afterAll, beforeAll, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { Client } from "pg";
import { createHash, createHmac } from "node:crypto";
import { makeSignature } from "better-auth/crypto";
import { encodeBasicCredentials } from "@better-auth/core/oauth2";
import { calculateJwkThumbprint, generateKeyPair, exportJWK, SignJWT } from "jose";
import { db } from "../db";
mock.module("server-only", () => ({}));
mock.module("next/cache", () => ({ revalidatePath() {} }));
const { auth } = await import("../auth");
const { createConsentApproval } = await import("../auth/oauth-consent");
const { POST } = await import("../../app/api/mcp/route");
const { hasMcpAuthorization, revokeMcpAuthorization } = await import("./authorizations");
const { withMcpGrantContext } = await import("./grant-context");
const { withMcpGrantOperation } = await import("./grant-operation");
const { consumeMcpCall, meterMcpServer } = await import("./usage");
const { runWithRequestSignal } = await import("../request-lifecycle");
const { blankDesignDocument } = await import("../design/document");
const { renameDesignFileForUser } = await import("../design/service");
const { withoutDatabaseScope, inDatabaseScope, scopedDatabaseClient } =
  await import("../database-scope");
const testUrl = process.env.MCP_TEST_DATABASE_URL,
  setupUrl = process.env.MCP_SETUP_DATABASE_URL;
const enabled = Boolean(
  testUrl &&
  setupUrl &&
  process.env.DATABASE_URL === testUrl &&
  [testUrl, setupUrl].every(
    (url) => new URL(url).hostname === "127.0.0.1" && new URL(url).pathname === "/tidy_mcp_test",
  ) &&
  new URL(testUrl).port === new URL(setupUrl).port,
);
const integration = enabled ? test : test.skip;
const resource = "http://localhost:3000/api/mcp",
  originalFetch = globalThis.fetch;
let admin;
let fixtureIp = 0;
const authHeaders = () => ({ "x-forwarded-for": `192.0.2.${fixtureIp}` });
const grant = (changes = {}) => ({
  resource,
  scopes: ["mcp:read", "mcp:write"],
  claims: {
    sub: "alice",
    client_id: "client-a",
    sid: "session-a",
    exp: Math.floor(Date.now() / 1000) + 900,
    iss: "http://localhost:3000/api/auth",
    aud: resource,
    scope: "mcp:read mcp:write",
    bella_grant_version: "0",
    ...changes,
  },
});
const pause = () => {
  let enter, release;
  const entered = new Promise((resolve) => (enter = resolve)),
    gate = new Promise((resolve) => (release = resolve));
  return {
    entered,
    release,
    hook: async () => {
      enter();
      await gate;
    },
  };
};
async function waitingRuntime(waitEvent = "advisory") {
  for (let i = 0; i < 200; i++) {
    await admin.query("select pg_stat_clear_snapshot()");
    const row = (
      await admin.query(
        "select pid from pg_stat_activity where usename='tidy_runtime_fixture' and state='active' and wait_event=$1 limit 1",
        [waitEvent],
      )
    ).rows[0];
    if (row) return row.pid;
    await Bun.sleep(5);
  }
  const waiting = (
    await admin.query(
      "select pid,state,wait_event,query from pg_stat_activity where usename='tidy_runtime_fixture'",
    )
  ).rows;
  throw new Error(
    `Expected actual runtime admission lock wait (${waitEvent}): ${JSON.stringify(waiting)}`,
  );
}
async function blocked(pid) {
  for (let i = 0; i < 200; i++) {
    if (
      (await admin.query("select cardinality(pg_blocking_pids($1))>0 as blocked", [pid])).rows[0]
        .blocked
    )
      return;
    await Bun.sleep(5);
  }
  throw new Error("Expected actual PostgreSQL control-write lock wait");
}
async function calls() {
  return Number(
    (await admin.query('select coalesce(sum("calls"),0) as calls from "organizationMcpUsage"'))
      .rows[0].calls,
  );
}
async function fileName() {
  return (await admin.query('select "name" from "designFile" where "id"=\'file-a\'')).rows[0].name;
}
async function responseMessage(response) {
  const body = await response.text();
  return response.headers.get("content-type")?.includes("text/event-stream")
    ? body
        .split("\n")
        .filter((line) => line.startsWith("data: "))
        .map((line) => JSON.parse(line.slice(6)))
        .find((message) => message.id === 1)
    : JSON.parse(body);
}
async function request(method, params, changes = {}, body) {
  const { token } = await auth.api.signJWT({ body: { payload: grant(changes).claims } });
  return POST(
    new Request(resource, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "MCP-Protocol-Version": "2025-06-18",
      },
      body: body ?? JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      ...(body instanceof ReadableStream ? { duplex: "half" } : {}),
    }),
  );
}
const verifier = "disposable-mcp-pkce-fixture-verifier-with-more-than-43-characters";
async function authorizationCode(
  clientId = "client-a",
  sessionToken = "token-a",
  profile = false,
  consent = false,
) {
  const scopes = [
    "mcp:read",
    "mcp:write",
    "offline_access",
    ...(profile ? ["openid", "profile"] : []),
  ];
  await admin.query(
    `update "oauthClient" set "skipConsent"=true,"requirePKCE"=true,
    "tokenEndpointAuthMethod"='none',"grantTypes"='["authorization_code","refresh_token"]',
    "scopes"=$2,"redirectUris"='["http://127.0.0.1:4319/callback"]'
    where "clientId"=$1`,
    [clientId, JSON.stringify(scopes)],
  );
  if (profile)
    await admin.query('update "oauthConsent" set "scopes"=$2 where "clientId"=$1', [
      clientId,
      JSON.stringify(scopes),
    ]);
  const headers = await sessionHeaders(sessionToken);
  expect((await auth.api.getSession({ headers }))?.user.id).toBe(
    sessionToken === "token-b" ? "bob" : "alice",
  );
  const query = new URLSearchParams({
    client_id: clientId,
    response_type: "code",
    redirect_uri: "http://127.0.0.1:4319/callback",
    resource,
    scope: scopes.join(" "),
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
    state: "fixture-state",
  });
  const response = await auth.handler(
    new Request(
      `http://localhost:3000/api/auth/oauth2/authorize?${query}${consent ? "&prompt=consent" : ""}`,
      { headers },
    ),
  );
  if (consent) {
    const query = new URL(response.headers.get("location"), resource).searchParams.toString();
    const binding = await createConsentApproval(
      sessionToken === "token-b" ? "bob" : "alice",
      sessionToken === "token-b" ? "session-b" : "session-a",
      query,
      process.env.BETTER_AUTH_SECRET,
    );
    return { query, binding };
  }
  const code = new URL(response.headers.get("location")).searchParams.get("code");
  expect(code).toBeTruthy();
  return code;
}
async function sessionHeaders(token = "token-a") {
  const signature = await makeSignature(token, process.env.BETTER_AUTH_SECRET);
  return new Headers({
    ...authHeaders(),
    cookie: `better-auth.session_token=${encodeURIComponent(`${token}.${signature}`)}`,
  });
}
function exchangeCode(code, clientId = "client-a") {
  return auth.handler(
    new Request("http://localhost:3000/api/auth/oauth2/token", {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: clientId,
        code,
        code_verifier: verifier,
        redirect_uri: "http://127.0.0.1:4319/callback",
        resource,
      }),
    }),
  );
}
function refreshToken(token, clientId = "client-a") {
  return auth.handler(
    new Request("http://localhost:3000/api/auth/oauth2/token", {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: clientId,
        refresh_token: token,
        resource,
      }),
    }),
  );
}
async function issuedTokens(clientId = "client-a", sessionToken = "token-a", profile = false) {
  const response = await exchangeCode(
    await authorizationCode(clientId, sessionToken, profile),
    clientId,
  );
  expect(response.status).toBe(200);
  return response.json();
}

function protocolRevoke(token, clientId = "client-a", hint = "refresh_token") {
  return auth.handler(
    new Request("http://localhost:3000/api/auth/oauth2/revoke", {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: clientId, token, token_type_hint: hint }),
    }),
  );
}
function claimsOf(tokens) {
  return JSON.parse(Buffer.from(tokens.access_token.split(".")[1], "base64url").toString());
}

function userInfo(token, post = false) {
  return auth.handler(
    new Request("http://localhost:3000/api/auth/oauth2/userinfo", {
      method: post ? "POST" : "GET",
      headers: {
        ...authHeaders(),
        ...(post
          ? { "Content-Type": "application/x-www-form-urlencoded" }
          : { Authorization: `Bearer ${token}` }),
      },
      ...(post ? { body: new URLSearchParams({ access_token: token }) } : {}),
    }),
  );
}
async function confidentialClient(clientId = "client-a") {
  const secret = "disposable-introspection-secret";
  await admin.query(
    'update "oauthClient" set "tokenEndpointAuthMethod"=\'client_secret_post\',"clientSecret"=$2 where "clientId"=$1',
    [clientId, createHash("sha256").update(secret).digest("base64url")],
  );
  return secret;
}
function introspect(token, secret, hint = "access_token", clientId = "client-a") {
  return auth.handler(
    new Request("http://localhost:3000/api/auth/oauth2/introspect", {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        token,
        token_type_hint: hint,
        client_id: clientId,
        client_secret: secret,
      }),
    }),
  );
}
for (const kind of ["signature", "issuer", "notBefore", "unknownKey", "algorithm", "header"])
  integration(
    `Invalid OAuth ${kind} token has a neutral introspection result and bearer challenge`,
    async () => {
      const tokens = await issuedTokens("client-a", "token-a", true);
      let token = tokens.access_token;
      const parts = token.split(".");
      if (kind === "signature") parts[2] = (parts[2][0] === "A" ? "B" : "A") + parts[2].slice(1);
      if (["unknownKey", "algorithm", "header"].includes(kind)) {
        const header = JSON.parse(Buffer.from(parts[0], "base64url").toString());
        if (kind === "unknownKey") header.kid = "disposable-unknown-signing-key";
        if (kind === "algorithm") header.alg = "unsupported-disposable-algorithm";
        parts[0] = Buffer.from(JSON.stringify(kind === "header" ? {} : header)).toString(
          "base64url",
        );
      }
      token = parts.join(".");
      if (kind === "issuer" || kind === "notBefore") {
        token = (
          await auth.api.signJWT({
            body: {
              payload: {
                ...grant().claims,
                azp: "client-a",
                scope: "openid profile mcp:read",
                ...(kind === "issuer"
                  ? { iss: "https://foreign.example.test" }
                  : { nbf: Math.floor(Date.now() / 1000) + 86400 }),
              },
            },
          })
        ).token;
      }
      const secret = await confidentialClient();
      for (const hint of ["access_token", ""]) {
        const response = await introspect(token, secret, hint);
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ active: false });
      }
      for (const post of [false, true]) {
        const response = await userInfo(token, post);
        expect(response.status).toBe(401);
        expect(response.headers.get("www-authenticate")).toContain("invalid_token");
        expect(await response.text()).not.toContain("stack");
      }
    },
  );
for (const kind of ["jwt", "opaque", "refresh"])
  integration(`Introspection does not disclose another client's ${kind} grant`, async () => {
    const tokens = await issuedTokens("client-a", "token-a", true);
    let token = kind === "refresh" ? tokens.refresh_token : tokens.access_token;
    if (kind === "opaque") {
      token = "disposable-foreign-introspection-token";
      await admin.query(
        `insert into "oauthAccessToken" ("id","token","userId","clientId","sessionId","scopes","resources","expiresAt","createdAt") values ('foreign-opaque',$1,'alice','client-a','session-a','["openid","profile","mcp:read"]',$2,now()+interval '1 day',now())`,
        [createHash("sha256").update(token).digest("base64url"), JSON.stringify([resource])],
      );
    }
    const secret = await confidentialClient("client-b");
    const response = await introspect(
      token,
      secret,
      kind === "refresh" ? "refresh_token" : "access_token",
      "client-b",
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ active: false });
  });
integration(
  "Introspection uses the authenticated Basic client, not a body client hint",
  async () => {
    const tokens = await issuedTokens();
    const secret = await confidentialClient();
    await confidentialClient("client-b");
    for (const clientId of ["client-a", "client-b"]) {
      await admin.query(
        'update "oauthClient" set "tokenEndpointAuthMethod"=\'client_secret_basic\' where "clientId"=$1',
        [clientId],
      );
      const response = await auth.handler(
        new Request("http://localhost:3000/api/auth/oauth2/introspect", {
          method: "POST",
          headers: {
            ...authHeaders(),
            "Content-Type": "application/x-www-form-urlencoded",
            Authorization: encodeBasicCredentials(clientId, secret),
          },
          body: new URLSearchParams({
            token: tokens.access_token,
            client_id: clientId === "client-a" ? "client-b" : "client-a",
          }),
        }),
      );
      expect(response.status).toBe(200);
      if (clientId === "client-a")
        expect(await response.json()).toMatchObject({ active: true, client_id: "client-a" });
      else expect(await response.json()).toEqual({ active: false });
    }
  },
);
for (const [name, sql] of Object.entries({
  secret: `update "oauthClient" set "clientSecret"='rotated-secret' where "clientId"='client-a'`,
  method: `update "oauthClient" set "tokenEndpointAuthMethod"='none' where "clientId"='client-a'`,
  keys: `update "oauthClient" set "jwks"='{"keys":[]}' where "clientId"='client-a'`,
  keyURI: `update "oauthClient" set "jwksUri"='https://rotated.example.test/jwks' where "clientId"='client-a'`,
}))
  integration(`Queued introspection rejects a changed client ${name}`, async () => {
    const tokens = await issuedTokens();
    const secret = await confidentialClient();
    await admin.query("begin");
    await admin.query("select pg_advisory_xact_lock(hashtextextended('mcp-consent:alice',0))");
    let read;
    try {
      read = introspect(tokens.access_token, secret);
      await waitingRuntime();
      await admin.query(sql);
      await admin.query("commit");
      const response = await read;
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: "invalid_client" });
    } finally {
      await admin.query("rollback");
      await read?.catch(() => {});
    }
  });
integration("UserInfo GET and POST deny a revoked JWT even after reconsent", async () => {
  const tokens = await issuedTokens("client-a", "token-a", true);
  const response = await userInfo(tokens.access_token);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ sub: "alice", name: "Alice" });
  expect((await protocolRevoke(tokens.refresh_token)).status).toBe(200);
  await admin.query(
    'insert into "oauthConsent" ("id","userId","clientId","resources","scopes","createdAt","updatedAt") values (\'renewed-consent\',\'alice\',\'client-a\',$1,$2,now(),now())',
    [
      JSON.stringify([resource]),
      JSON.stringify(["mcp:read", "mcp:write", "offline_access", "openid", "profile"]),
    ],
  );
  await issuedTokens("client-a", "token-a", true);
  expect((await userInfo(tokens.access_token)).status).toBe(401);
  expect((await userInfo(tokens.access_token, true)).status).toBe(401);
});
integration("Introspection marks a revoked signed JWT inactive", async () => {
  const tokens = await issuedTokens();
  const secret = await confidentialClient();
  expect(await (await introspect(tokens.access_token, secret)).json()).toMatchObject({
    active: true,
    sub: "alice",
  });
  await revokeMcpAuthorization("alice", "client-a");
  expect(await (await introspect(tokens.access_token, secret)).json()).toEqual({ active: false });
});
integration("OAuth profile and introspection reject verification loss", async () => {
  const tokens = await issuedTokens("client-a", "token-a", true);
  const secret = await confidentialClient();
  await admin.query('update "user" set "emailVerified"=false where "id"=\'alice\'');
  expect((await userInfo(tokens.access_token)).status).toBe(401);
  expect(await (await introspect(tokens.access_token, secret)).json()).toEqual({ active: false });
  expect(await (await introspect(tokens.refresh_token, secret, "refresh_token")).json()).toEqual({
    active: false,
  });
});
integration("Refresh introspection requires the original session owner", async () => {
  const tokens = await issuedTokens();
  const secret = await confidentialClient();
  expect(
    await (await introspect(tokens.refresh_token, secret, "refresh_token")).json(),
  ).toMatchObject({ active: true, sub: "alice" });
  await admin.query('update "session" set "userId"=\'bob\' where "id"=\'session-a\'');
  expect(await (await introspect(tokens.refresh_token, secret, "refresh_token")).json()).toEqual({
    active: false,
  });
});

for (const [name, sql] of Object.entries({
  session: 'delete from "session" where "id"=\'session-a\'',
  sessionOwner: 'update "session" set "userId"=\'bob\' where "id"=\'session-a\'',
  consent: 'delete from "oauthConsent" where "id"=\'consent-a\'',
  profileConsent:
    'update "oauthConsent" set "scopes"=\'["mcp:read","mcp:write","offline_access","openid"]\' where "id"=\'consent-a\'',
  client: 'update "oauthClient" set "disabled"=true where "clientId"=\'client-a\'',
  resource: 'update "oauthResource" set "disabled"=true',
  link: 'delete from "oauthClientResource" where "clientId"=\'client-a\'',
}))
  integration(`OAuth identity reads reject ended ${name} authority`, async () => {
    const tokens = await issuedTokens("client-a", "token-a", true);
    const secret = await confidentialClient();
    await admin.query(sql);
    expect((await userInfo(tokens.access_token)).status).toBe(401);
    for (const [token, hint] of [
      [tokens.access_token, "access_token"],
      [tokens.refresh_token, "refresh_token"],
    ]) {
      const response = await introspect(token, secret, hint);
      // A disabled client must fail authentication before token inspection.
      if (name === "client") expect([400, 401]).toContain(response.status);
      else {
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ active: false });
      }
    }
  });

for (const kind of ["profile", "introspection"])
  integration(`Queued OAuth ${kind} reads cannot publish after consent ends`, async () => {
    const tokens = await issuedTokens("client-a", "token-a", true);
    const secret = kind === "introspection" ? await confidentialClient() : undefined;
    await admin.query("begin");
    await admin.query("select pg_advisory_xact_lock(hashtextextended('mcp-consent:alice',0))");
    let read;
    try {
      read =
        kind === "profile"
          ? userInfo(tokens.access_token)
          : introspect(tokens.access_token, secret);
      await waitingRuntime();
      await admin.query('delete from "oauthConsent" where "id"=\'consent-a\'');
      await admin.query("commit");
      const response = await read;
      if (kind === "profile") expect(response.status).toBe(401);
      else expect(await response.json()).toEqual({ active: false });
    } finally {
      await admin.query("rollback");
      await read?.catch(() => {});
    }
  });

integration(
  "Admitted OAuth profile read retains consent through final publication check",
  async () => {
    const tokens = await issuedTokens("client-a", "token-a", true);
    const held = pause(),
      originalQuery = db.query,
      query = originalQuery.bind(db);
    let read, revocation;
    db.query = async (...args) => {
      const result = await query(...args);
      if (String(args[0]).includes('select 1 from "oauthConsent" consent join')) await held.hook();
      return result;
    };
    try {
      read = userInfo(tokens.access_token);
      await Promise.race([
        held.entered,
        read.then((response) => {
          throw new Error(`Profile read ended before retained admission: ${response.status}`);
        }),
      ]);
      revocation = revokeMcpAuthorization("alice", "client-a");
      await waitingRuntime();
      held.release();
      expect((await read).status).toBe(200);
      await revocation;
      expect((await userInfo(tokens.access_token)).status).toBe(401);
    } finally {
      held.release();
      await read?.catch(() => {});
      await revocation?.catch(() => {});
      db.query = originalQuery;
    }
  },
);

integration("OAuth server API identity reads enforce the same live grant checks", async () => {
  const tokens = await issuedTokens("client-a", "token-a", true);
  const headers = new Headers({ ...authHeaders(), Authorization: `Bearer ${tokens.access_token}` });
  expect(await auth.api.oauth2UserInfo({ headers })).toMatchObject({ sub: "alice", name: "Alice" });
  const secret = await confidentialClient();
  expect(
    await auth.api.oauth2Introspect({
      headers: new Headers(authHeaders()),
      body: { client_id: "client-a", client_secret: secret, token: tokens.access_token },
    }),
  ).toMatchObject({ active: true });
  await revokeMcpAuthorization("alice", "client-a");
  await expect(auth.api.oauth2UserInfo({ headers })).rejects.toMatchObject({ statusCode: 401 });
  expect(
    await auth.api.oauth2Introspect({
      headers: new Headers(authHeaders()),
      body: { client_id: "client-a", client_secret: secret, token: tokens.access_token },
    }),
  ).toEqual({ active: false });
});

integration("UserInfo preserves DPoP proof binding and consumes each proof once", async () => {
  const tokens = await issuedTokens("client-a", "token-a", true);
  const { publicKey, privateKey } = await generateKeyPair("ES256");
  const jwk = await exportJWK(publicKey);
  const { token } = await auth.api.signJWT({
    body: { payload: { ...claimsOf(tokens), cnf: { jkt: await calculateJwkThumbprint(jwk) } } },
  });
  const proof = await new SignJWT({
    htm: "GET",
    htu: "http://localhost:3000/api/auth/oauth2/userinfo",
    ath: createHash("sha256").update(token).digest("base64url"),
  })
    .setProtectedHeader({ typ: "dpop+jwt", alg: "ES256", jwk })
    .setJti("profile-single-use")
    .setIssuedAt()
    .sign(privateKey);
  const request = () =>
    auth.handler(
      new Request("http://localhost:3000/api/auth/oauth2/userinfo", {
        headers: { ...authHeaders(), Authorization: `DPoP ${token}`, DPoP: proof },
      }),
    );
  expect((await userInfo(token)).status).toBe(401);
  expect((await request()).status).toBe(200);
  expect((await request()).status).toBe(401);
});

for (const explicitClient of [true, false])
  integration(
    `Introspection authenticates a private-key assertion once and rejects replay (${explicitClient ? "explicit client" : "assertion identity"})`,
    async () => {
      const tokens = await issuedTokens();
      const { publicKey, privateKey } = await generateKeyPair("RS256");
      const jwk = {
        ...(await exportJWK(publicKey)),
        kid: "introspection-key",
        alg: "RS256",
        use: "sig",
      };
      await admin.query(
        'update "oauthClient" set "tokenEndpointAuthMethod"=\'private_key_jwt\',"clientSecret"=null,"jwks"=$1 where "clientId"=\'client-a\'',
        [JSON.stringify({ keys: [jwk] })],
      );
      const assertion = await new SignJWT({})
        .setProtectedHeader({ alg: "RS256", kid: jwk.kid })
        .setIssuer("client-a")
        .setSubject("client-a")
        .setAudience("http://localhost:3000/api/auth/oauth2/introspect")
        .setJti(`introspect-single-use-${explicitClient}`)
        .setIssuedAt()
        .setExpirationTime("1m")
        .sign(privateKey);
      const request = () =>
        auth.handler(
          new Request("http://localhost:3000/api/auth/oauth2/introspect", {
            method: "POST",
            headers: { ...authHeaders(), "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
              ...(explicitClient ? { client_id: "client-a" } : {}),
              token: tokens.access_token,
              client_assertion: assertion,
              client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
            }),
          }),
        );
      expect(await (await request()).json()).toMatchObject({ active: true });
      expect([400, 401]).toContain((await request()).status);
    },
  );

integration("Opaque OAuth profile and introspection retain stored token ownership", async () => {
  await issuedTokens("client-a", "token-a", true);
  const token = "disposable-opaque-profile-token";
  await admin.query(
    `insert into "oauthAccessToken" ("id","token","userId","clientId","sessionId","scopes","resources","expiresAt","createdAt") values ('profile-opaque',$1,'alice','client-a','session-a',$2,$3,now()+interval '1 day',now())`,
    [
      createHash("sha256").update(token).digest("base64url"),
      JSON.stringify(["openid", "profile", "mcp:read"]),
      JSON.stringify([resource]),
    ],
  );
  const secret = await confidentialClient();
  expect((await userInfo(token)).status).toBe(200);
  expect(await (await introspect(token, secret)).json()).toMatchObject({
    active: true,
    sub: "alice",
  });
  await admin.query('update "session" set "userId"=\'bob\' where "id"=\'session-a\'');
  expect((await userInfo(token)).status).toBe(401);
  expect(await (await introspect(token, secret)).json()).toEqual({ active: false });
});

for (const kind of ["opaque", "refresh"])
  integration(
    `Queued ${kind} introspection rejects a credential deleted after protocol validation`,
    async () => {
      const tokens = await issuedTokens("client-a", "token-a", true);
      let token = tokens.refresh_token;
      if (kind === "opaque") {
        token = "disposable-queued-opaque-profile-token";
        await admin.query(
          `insert into "oauthAccessToken" ("id","token","userId","clientId","sessionId","scopes","resources","expiresAt","createdAt") values ('queued-profile-opaque',$1,'alice','client-a','session-a',$2,$3,now()+interval '1 day',now())`,
          [
            createHash("sha256").update(token).digest("base64url"),
            JSON.stringify(["openid", "profile", "mcp:read"]),
            JSON.stringify([resource]),
          ],
        );
      }
      const secret = await confidentialClient();
      await admin.query("begin");
      await admin.query("select pg_advisory_xact_lock(hashtextextended('mcp-consent:alice',0))");
      let read;
      try {
        read = introspect(token, secret, kind === "opaque" ? "access_token" : "refresh_token");
        await waitingRuntime();
        await admin.query(
          `delete from "${kind === "opaque" ? "oauthAccessToken" : "oauthRefreshToken"}" where "token"=$1`,
          [createHash("sha256").update(token).digest("base64url")],
        );
        await admin.query("commit");
        expect(await (await read).json()).toEqual({ active: false });
      } finally {
        await admin.query("rollback");
        await read?.catch(() => {});
      }
    },
  );

function approveConsent(query, token = "token-a", extra = {}) {
  return sessionHeaders(token).then((headers) => {
    headers.set("Content-Type", "application/json");
    headers.set("Origin", "http://localhost:3000");
    return auth.handler(
      new Request("http://localhost:3000/api/auth/oauth2/consent", {
        method: "POST",
        headers,
        body: JSON.stringify({
          accept: true,
          oauth_query: query.query,
          tidy_consent: query.binding,
          ...extra,
        }),
      }),
    );
  });
}
integration(
  "Consent approval rolls back consent and its epoch when code publication fails",
  async () => {
    const query = await authorizationCode("client-a", "token-a", false, true);
    await admin.query('delete from "oauthConsent" where "clientId"=\'client-a\'');
    const context = await auth.$context,
      create = context.adapter.create;
    const spy = spyOn(context.adapter, "create").mockImplementation(async (...args) => {
      if (
        args[0]?.model === "verification" &&
        JSON.parse(args[0]?.data?.value ?? "{}").type === "authorization_code"
      )
        throw new Error("DISPOSABLE_PRIVATE_CONSENT_STORAGE_FAILURE");
      return create(...args);
    });
    let approval;
    try {
      approval = approveConsent(query);
      const response = await approval;
      expect(response.status).toBe(500);
      expect(await response.text()).not.toContain("DISPOSABLE_PRIVATE");
      expect(
        (
          await admin.query(
            'select count(*)::int as n from "oauthConsent" where "userId"=\'alice\' and "clientId"=\'client-a\'',
          )
        ).rows[0].n,
      ).toBe(0);
      expect(await hasMcpAuthorization(grant().claims, resource)).toBe(false);
      expect(
        (
          await admin.query(
            'select count(*)::int as n from "verification" where "id" like \'mcp-grant:%\'',
          )
        ).rows[0].n,
      ).toBe(0);
    } finally {
      await approval?.catch(() => {});
      spy.mockRestore();
    }
  },
);

integration("Consent captured before revocation cannot restore the ended grant", async () => {
  const query = await authorizationCode("client-a", "token-a", false, true);
  await revokeMcpAuthorization("alice", "client-a");
  expect((await approveConsent(query)).status).not.toBe(200);
  expect(
    (
      await admin.query(
        'select count(*)::int as n from "oauthConsent" where "userId"=\'alice\' and "clientId"=\'client-a\'',
      )
    ).rows[0].n,
  ).toBe(0);
});

function consentCode(response) {
  return response.json().then((body) => new URL(body.url).searchParams.get("code"));
}
integration(
  "Consent approves the displayed grant once, fences old tokens and preserves other clients",
  async () => {
    const old = await issuedTokens();
    const outstanding = await authorizationCode();
    await admin.query(
      `insert into "oauthConsent" ("id","userId","clientId","resources","scopes","createdAt","updatedAt") values ('bob-same-client','bob','client-a',$1,'["mcp:read","mcp:write","offline_access"]',now(),now())`,
      [JSON.stringify([resource])],
    );
    const bob = await issuedTokens("client-a", "token-b");
    await admin.query(
      `insert into "oauthConsent" ("id","userId","clientId","resources","scopes","createdAt","updatedAt") values ('alice-other','alice','client-b',$1,'["mcp:read","mcp:write","offline_access"]',now(),now())`,
      [JSON.stringify([resource])],
    );
    const other = await issuedTokens("client-b");
    const prompt = await authorizationCode("client-a", "token-a", false, true);
    const response = await approveConsent(prompt);
    expect(response.status).toBe(200);
    const code = await consentCode(response);
    expect(code).toBeTruthy();
    const exchange = await exchangeCode(code);
    expect(exchange.status).toBe(200);
    const current = await exchange.json();
    expect(await hasMcpAuthorization(claimsOf(current), resource)).toBe(true);
    expect(await hasMcpAuthorization(claimsOf(old), resource)).toBe(false);
    expect(await hasMcpAuthorization(claimsOf(other), resource)).toBe(true);
    expect(await hasMcpAuthorization(claimsOf(bob), resource)).toBe(true);
    expect((await exchangeCode(outstanding)).status).toBe(400);
    expect((await approveConsent(prompt)).status).toBe(400);
    expect(await hasMcpAuthorization(claimsOf(current), resource)).toBe(true);
  },
);

integration("A fresh reviewed consent page can reconnect after revocation", async () => {
  const stale = await authorizationCode("client-a", "token-a", false, true);
  await revokeMcpAuthorization("alice", "client-a");
  expect((await approveConsent(stale)).status).toBe(400);
  const fresh = await authorizationCode("client-a", "token-a", false, true);
  const response = await approveConsent(fresh);
  expect(response.status).toBe(200);
  const exchange = await exchangeCode(await consentCode(response));
  expect(exchange.status).toBe(200);
  expect(await hasMcpAuthorization(claimsOf(await exchange.json()), resource)).toBe(true);
  expect(
    (
      await admin.query(
        'select count(*)::int as n from "verification" where "id" like \'mcp-grant:%\'',
      )
    ).rows[0].n,
  ).toBe(1);
});

integration("Consent requires the exact displayed account and session", async () => {
  const prompt = await authorizationCode("client-a", "token-a", false, true);
  expect((await approveConsent(prompt, "token-b")).status).toBe(400);
  await admin.query(
    'insert into "session" ("id","token","userId","expiresAt","updatedAt") values (\'session-a2\',\'token-a2\',\'alice\',now()+interval \'1 day\',now())',
  );
  expect((await approveConsent(prompt, "token-a2")).status).toBe(400);
  expect(
    (
      await admin.query(
        'select count(*)::int as n from "oauthConsent" where "userId"=\'bob\' and "clientId"=\'client-a\'',
      )
    ).rows[0].n,
  ).toBe(0);
  expect(
    (
      await admin.query(
        'select count(*)::int as n from "verification" where "id" like \'mcp-grant:%\'',
      )
    ).rows[0].n,
  ).toBe(0);
});

integration("Consent refuses missing/tampered proofs and a different displayed query", async () => {
  const prompt = await authorizationCode("client-a", "token-a", false, true);
  for (const extra of [
    { tidy_consent: undefined },
    { tidy_consent: "forged" },
    { tidy_consent: `${prompt.binding}x` },
    { oauth_query: (await authorizationCode("client-b", "token-b", false, true)).query },
    { scope: "mcp:read mcp:write invented:scope" },
  ])
    expect([400, 401]).toContain((await approveConsent(prompt, "token-a", extra)).status);
  expect(
    (
      await admin.query(
        'select count(*)::int as n from "verification" where "id" like \'mcp-grant:%\'',
      )
    ).rows[0].n,
  ).toBe(0);
  expect((await admin.query('select count(*)::int as n from "oauthRefreshToken"')).rows[0].n).toBe(
    0,
  );
});

integration("Consent denial preserves existing tokens and returns only access_denied", async () => {
  const tokens = await issuedTokens();
  const prompt = await authorizationCode("client-a", "token-a", false, true);
  const response = await approveConsent(prompt, "token-a", { accept: false });
  expect(response.status).toBe(200);
  const body = await response.json(),
    url = new URL(body.url);
  expect(url.searchParams.get("error")).toBe("access_denied");
  expect(url.searchParams.get("code")).toBeNull();
  expect(await hasMcpAuthorization(claimsOf(tokens), resource)).toBe(true);
});

integration(
  "Consent can approve a subset of scopes without restoring old broad grants",
  async () => {
    const tokens = await issuedTokens();
    const prompt = await authorizationCode("client-a", "token-a", false, true);
    const response = await approveConsent(prompt, "token-a", { scope: "mcp:read" });
    expect(response.status).toBe(200);
    const exchange = await exchangeCode(await consentCode(response));
    expect(exchange.status).toBe(200);
    const current = await exchange.json();
    expect(current.scope).toBe("mcp:read");
    expect(await hasMcpAuthorization(claimsOf(current), resource, ["mcp:read"])).toBe(true);
    expect(await hasMcpAuthorization(claimsOf(current), resource, ["mcp:write"])).toBe(false);
    expect(await hasMcpAuthorization(claimsOf(tokens), resource)).toBe(false);
  },
);

for (const [name, sql] of Object.entries({
  verification: 'update "user" set "emailVerified"=false where "id"=\'alice\'',
  session: 'delete from "session" where "id"=\'session-a\'',
  sessionOwner: 'update "session" set "userId"=\'bob\' where "id"=\'session-a\'',
  client: 'update "oauthClient" set "disabled"=true where "clientId"=\'client-a\'',
  resource: 'update "oauthResource" set "disabled"=true',
  link: 'delete from "oauthClientResource" where "clientId"=\'client-a\'',
}))
  integration(`Consent cannot persist after ${name} authority ends`, async () => {
    const prompt = await authorizationCode("client-a", "token-a", false, true);
    await admin.query('delete from "oauthConsent" where "clientId"=\'client-a\'');
    await admin.query(sql);
    expect([400, 401, 403]).toContain((await approveConsent(prompt)).status);
    expect(
      (
        await admin.query(
          'select count(*)::int as n from "oauthConsent" where "userId"=\'alice\' and "clientId"=\'client-a\'',
        )
      ).rows[0].n,
    ).toBe(0);
    expect(
      (
        await admin.query(
          'select count(*)::int as n from "verification" where "id" like \'mcp-grant:%\'',
        )
      ).rows[0].n,
    ).toBe(0);
  });

integration("Consent queued behind actual revocation rejects the old displayed epoch", async () => {
  const prompt = await authorizationCode("client-a", "token-a", false, true);
  await admin.query("begin");
  await admin.query('select "id" from "user" where "id"=\'alice\' for update');
  let revocation, approval;
  try {
    revocation = revokeMcpAuthorization("alice", "client-a");
    await waitingRuntime("transactionid");
    approval = approveConsent(prompt);
    await waitingRuntime();
    await admin.query("commit");
    await revocation;
    expect((await approval).status).toBe(400);
    expect(
      (
        await admin.query(
          'select count(*)::int as n from "oauthConsent" where "userId"=\'alice\' and "clientId"=\'client-a\'',
        )
      ).rows[0].n,
    ).toBe(0);
  } finally {
    await admin.query("rollback");
    await revocation?.catch(() => {});
    await approval?.catch(() => {});
  }
});

integration(
  "Admitted consent retains its session, then queued revocation invalidates the new code",
  async () => {
    const prompt = await authorizationCode("client-a", "token-a", false, true);
    const context = await auth.$context,
      create = context.adapter.create,
      held = pause();
    const spy = spyOn(context.adapter, "create").mockImplementation(async (...args) => {
      if (
        args[0]?.model === "verification" &&
        JSON.parse(args[0]?.data?.value ?? "{}").type === "authorization_code"
      )
        await held.hook();
      return create(...args);
    });
    const control = new Client({ connectionString: setupUrl });
    await control.connect();
    let approval, revocation;
    try {
      approval = approveConsent(prompt);
      await Promise.race([
        held.entered,
        approval.then((response) => {
          throw new Error(`Approval ended before code publication: ${response.status}`);
        }),
      ]);
      revocation = revokeMcpAuthorization("alice", "client-a");
      await waitingRuntime();
      await control.query("set lock_timeout='500ms'");
      await expect(
        control.query('delete from "session" where "id"=\'session-a\''),
      ).rejects.toMatchObject({ code: "55P03" });
      held.release();
      const response = await approval;
      expect(response.status).toBe(200);
      const code = await consentCode(response);
      await revocation;
      expect((await exchangeCode(code)).status).toBe(400);
    } finally {
      held.release();
      await approval?.catch(() => {});
      await revocation?.catch(() => {});
      spy.mockRestore();
      await control.end();
    }
  },
);

integration("Consent checks proof expiry after queued admission", async () => {
  const prompt = await authorizationCode("client-a", "token-a", false, true);
  const payload = JSON.parse(Buffer.from(prompt.binding.split(".")[0], "base64url").toString());
  payload.expiresAt = Date.now() + 600;
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  prompt.binding = `${encoded}.${createHmac("sha256", process.env.BETTER_AUTH_SECRET).update(`tidy-consent:${encoded}`).digest("base64url")}`;
  await admin.query("begin");
  await admin.query("select pg_advisory_xact_lock(hashtextextended('mcp-consent:alice',0))");
  let approval;
  try {
    approval = approveConsent(prompt);
    await waitingRuntime();
    await Bun.sleep(700);
    await admin.query("commit");
    expect((await approval).status).toBe(400);
    expect(
      (
        await admin.query(
          'select count(*)::int as n from "verification" where "id" like \'mcp-grant:%\'',
        )
      ).rows[0].n,
    ).toBe(0);
  } finally {
    await admin.query("rollback");
    await approval?.catch(() => {});
  }
});

integration(
  "Consent server APIs require the same displayed proof; unused continuation HTTP is closed",
  async () => {
    const prompt = await authorizationCode("client-a", "token-a", false, true);
    const headers = await sessionHeaders();
    const request = new Request("http://localhost:3000/api/auth/oauth2/consent", {
      method: "POST",
      headers,
    });
    const result = await auth.api.oauth2Consent({
      asResponse: false,
      request,
      headers,
      body: { accept: true, oauth_query: prompt.query, tidy_consent: prompt.binding },
    });
    expect(new URL(result.url).searchParams.get("code")).toBeTruthy();
    await expect(
      auth.api.oauth2Consent({
        asResponse: false,
        request,
        headers,
        body: { accept: true, oauth_query: prompt.query, tidy_consent: prompt.binding },
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
    for (const headers of [new Headers(authHeaders()), await sessionHeaders()]) {
      headers.set("Content-Type", "application/json");
      expect(
        (
          await auth.handler(
            new Request("http://localhost:3000/api/auth/oauth2/continue", {
              method: "POST",
              headers,
              body: JSON.stringify({ selected: true, oauth_query: prompt.query }),
            }),
          )
        ).status,
      ).toBe(404);
    }
  },
);

integration("Concurrent approvals of one displayed proof publish exactly one code", async () => {
  const prompt = await authorizationCode("client-a", "token-a", false, true);
  const responses = await Promise.all(Array.from({ length: 6 }, () => approveConsent(prompt)));
  expect(responses.filter((response) => response.status === 200)).toHaveLength(1);
  expect(responses.filter((response) => response.status === 400)).toHaveLength(5);
  expect(
    (
      await admin.query(
        'select count(*)::int as n from "verification" where "value" like \'%"type":"authorization_code"%\'',
      )
    ).rows[0].n,
  ).toBe(1);
  expect(
    (
      await admin.query(
        'select count(*)::int as n from "verification" where "id" like \'mcp-grant:%\'',
      )
    ).rows[0].n,
  ).toBe(1);
});

integration(
  "Consent proof expiry during code publication rolls back the code and epoch",
  async () => {
    const prompt = await authorizationCode("client-a", "token-a", false, true);
    const payload = JSON.parse(Buffer.from(prompt.binding.split(".")[0], "base64url").toString());
    payload.expiresAt = Date.now() + 600;
    const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
    prompt.binding = `${encoded}.${createHmac("sha256", process.env.BETTER_AUTH_SECRET).update(`tidy-consent:${encoded}`).digest("base64url")}`;
    const context = await auth.$context,
      create = context.adapter.create;
    const spy = spyOn(context.adapter, "create").mockImplementation(async (...args) => {
      if (
        args[0]?.model === "verification" &&
        JSON.parse(args[0]?.data?.value ?? "{}").type === "authorization_code"
      )
        await Bun.sleep(700);
      return create(...args);
    });
    try {
      expect((await approveConsent(prompt)).status).toBe(400);
      expect(
        (
          await admin.query(
            'select count(*)::int as n from "verification" where "id" like \'mcp-grant:%\' or "value" like \'%"type":"authorization_code"%\'',
          )
        ).rows[0].n,
      ).toBe(0);
    } finally {
      spy.mockRestore();
    }
  },
);

integration("OAuth protocol refresh revocation invalidates its signed access tokens", async () => {
  const tokens = await issuedTokens();
  expect((await protocolRevoke(tokens.refresh_token)).status).toBe(200);
  const claims = JSON.parse(Buffer.from(tokens.access_token.split(".")[1], "base64url").toString());
  expect(await hasMcpAuthorization(claims, resource)).toBe(false);
});

integration(
  "OAuth protocol revoked refresh from another client cannot delete the authenticated client's family",
  async () => {
    const first = await issuedTokens();
    expect((await refreshToken(first.refresh_token)).status).toBe(200);
    await admin.query(
      `insert into "oauthConsent" ("id","clientId","userId","resources","scopes","createdAt","updatedAt")
    values ('alice-b','client-b','alice',$1,'["mcp:read","mcp:write"]',now(),now())`,
      [JSON.stringify([resource])],
    );
    const second = await issuedTokens("client-b");
    expect((await protocolRevoke(first.refresh_token, "client-b")).status).toBe(200);
    expect((await refreshToken(second.refresh_token, "client-b")).status).toBe(200);
  },
);

integration(
  "OAuth protocol JWT revocation rejects forged signatures and cannot revoke a new consent generation with an old token",
  async () => {
    const first = await issuedTokens();
    const oldClaims = claimsOf(first);
    const parts = first.access_token.split(".");
    parts[2] = `${parts[2][0] === "a" ? "b" : "a"}${parts[2].slice(1)}`;
    expect((await protocolRevoke(parts.join("."), "client-a", "access_token")).status).toBe(200);
    expect(await hasMcpAuthorization(oldClaims, resource)).toBe(true);
    expect((await protocolRevoke(first.access_token, "client-a", "access_token")).status).toBe(200);
    expect(await hasMcpAuthorization(oldClaims, resource)).toBe(false);
    await admin.query(
      `insert into "oauthConsent" ("id","clientId","userId","resources","scopes","createdAt","updatedAt")
    values ('renewed','client-a','alice',$1,'["mcp:read","mcp:write"]',now(),now())`,
      [JSON.stringify([resource])],
    );
    const renewed = await issuedTokens();
    expect((await protocolRevoke(first.access_token, "client-a", "access_token")).status).toBe(200);
    expect(await hasMcpAuthorization(claimsOf(renewed), resource)).toBe(true);
    expect((await refreshToken(renewed.refresh_token)).status).toBe(200);
  },
);

integration(
  "OAuth protocol revocation isolates users sharing a client and ignores unknown tokens without permanent markers",
  async () => {
    const alice = await issuedTokens();
    await admin.query(
      `insert into "oauthConsent" ("id","clientId","userId","resources","scopes","createdAt","updatedAt")
    values ('bob-a','client-a','bob',$1,'["mcp:read","mcp:write"]',now(),now())`,
      [JSON.stringify([resource])],
    );
    const bob = await issuedTokens("client-a", "token-b");
    expect((await protocolRevoke(alice.refresh_token)).status).toBe(200);
    expect(await hasMcpAuthorization(claimsOf(alice), resource)).toBe(false);
    expect(await hasMcpAuthorization(claimsOf(bob), resource)).toBe(true);
    const markers = () =>
      admin.query('select count(*)::int as n from "verification" where "id" like \'mcp-grant:%\'');
    expect((await markers()).rows[0].n).toBe(1);
    expect((await protocolRevoke("unknown-disposable-token")).status).toBe(200);
    expect((await markers()).rows[0].n).toBe(1);
    expect((await refreshToken(bob.refresh_token)).status).toBe(200);
  },
);

for (const method of ["client_secret_post", "client_secret_basic"])
  integration(`OAuth protocol revocation retains provider ${method} authentication`, async () => {
    const tokens = await issuedTokens();
    const secret = "disposable-rfc-revocation-client-secret";
    await admin.query(
      'update "oauthClient" set "tokenEndpointAuthMethod"=$1,"clientSecret"=$2 where "clientId"=\'client-a\'',
      [method, createHash("sha256").update(secret).digest("base64url")],
    );
    const revoke = (clientSecret) => {
      const headers = { ...authHeaders(), "Content-Type": "application/x-www-form-urlencoded" };
      const body = new URLSearchParams({
        token: tokens.refresh_token,
        token_type_hint: "refresh_token",
      });
      if (method === "client_secret_post") {
        body.set("client_id", "client-a");
        body.set("client_secret", clientSecret);
      } else
        headers.Authorization = `Basic ${Buffer.from(`client-a:${clientSecret}`).toString("base64")}`;
      return auth.handler(
        new Request("http://localhost:3000/api/auth/oauth2/revoke", {
          method: "POST",
          headers,
          body,
        }),
      );
    };
    expect([400, 401]).toContain((await revoke("wrong-secret")).status);
    expect(await hasMcpAuthorization(claimsOf(tokens), resource)).toBe(true);
    expect((await revoke(secret)).status).toBe(200);
    expect(await hasMcpAuthorization(claimsOf(tokens), resource)).toBe(false);
  });

integration(
  "OAuth protocol private-key assertions authenticate once and retain replay/audience enforcement",
  async () => {
    const tokens = await issuedTokens();
    const keys = await generateKeyPair("RS256");
    const jwk = {
      ...(await exportJWK(keys.publicKey)),
      kid: "fixture-client-key",
      alg: "RS256",
      use: "sig",
    };
    await admin.query(
      'update "oauthClient" set "tokenEndpointAuthMethod"=\'private_key_jwt\',"clientSecret"=null,"jwks"=$1 where "clientId"=\'client-a\'',
      [JSON.stringify({ keys: [jwk] })],
    );
    const assertion = (audience, id) =>
      new SignJWT({})
        .setProtectedHeader({ alg: "RS256", kid: jwk.kid })
        .setIssuer("client-a")
        .setSubject("client-a")
        .setAudience(audience)
        .setJti(id)
        .setIssuedAt()
        .setExpirationTime("1m")
        .sign(keys.privateKey);
    const revoke = (jwt) =>
      auth.handler(
        new Request("http://localhost:3000/api/auth/oauth2/revoke", {
          method: "POST",
          headers: { ...authHeaders(), "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            client_id: "client-a",
            token: tokens.refresh_token,
            token_type_hint: "refresh_token",
            client_assertion: jwt,
            client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
          }),
        }),
      );
    const wrong = await assertion("http://localhost:3000/api/auth/oauth2/token", "wrong-endpoint");
    expect([400, 401]).toContain((await revoke(wrong)).status);
    expect(await hasMcpAuthorization(claimsOf(tokens), resource)).toBe(true);
    const valid = await assertion("http://localhost:3000/api/auth/oauth2/revoke", "once-only");
    expect((await revoke(valid)).status).toBe(200);
    expect(await hasMcpAuthorization(claimsOf(tokens), resource)).toBe(false);
    expect([400, 401]).toContain((await revoke(valid)).status);
  },
);

integration(
  "OAuth protocol revocation holds the refresh gate before queued rotation and removes its entire family",
  async () => {
    const tokens = await issuedTokens();
    await admin.query("begin");
    await admin.query('select "id" from "user" where "id"=\'alice\' for update');
    let revocation, refresh;
    try {
      revocation = protocolRevoke(tokens.refresh_token);
      await waitingRuntime("transactionid");
      refresh = refreshToken(tokens.refresh_token);
      await waitingRuntime();
      await admin.query("commit");
      expect((await revocation).status).toBe(200);
      expect((await refresh).status).toBe(400);
      expect(await hasMcpAuthorization(claimsOf(tokens), resource)).toBe(false);
      expect(
        (await admin.query('select count(*)::int as n from "oauthRefreshToken"')).rows[0].n,
      ).toBe(0);
    } finally {
      await admin.query("rollback");
      await Promise.allSettled([revocation, refresh].filter(Boolean));
    }
  },
);

integration(
  "OAuth admitted refresh commits before protocol revocation, which removes the newly rotated family",
  async () => {
    const tokens = await issuedTokens();
    const adapter = (await auth.$context).adapter;
    const original = adapter.create;
    const held = pause();
    const insert = spyOn(adapter, "create").mockImplementation(async (...args) => {
      if (args[0].model === "oauthRefreshToken") await held.hook();
      return Reflect.apply(original, adapter, args);
    });
    let refresh, revocation;
    try {
      refresh = refreshToken(tokens.refresh_token);
      await held.entered;
      revocation = protocolRevoke(tokens.refresh_token);
      await waitingRuntime();
      held.release();
      const response = await refresh;
      expect(response.status).toBe(200);
      const replacement = await response.json();
      expect((await revocation).status).toBe(200);
      expect(await hasMcpAuthorization(claimsOf(replacement), resource)).toBe(false);
      expect((await refreshToken(replacement.refresh_token)).status).toBe(400);
    } finally {
      held.release();
      await Promise.allSettled([refresh, revocation].filter(Boolean));
      insert.mockRestore();
    }
  },
);

integration(
  "OAuth private and admin client-management endpoints are unavailable over HTTP",
  async () => {
    const requests = [
      ["GET", "/oauth2/get-client?client_id=client-a"],
      ["GET", "/oauth2/get-clients"],
      ["POST", "/oauth2/create-client"],
      ["POST", "/oauth2/update-client"],
      ["POST", "/oauth2/client/rotate-secret"],
      ["POST", "/oauth2/delete-client"],
      ["POST", "/admin/oauth2/create-client"],
      ["PATCH", "/admin/oauth2/update-client"],
      ["POST", "/admin/oauth2/resources"],
      ["DELETE", "/admin/oauth2/resources/resource"],
    ];
    for (const signedIn of [false, true]) {
      const headers = signedIn ? await sessionHeaders() : new Headers(authHeaders());
      headers.set("Origin", "http://localhost:3000");
      headers.set("Content-Type", "application/json");
      for (const [method, path] of requests) {
        const response = await auth.handler(
          new Request(`http://localhost:3000/api/auth${path}`, {
            method,
            headers,
            ...(method !== "GET"
              ? { body: JSON.stringify({ client_id: "client-a", update: { scope: "mcp:read" } }) }
              : {}),
          }),
        );
        expect(response.status).toBe(404);
      }
    }
    expect((await admin.query('select count(*)::int as n from "oauthClient"')).rows[0].n).toBe(2);
  },
);

integration(
  "OAuth expired stored credentials cannot revoke a current grant generation",
  async () => {
    const tokens = await issuedTokens();
    await admin.query(
      'update "oauthRefreshToken" set "expiresAt"=now()-interval \'1 minute\' where "clientId"=\'client-a\'',
    );
    expect((await protocolRevoke(tokens.refresh_token)).status).toBe(200);
    expect(await hasMcpAuthorization(claimsOf(tokens), resource)).toBe(true);
    expect(
      (
        await admin.query(
          'select count(*)::int as n from "verification" where "id" like \'mcp-grant:%\'',
        )
      ).rows[0].n,
    ).toBe(0);
  },
);

integration(
  "OAuth userless opaque revocation requires its exact client and creates no personal state",
  async () => {
    await authorizationCode(); // Configure the legitimate public fixture client.
    await admin.query(
      'update "oauthClient" set "tokenEndpointAuthMethod"=\'none\' where "clientId"=\'client-b\'',
    );
    const token = "disposable-opaque-service-token";
    await admin.query(
      `insert into "oauthAccessToken" ("id","token","clientId","scopes","expiresAt","createdAt")
    values ('service-token',$1,'client-a','["mcp:read"]',now()+interval '1 day',now())`,
      [createHash("sha256").update(token).digest("base64url")],
    );
    expect((await protocolRevoke(token, "client-b", "access_token")).status).toBe(200);
    expect((await admin.query('select count(*)::int as n from "oauthAccessToken"')).rows[0].n).toBe(
      1,
    );
    expect((await protocolRevoke(token, "client-a", "access_token")).status).toBe(200);
    expect((await admin.query('select count(*)::int as n from "oauthAccessToken"')).rows[0].n).toBe(
      0,
    );
    expect(
      (
        await admin.query(
          'select count(*)::int as n from "verification" where "id" like \'mcp-grant:%\'',
        )
      ).rows[0].n,
    ).toBe(0);
  },
);

integration(
  "OAuth protocol revocation queued across credential rotation requires a fresh client proof",
  async () => {
    const tokens = await issuedTokens();
    const oldSecret = "disposable-old-proof",
      newSecret = "disposable-new-proof";
    const hash = (value) => createHash("sha256").update(value).digest("base64url");
    await admin.query(
      'update "oauthClient" set "tokenEndpointAuthMethod"=\'client_secret_post\',"clientSecret"=$1 where "clientId"=\'client-a\'',
      [hash(oldSecret)],
    );
    const revoke = (secret) =>
      auth.handler(
        new Request("http://localhost:3000/api/auth/oauth2/revoke", {
          method: "POST",
          headers: { ...authHeaders(), "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            client_id: "client-a",
            client_secret: secret,
            token: tokens.refresh_token,
          }),
        }),
      );
    await admin.query("begin");
    await admin.query("select pg_advisory_xact_lock(hashtextextended('mcp-consent:alice',0))");
    let pending;
    try {
      pending = revoke(oldSecret);
      await waitingRuntime();
      await admin.query(
        'update "oauthClient" set "clientSecret"=$1 where "clientId"=\'client-a\'',
        [hash(newSecret)],
      );
      await admin.query("commit");
      expect((await pending).status).toBe(400);
      expect(await hasMcpAuthorization(claimsOf(tokens), resource)).toBe(true);
      expect((await revoke(newSecret)).status).toBe(200);
      expect(await hasMcpAuthorization(claimsOf(tokens), resource)).toBe(false);
    } finally {
      await admin.query("rollback");
      await pending;
    }
  },
);

integration(
  "MCP revocation fences outstanding authorization codes even after reconsent",
  async () => {
    const code = await authorizationCode();
    await revokeMcpAuthorization("alice", "client-a");
    await admin.query(
      `insert into "oauthConsent" ("id","clientId","userId","resources","scopes","createdAt","updatedAt")
    values ('new-consent','client-a','alice',$1,'["mcp:read","mcp:write","offline_access"]',now(),now())`,
      [JSON.stringify([resource])],
    );
    const old = await exchangeCode(code);
    expect(old.status).toBe(400);
    const fresh = await exchangeCode(await authorizationCode());
    expect(fresh.status).toBe(200);
  },
);

for (const kind of ["code", "refresh"])
  integration(
    `OAuth ${kind} issuance queued behind actual UI revocation cannot restore tokens`,
    async () => {
      const credential =
        kind === "code" ? await authorizationCode() : (await issuedTokens()).refresh_token;
      await admin.query("begin");
      await admin.query('select "id" from "user" where "id"=\'alice\' for update');
      let revocation, exchange;
      try {
        revocation = revokeMcpAuthorization("alice", "client-a");
        // The real revoker takes its exclusive account gate, then waits for the
        // verified-user row. A token request must queue behind that account gate.
        await waitingRuntime("transactionid");
        exchange = kind === "code" ? exchangeCode(credential) : refreshToken(credential);
        await waitingRuntime();
        await admin.query("commit");
        await revocation;
        expect((await exchange).status).toBe(400);
        expect(
          (await admin.query('select count(*)::int as n from "oauthRefreshToken"')).rows[0].n,
        ).toBe(0);
        expect(
          (await admin.query('select count(*)::int as n from "oauthAccessToken"')).rows[0].n,
        ).toBe(0);
      } finally {
        await admin.query("rollback");
        await Promise.allSettled([revocation, exchange].filter(Boolean));
      }
    },
  );

for (const kind of ["code", "refresh"])
  integration(
    `OAuth admitted ${kind} issuance commits before queued UI revocation removes its tokens`,
    async () => {
      const credential =
        kind === "code" ? await authorizationCode() : (await issuedTokens()).refresh_token;
      const adapter = (await auth.$context).adapter;
      const original = adapter.create;
      const held = pause();
      const insert = spyOn(adapter, "create").mockImplementation(async (...args) => {
        if (args[0].model === "oauthRefreshToken") await held.hook();
        return Reflect.apply(original, adapter, args);
      });
      let exchange, revocation;
      try {
        exchange = kind === "code" ? exchangeCode(credential) : refreshToken(credential);
        await held.entered;
        revocation = revokeMcpAuthorization("alice", "client-a");
        await waitingRuntime();
        held.release();
        const response = await exchange;
        expect(response.status).toBe(200);
        const tokens = await response.json();
        await revocation;
        const claims = JSON.parse(
          Buffer.from(tokens.access_token.split(".")[1], "base64url").toString(),
        );
        expect(await hasMcpAuthorization(claims, resource)).toBe(false);
        expect((await refreshToken(tokens.refresh_token)).status).toBe(400);
        expect(
          (await admin.query('select count(*)::int as n from "oauthRefreshToken"')).rows[0].n,
        ).toBe(0);
      } finally {
        held.release();
        await Promise.allSettled([exchange, revocation].filter(Boolean));
        insert.mockRestore();
      }
    },
  );

integration(
  "OAuth concurrent refresh retries return one rotation, and expired replay cleanup commits",
  async () => {
    const token = (await issuedTokens()).refresh_token;
    const responses = await Promise.all(Array.from({ length: 6 }, () => refreshToken(token)));
    expect(responses.map((response) => response.status)).toEqual(Array(6).fill(200));
    const bodies = await Promise.all(responses.map((response) => response.json()));
    expect(new Set(bodies.map((body) => body.refresh_token)).size).toBe(1);
    expect(new Set(bodies.map((body) => body.access_token)).size).toBe(1);
    expect(
      (await admin.query('select count(*)::int as n from "oauthRefreshToken"')).rows[0].n,
    ).toBe(2);
    await admin.query(`update "oauthRefreshToken" set "rotationReplayExpiresAt"=now()-interval '1 minute',
    "rotatedAt"=now()-interval '1 minute' where "revoked" is not null`);
    expect((await refreshToken(token)).status).toBe(400);
    expect(
      (await admin.query('select count(*)::int as n from "oauthRefreshToken"')).rows[0].n,
    ).toBe(0);
    for (const tokens of [bodies[0]]) {
      const claims = JSON.parse(
        Buffer.from(tokens.access_token.split(".")[1], "base64url").toString(),
      );
      expect(await hasMcpAuthorization(claims, resource)).toBe(false);
    }
  },
);

integration(
  "OAuth consumed-code replay invalidates its JWT family and cannot resurrect after reconsent",
  async () => {
    const code = await authorizationCode();
    const tokens = await (await exchangeCode(code)).json();
    const claims = JSON.parse(
      Buffer.from(tokens.access_token.split(".")[1], "base64url").toString(),
    );
    expect(await hasMcpAuthorization(claims, resource)).toBe(true);
    expect((await exchangeCode(code)).status).toBe(400);
    expect(await hasMcpAuthorization(claims, resource)).toBe(false);
    expect((await refreshToken(tokens.refresh_token)).status).toBe(400);
    await admin.query(
      `insert into "oauthConsent" ("id","clientId","userId","resources","scopes","createdAt","updatedAt")
    values ('reconsent','client-a','alice',$1,'["mcp:read","mcp:write"]',now(),now())`,
      [JSON.stringify([resource])],
    );
    expect(await hasMcpAuthorization(claims, resource)).toBe(false);
    expect(
      await hasMcpAuthorization(
        grant({ sub: "bob", client_id: "client-b", sid: "session-b" }).claims,
        resource,
      ),
    ).toBe(true);
    expect((await exchangeCode(await authorizationCode())).status).toBe(200);
  },
);

for (const method of ["delete-consent", "update-consent"])
  integration(
    `OAuth provider ${method} invalidates JWTs and outstanding codes across renewed consent`,
    async () => {
      const tokens = await issuedTokens();
      const code = await authorizationCode();
      const claims = JSON.parse(
        Buffer.from(tokens.access_token.split(".")[1], "base64url").toString(),
      );
      const headers = await sessionHeaders();
      headers.set("Content-Type", "application/json");
      headers.set("Origin", "http://localhost:3000");
      const response = await auth.handler(
        new Request(`http://localhost:3000/api/auth/oauth2/${method}`, {
          method: "POST",
          headers,
          body: JSON.stringify({ id: "consent-a", update: { scopes: ["mcp:read"] } }),
        }),
      );
      expect(response.status).toBe(200);
      expect(await hasMcpAuthorization(claims, resource)).toBe(false);
      expect((await refreshToken(tokens.refresh_token)).status).toBe(400);
      if (method === "delete-consent")
        await admin.query(
          `insert into "oauthConsent" ("id","clientId","userId","resources","scopes","createdAt","updatedAt")
        values ('renewed','client-a','alice',$1,'["mcp:read","mcp:write"]',now(),now())`,
          [JSON.stringify([resource])],
        );
      else
        await admin.query(
          'update "oauthConsent" set "scopes"=\'["mcp:read","mcp:write"]\' where "id"=\'consent-a\'',
        );
      expect(await hasMcpAuthorization(claims, resource)).toBe(false);
      expect((await exchangeCode(code)).status).toBe(400);
      expect((await exchangeCode(await authorizationCode())).status).toBe(200);
    },
  );

integration(
  "OAuth provider consent mutations reject foreign accounts and preserve the owner's grant",
  async () => {
    const tokens = await issuedTokens();
    const headers = await sessionHeaders("token-b");
    headers.set("Content-Type", "application/json");
    headers.set("Origin", "http://localhost:3000");
    for (const method of ["delete-consent", "update-consent"]) {
      const response = await auth.handler(
        new Request(`http://localhost:3000/api/auth/oauth2/${method}`, {
          method: "POST",
          headers,
          body: JSON.stringify({ id: "consent-a", update: { scopes: [] } }),
        }),
      );
      expect(response.status).toBe(404);
    }
    const claims = JSON.parse(
      Buffer.from(tokens.access_token.split(".")[1], "base64url").toString(),
    );
    expect(await hasMcpAuthorization(claims, resource)).toBe(true);
  },
);

integration(
  "Parallel transaction failures cannot write through a released database scope",
  async () => {
    const client = await db.connect();
    const held = pause();
    let child;
    try {
      await client.query("begin");
      await expect(
        inDatabaseScope(client, async () => {
          const borrowed = scopedDatabaseClient();
          child = (async () => {
            await held.hook();
            await expect(
              (async () =>
                borrowed.query('update "designFile" set "name"=\'Late\' where "id"=\'file-a\''))(),
            ).rejects.toThrow("scope has ended");
            await expect(
              (async () =>
                db.query('update "designFile" set "name"=\'Late\' where "id"=\'file-a\''))(),
            ).rejects.toThrow("scope has ended");
          })();
          await held.entered;
          throw new Error("Other parallel provider work failed");
        }),
      ).rejects.toThrow("Other parallel provider work failed");
      await client.query("rollback");
    } finally {
      client.release();
      held.release();
    }
    await child;
    expect(await fileName()).toBe("Original");
  },
);

for (const [kind, sql] of Object.entries({
  verification: 'update "user" set "emailVerified"=false where "id"=\'alice\'',
  session: 'delete from "session" where "id"=\'session-a\'',
  sessionOwner: 'update "session" set "userId"=\'bob\' where "id"=\'session-a\'',
  consent: 'delete from "oauthConsent" where "id"=\'consent-a\'',
  scopes: 'update "oauthConsent" set "scopes"=\'["mcp:read"]\' where "id"=\'consent-a\'',
  client: 'update "oauthClient" set "disabled"=true where "clientId"=\'client-a\'',
  resource: `update "oauthResource" set "disabled"=true where "identifier"='${resource}'`,
  link: 'delete from "oauthClientResource" where "id"=\'link-a\'',
}))
  integration(
    `OAuth refresh rejects ended ${kind} authority before issuing a new token`,
    async () => {
      const tokens = await issuedTokens();
      await admin.query(sql);
      const response = await refreshToken(tokens.refresh_token);
      expect(response.status).toBe(400);
      expect(await response.text()).not.toContain("access_token");
      expect(
        (await admin.query('select count(*)::int as n from "oauthRefreshToken"')).rows[0].n,
      ).toBe(1);
    },
  );

integration(
  "OAuth signing/storage failure rolls back consumption and never exposes private errors",
  async () => {
    const code = await authorizationCode();
    const adapter = (await auth.$context).adapter;
    const original = adapter.create;
    const insert = spyOn(adapter, "create").mockImplementation((...args) => {
      if (args[0].model === "oauthRefreshToken")
        throw new Error("private SQL credential should never be returned");
      return Reflect.apply(original, adapter, args);
    });
    try {
      const response = await exchangeCode(code);
      expect(response.status).toBe(500);
      expect(await response.text()).not.toContain("private SQL");
      expect(
        (await admin.query('select count(*)::int as n from "oauthRefreshToken"')).rows[0].n,
      ).toBe(0);
    } finally {
      insert.mockRestore();
    }
    expect((await exchangeCode(code)).status).toBe(200);
  },
);

for (const expiry of ["code", "session"])
  integration(
    `OAuth ${expiry} expiry during issuance rolls back the signed-token family`,
    async () => {
      const code = await authorizationCode();
      const expiresAt = Date.now() + 1200;
      if (expiry === "code")
        await admin.query('update "verification" set "expiresAt"=$1 where "identifier"=$2', [
          new Date(expiresAt),
          createHash("sha256").update(code).digest("base64url"),
        ]);
      else
        await admin.query('update "session" set "expiresAt"=$1 where "id"=\'session-a\'', [
          new Date(expiresAt),
        ]);
      const adapter = (await auth.$context).adapter;
      const original = adapter.create;
      const insert = spyOn(adapter, "create").mockImplementation(async (...args) => {
        if (args[0].model === "oauthRefreshToken")
          await Bun.sleep(Math.max(0, expiresAt - Date.now()) + 30);
        return Reflect.apply(original, adapter, args);
      });
      try {
        const response = await exchangeCode(code);
        expect(response.status).toBe(400);
        expect(await response.text()).not.toContain("access_token");
        expect(
          (await admin.query('select count(*)::int as n from "oauthRefreshToken"')).rows[0].n,
        ).toBe(0);
      } finally {
        insert.mockRestore();
      }
    },
  );

integration("OAuth server API calls enforce the same stored-code revocation epoch", async () => {
  const code = await authorizationCode();
  await revokeMcpAuthorization("alice", "client-a");
  await expect(
    auth.api.oauth2Token({
      body: {
        grant_type: "authorization_code",
        client_id: "client-a",
        code,
        code_verifier: verifier,
        redirect_uri: "http://127.0.0.1:4319/callback",
        resource,
      },
    }),
  ).rejects.toMatchObject({ statusCode: 400 });
  expect((await admin.query('select count(*)::int as n from "oauthRefreshToken"')).rows[0].n).toBe(
    0,
  );
});

beforeAll(async () => {
  if (!enabled) return;
  admin = new Client({ connectionString: setupUrl });
  await admin.connect();
  expect((await db.query("select current_user as role")).rows[0].role).toBe("tidy_runtime_fixture");
  globalThis.fetch = mock(async (input) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url === "http://localhost:3000/api/auth/jwks") return auth.handler(new Request(url));
    throw new Error("Unexpected external HTTP request in isolated MCP fixture");
  });
  await auth.$context;
});
beforeEach(async () => {
  if (!enabled) return;
  fixtureIp++;
  await admin.query(`truncate "user","organization","oauthClient" cascade; truncate "verification";
    update "billingDeployment" set "selfHosted"=false;
    update "oauthResource" set "disabled"=false,"allowedScopes"=null where "identifier"='${resource}';
    insert into "user" ("id","name","email","emailVerified") values ('alice','Alice','alice@example.test',true),('bob','Bob','bob@example.test',true);
    insert into "session" ("id","token","userId","expiresAt","updatedAt") values ('session-a','token-a','alice',now()+interval '1 day',now()),('session-b','token-b','bob',now()+interval '1 day',now());
    insert into "organization" ("id","name","slug","createdAt","createdByUserId") values ('org-a','A','a',now(),'alice'),('org-b','B','b',now(),'bob');
    insert into "member" ("id","organizationId","userId","role","createdAt") values ('member-a','org-a','alice','owner',now()),('member-b','org-b','bob','owner',now());
    insert into "designFile" ("id","organizationId","name","createdBy") values ('file-a','org-a','Original','alice'),('file-b','org-b','Private','bob');
    insert into "oauthClient" ("id","clientId","name","redirectUris","scopes") values ('client-a','client-a','A','[]','["mcp:read","mcp:write"]'),('client-b','client-b','B','[]','["mcp:read","mcp:write"]');
    insert into "oauthClientResource" ("id","clientId","resourceId") values ('link-a','client-a','${resource}'),('link-b','client-b','${resource}');
    insert into "oauthConsent" ("id","userId","clientId","resources","scopes","createdAt","updatedAt") values
      ('consent-a','alice','client-a','["${resource}"]','["mcp:read","mcp:write","offline_access"]',now(),now()),('consent-b','bob','client-b','["${resource}"]','["mcp:read","mcp:write","offline_access"]',now(),now());`);
  await admin.query(
    'insert into "designDocument" ("fileId","revision","content") values (\'file-a\',1,$1),(\'file-b\',1,$1)',
    [blankDesignDocument()],
  );
});
afterAll(async () => {
  globalThis.fetch = originalFetch;
  if (enabled) {
    await db.end();
    await admin.end();
  }
});

integration(
  "MCP actual signed HTTP dispatch reads and writes only the verified grant's tenant",
  async () => {
    const read = await request("tools/call", {
      name: "get_file",
      arguments: { file_id: "file-a" },
    });
    expect(read.status).toBe(200);
    expect((await responseMessage(read)).result.isError).not.toBe(true);
    const foreign = await request("tools/call", {
      name: "get_file",
      arguments: { file_id: "file-b", userId: "bob" },
    });
    expect((await responseMessage(foreign)).result.isError).toBe(true);
    const write = await request("tools/call", {
      name: "rename_file",
      arguments: { file_id: "file-a", name: "Changed" },
    });
    expect((await responseMessage(write)).result.isError).not.toBe(true);
    expect(await fileName()).toBe("Changed");
    expect(await calls()).toBe(2);
    const ownResource = await request("resources/read", { uri: "bella://files/file-a" });
    expect((await responseMessage(ownResource)).result.contents).toHaveLength(1);
    const foreignResource = await request("resources/read", { uri: "bella://files/file-b" });
    expect((await responseMessage(foreignResource)).error).toBeDefined();
    expect(await calls()).toBe(3);
  },
);

for (const changes of [
  { sid: undefined },
  { sid: "session-b" },
  { sid: "missing" },
  { sub: "bob" },
  { client_id: "client-b" },
  { exp: 0 },
])
  integration(
    `MCP rejects incomplete or substituted claims ${JSON.stringify(changes)}`,
    async () => {
      expect(await hasMcpAuthorization(grant(changes).claims, resource)).toBe(false);
      const response = await request("tools/list", {}, changes);
      expect(response.status).toBe(401);
      expect(response.headers.get("WWW-Authenticate")).toContain("resource_metadata=");
      expect(await calls()).toBe(0);
    },
  );

const revocations = {
  session: `delete from "session" where "id"='session-a'`,
  expiry: `update "session" set "expiresAt"=now()-interval '1 minute' where "id"='session-a'`,
  verification: `update "user" set "emailVerified"=false where "id"='alice'`,
  consent: `delete from "oauthConsent" where "id"='consent-a'`,
  scopes: `update "oauthConsent" set "scopes"='["mcp:read"]' where "id"='consent-a'`,
  client: `update "oauthClient" set "disabled"=true where "clientId"='client-a'`,
  "client scope policy": `update "oauthClient" set "scopes"='["mcp:read"]' where "clientId"='client-a'`,
  resource: `update "oauthResource" set "disabled"=true where "identifier"='${resource}'`,
  "resource scope policy": `update "oauthResource" set "allowedScopes"='["mcp:read"]' where "identifier"='${resource}'`,
  link: `delete from "oauthClientResource" where "id"='link-a'`,
};
for (const [kind, sql] of Object.entries(revocations))
  integration(`MCP ${kind} revocation while queued denies quota and product effects`, async () => {
    const blocker = new Client({ connectionString: setupUrl });
    await blocker.connect();
    await blocker.query("begin");
    await blocker.query("select pg_advisory_xact_lock(hashtextextended('org-a',0))");
    const response = request("tools/call", {
      name: "rename_file",
      arguments: { file_id: "file-a", name: "Forbidden" },
    });
    try {
      const pid = await waitingRuntime();
      await blocked(pid);
      await admin.query(sql);
      await blocker.query("commit");
      expect((await responseMessage(await response)).result.isError).toBe(true);
      expect(await calls()).toBe(0);
      expect(await fileName()).toBe("Original");
    } finally {
      await blocker.query("rollback").catch(() => {});
      await blocker.end();
      await response.catch(() => {});
    }
  });

integration(
  "MCP authorization requires a finite live expiry, including protocol discovery",
  async () => {
    for (const exp of [undefined, null, "99999999999", NaN, Infinity, -Infinity, 0])
      expect(await hasMcpAuthorization(grant({ exp }).claims, resource)).toBe(false);
  },
);

integration("MCP read-only request rechecks consent after bounded body parsing", async () => {
  let controller;
  const stream = new ReadableStream({
    start(value) {
      controller = value;
    },
  });
  const query = db.query.bind(db),
    seen = pause();
  const spy = mock(async (...args) => {
    const result = await query(...args);
    if (String(args[0]).includes('from "verification"') && String(args[1]).includes("mcp-grant:")) {
      seen.release();
      await seen.hook();
    }
    return result;
  });
  db.query = spy;
  const response = request("tools/call", {}, {}, stream);
  try {
    await seen.entered;
    db.query = query;
    await revokeMcpAuthorization("alice", "client-a");
    controller.enqueue(
      new TextEncoder().encode(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "get_file", arguments: { file_id: "file-a" } },
        }),
      ),
    );
    controller.close();
    expect((await response).status).toBe(401);
    expect(await calls()).toBe(0);
  } finally {
    db.query = query;
    seen.release();
    await response.catch(() => {});
  }
});

integration(
  "MCP admitted operation retains session and consent until product commit, then revokes old JWTs",
  async () => {
    const held = pause(),
      context = grant();
    const operation = withMcpGrantOperation(
      context,
      "alice",
      "org-a",
      { file_id: "file-a" },
      async () => {
        await renameDesignFileForUser("alice", "file-a", "Admitted");
        await held.hook();
        return { content: [] };
      },
    );
    await held.entered;
    const revocation = revokeMcpAuthorization("alice", "client-a");
    const control = new Client({ connectionString: setupUrl });
    await control.connect();
    try {
      await waitingRuntime();
      await control.query("set lock_timeout='500ms'");
      await expect(
        control.query('delete from "session" where "id"=\'session-a\''),
      ).rejects.toMatchObject({ code: "55P03" });
      held.release();
      await operation;
      await revocation;
      expect(await fileName()).toBe("Admitted");
      expect(await hasMcpAuthorization(context.claims, resource)).toBe(false);
    } finally {
      held.release();
      await operation.catch(() => {});
      await revocation.catch(() => {});
      await control.end();
    }
  },
);

integration(
  "MCP failed composite tools roll back product writes while quota and independent work stay committed",
  async () => {
    const context = grant();
    const organizationId = await withMcpGrantContext(context, () =>
      consumeMcpCall("alice", { file_id: "file-a" }),
    );
    const result = await withMcpGrantOperation(
      context,
      "alice",
      organizationId,
      { file_id: "file-a" },
      async () => {
        await renameDesignFileForUser("alice", "file-a", "Rollback");
        await withoutDatabaseScope(async () => {
          await db.query(
            'insert into "verification" ("id","identifier","value","expiresAt") values (\'independent\',\'fixture\',\'retained\',now()+interval \'1 day\')',
          );
        });
        return { content: [], isError: true };
      },
    );
    expect(result.isError).toBe(true);
    expect(await fileName()).toBe("Original");
    expect(await calls()).toBe(1);
    expect(
      (await admin.query('select "value" from "verification" where "id"=\'independent\'')).rows[0]
        .value,
    ).toBe("retained");
  },
);

integration(
  "MCP token expiry and cancellation before publication roll back product writes",
  async () => {
    for (const cancel of [false, true]) {
      const context = grant(),
        controller = new AbortController();
      if (!cancel) context.claims.exp = Math.ceil(Date.now() / 1000) + 1;
      let wrote = false;
      await expect(
        runWithRequestSignal(controller.signal, () =>
          withMcpGrantOperation(context, "alice", "org-a", { file_id: "file-a" }, async () => {
            await renameDesignFileForUser("alice", "file-a", "Forbidden");
            wrote = true;
            if (cancel) controller.abort();
            else await Bun.sleep(Math.max(0, context.claims.exp * 1000 - Date.now()) + 20);
            return { content: [] };
          }),
        ),
      ).rejects.toThrow();
      expect(wrote).toBe(true);
      expect(await fileName()).toBe("Original");
    }
  },
);

integration("MCP parent substitutions between quota and execution fail closed", async () => {
  const context = grant(),
    input = { file_id: "file-a" };
  const organizationId = await withMcpGrantContext(context, () => consumeMcpCall("alice", input));
  await admin.query('update "designFile" set "organizationId"=\'org-b\' where "id"=\'file-a\'');
  let called = false;
  await expect(
    withMcpGrantOperation(context, "alice", organizationId, input, async () => {
      called = true;
    }),
  ).rejects.toThrow("access denied");
  expect(called).toBe(false);
  expect(await calls()).toBe(1);
});

integration(
  "MCP resources retain the same operation scope and cannot execute after consent revocation",
  async () => {
    const context = grant();
    let handler;
    const server = {
      registerTool() {},
      registerResource(_name, _uri, _config, callback) {
        handler = callback;
      },
    };
    meterMcpServer(server, "alice", consumeMcpCall, (org, input, work) =>
      withMcpGrantOperation(context, "alice", org, input, work),
    );
    server.registerResource("file", {}, {}, async () => ({ contents: [] }));
    expect(
      await withMcpGrantContext(context, () =>
        handler(new URL("bella://files/file-a"), { file_id: "file-a" }),
      ),
    ).toEqual({ contents: [] });
    await revokeMcpAuthorization("alice", "client-a");
    await expect(
      withMcpGrantContext(context, () =>
        handler(new URL("bella://files/file-a"), { file_id: "file-a" }),
      ),
    ).rejects.toThrow("authorization has ended");
    expect(await calls()).toBe(1);
  },
);

for (const [kind, sql] of Object.entries(revocations).filter(([kind]) => kind !== "expiry"))
  integration(`MCP admitted operation retains ${kind} authority through commit`, async () => {
    const held = pause();
    const operation = withMcpGrantOperation(
      grant(),
      "alice",
      "org-a",
      { file_id: "file-a" },
      async () => {
        await renameDesignFileForUser("alice", "file-a", "Admitted");
        await held.hook();
        return { content: [] };
      },
    );
    await held.entered;
    const control = new Client({ connectionString: setupUrl });
    await control.connect();
    try {
      await control.query("set lock_timeout='500ms'");
      await expect(control.query(sql)).rejects.toMatchObject({ code: "55P03" });
      held.release();
      await operation;
      await control.query(sql);
      expect(await fileName()).toBe("Admitted");
      expect(await hasMcpAuthorization(grant().claims, resource, ["mcp:read", "mcp:write"])).toBe(
        false,
      );
    } finally {
      held.release();
      await operation.catch(() => {});
      await control.end();
    }
  });

integration(
  "MCP session expiry during provider work prevents publication without a concurrent row mutation",
  async () => {
    await admin.query(
      'update "session" set "expiresAt"=clock_timestamp()+interval \'1 second\' where "id"=\'session-a\'',
    );
    await expect(
      withMcpGrantOperation(grant(), "alice", "org-a", { file_id: "file-a" }, async () => {
        await renameDesignFileForUser("alice", "file-a", "Expired");
        await Bun.sleep(1100);
        return { content: [] };
      }),
    ).rejects.toThrow("authorization has ended");
    expect(await fileName()).toBe("Original");
  },
);

integration(
  "MCP independently committed quota remains charged when consent ends before execution",
  async () => {
    const context = grant();
    let handler,
      called = false;
    const server = {
      registerResource() {},
      registerTool(_name, _config, callback) {
        handler = callback;
      },
    };
    meterMcpServer(
      server,
      "alice",
      async (user, input) => {
        const org = await consumeMcpCall(user, input);
        await revokeMcpAuthorization("alice", "client-a");
        return org;
      },
      (org, input, work) => withMcpGrantOperation(context, "alice", org, input, work),
    );
    server.registerTool("rename_file", {}, async () => {
      called = true;
    });
    const result = await withMcpGrantContext(context, () => handler({ file_id: "file-a" }));
    expect(result.isError).toBe(true);
    expect(called).toBe(false);
    expect(await calls()).toBe(1);
  },
);

integration(
  "MCP tool and resource infrastructure failures never serialize SQL or private exception text",
  async () => {
    const context = grant();
    let tool, read;
    const server = {
      registerTool(_name, _config, callback) {
        tool = callback;
      },
      registerResource(_name, _uri, _config, callback) {
        read = callback;
      },
    };
    meterMcpServer(server, "alice", consumeMcpCall, (org, input, work) =>
      withMcpGrantOperation(context, "alice", org, input, work),
    );
    const failure = () => db.query('select "private_fixture_column" from "user"');
    server.registerTool("get_file", {}, failure);
    server.registerResource("file", {}, {}, failure);
    const result = await withMcpGrantContext(context, () => tool({ file_id: "file-a" }));
    expect(result).toEqual({
      content: [{ type: "text", text: "Could not complete the MCP operation. Try again." }],
      isError: true,
    });
    await expect(
      withMcpGrantContext(context, () =>
        read(new URL("bella://files/file-a"), { file_id: "file-a" }),
      ),
    ).rejects.toThrow("Could not complete the MCP operation. Try again.");
    expect(await calls()).toBe(2);
  },
);

integration(
  "MCP five occupied product connections can commit independent work without starving their own pool",
  async () => {
    for (let i = 1; i < 5; i++) {
      await admin.query(
        'insert into "user" ("id","name","email","emailVerified") values ($1,$1,$2,true)',
        [`creator-${i}`, `creator-${i}@example.test`],
      );
      await admin.query(
        'insert into "organization" ("id","name","slug","createdAt","createdByUserId") values ($1,$1,$1,now(),$2)',
        [`org-${i}`, `creator-${i}`],
      );
      await admin.query(
        'insert into "member" ("id","organizationId","userId","role","createdAt") values ($1,$2,\'alice\',\'editor\',now())',
        [`member-${i}`, `org-${i}`],
      );
    }
    let entered = 0,
      allEntered;
    const ready = new Promise((resolve) => (allEntered = resolve)),
      held = pause();
    const operations = ["org-a", "org-1", "org-2", "org-3", "org-4"].map((org, i) =>
      withMcpGrantOperation(grant(), "alice", org, {}, async () => {
        if (++entered === 5) allEntered();
        await held.hook();
        await withoutDatabaseScope(async () => {
          await db.query(
            'insert into "verification" ("id","identifier","value","expiresAt") values ($1,\'pool-fixture\',\'committed\',now()+interval \'1 day\')',
            [`independent-${i}`],
          );
        });
        return { content: [], isError: true };
      }),
    );
    try {
      await ready;
      expect(
        Number(
          (
            await admin.query(
              "select count(*) from pg_stat_activity where usename='tidy_runtime_fixture' and state='idle in transaction'",
            )
          ).rows[0].count,
        ),
      ).toBe(5);
      held.release();
      const results = await Promise.all(operations);
      expect(results.every((result) => result.isError)).toBe(true);
      expect(
        Number(
          (
            await admin.query(
              'select count(*) from "verification" where "identifier"=\'pool-fixture\'',
            )
          ).rows[0].count,
        ),
      ).toBe(5);
    } finally {
      held.release();
      await Promise.allSettled(operations);
    }
  },
);

integration("MCP grant lookup outages return a static 503 before dispatch", async () => {
  const query = db.query.bind(db);
  const spy = spyOn(db, "query").mockImplementation((...args) => {
    if (String(args[0]).includes('select 1 from "user"'))
      throw new Error("private fixture SQL connection detail");
    return query(...args);
  });
  try {
    const response = await request("tools/call", {
      name: "rename_file",
      arguments: { file_id: "file-a", name: "Forbidden" },
    });
    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("1");
    expect((await response.json()).error.message).toBe(
      "Could not verify agent authorization. Try again.",
    );
    expect(await fileName()).toBe("Original");
    expect(await calls()).toBe(0);
  } finally {
    spy.mockRestore();
  }
});

integration("MCP product connection failure cannot escape its public error boundary", async () => {
  const spy = spyOn(db, "connect").mockImplementation(() => {
    throw new Error("private fixture connection string");
  });
  try {
    await expect(
      withMcpGrantOperation(grant(), "alice", "org-a", { file_id: "file-a" }, async () => {
        throw new Error("Must not execute");
      }),
    ).rejects.toThrow("Could not complete the MCP operation. Try again.");
    expect(await fileName()).toBe("Original");
  } finally {
    spy.mockRestore();
  }
});

integration(
  "MCP token expiry while waiting for the consent gate denies quota admission",
  async () => {
    const blocker = new Client({ connectionString: setupUrl });
    await blocker.connect();
    await blocker.query("begin");
    await blocker.query("select pg_advisory_xact_lock(hashtextextended('mcp-consent:alice',0))");
    const exp = Math.ceil(Date.now() / 1000) + 1;
    const response = request(
      "tools/call",
      { name: "rename_file", arguments: { file_id: "file-a", name: "Expired" } },
      { exp },
    );
    try {
      await blocked(await waitingRuntime());
      await Bun.sleep(Math.max(0, exp * 1000 - Date.now()) + 20);
      await blocker.query("commit");
      expect((await responseMessage(await response)).result.isError).toBe(true);
      expect(await calls()).toBe(0);
      expect(await fileName()).toBe("Original");
    } finally {
      await blocker.query("rollback").catch(() => {});
      await blocker.end();
      await response.catch(() => {});
    }
  },
);

integration(
  "MCP session expiry while waiting for the consent row denies quota admission",
  async () => {
    const blocker = new Client({ connectionString: setupUrl });
    await blocker.connect();
    await blocker.query("begin");
    await blocker.query('select 1 from "oauthConsent" where "id"=\'consent-a\' for update');
    await admin.query(
      'update "session" set "expiresAt"=clock_timestamp()+interval \'1 second\' where "id"=\'session-a\'',
    );
    const response = request("tools/call", {
      name: "rename_file",
      arguments: { file_id: "file-a", name: "Expired" },
    });
    try {
      await blocked(await waitingRuntime("transactionid"));
      await Bun.sleep(1100);
      await blocker.query("commit");
      expect((await responseMessage(await response)).result.isError).toBe(true);
      expect(await calls()).toBe(0);
      expect(await fileName()).toBe("Original");
    } finally {
      await blocker.query("rollback").catch(() => {});
      await blocker.end();
      await response.catch(() => {});
    }
  },
);
