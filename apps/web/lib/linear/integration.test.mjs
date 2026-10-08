import { afterAll, beforeAll, beforeEach, expect, mock, test } from "bun:test";
import { Client } from "pg";
import { createHmac, randomUUID } from "node:crypto";
mock.module("server-only", () => ({}));
const { db } = await import("../db");
const {
  beginLinearAuthorization: beginSessionAuthorization,
  completeLinearAuthorization: completeSessionAuthorization,
} = await import("./oauth");
const sessionId = (userId) => `session-${userId}`;
const beginLinearAuthorization = (userId, org, accountId) =>
  beginSessionAuthorization(userId, org, sessionId(userId), accountId);
const completeLinearAuthorization = (userId, state, cookie, code) =>
  completeSessionAuthorization(userId, state, cookie, code, sessionId(userId));
const { linearAccess, linearStatus, disconnectLinear, credentialContext } =
  await import("./connections");
const {
  createLinearIssue,
  addLinearComment,
  updateLinearIssue,
  getLinearIssue,
  listLinearTeams,
  searchLinearIssues,
  listLinearComments,
} = await import("./operations");
const { inDatabaseScope } = await import("../database-scope");
const { runWithRequestSignal } = await import("../request-lifecycle");
const { LINEAR_LIMITS } = await import("../security/resource-limits");
const { connectorError, connectorJson, readLimited } = await import("../connectors/http");
const { linearRequest } = await import("./client");
const { linearWebhook } = await import("./webhooks");
const { seal, unseal, hash } = await import("../connectors/crypto");

const testUrl = process.env.LINEAR_TEST_DATABASE_URL,
  setupUrl = process.env.LINEAR_SETUP_DATABASE_URL;
let admin;
const enabled = Boolean(
  testUrl &&
  setupUrl &&
  new URL(setupUrl).hostname === "127.0.0.1" &&
  new URL(setupUrl).pathname === "/tidy_connectors_test" &&
  new URL(testUrl).port === new URL(setupUrl).port &&
  process.env.DATABASE_URL === testUrl &&
  new URL(testUrl).hostname === "127.0.0.1" &&
  new URL(testUrl).pathname === "/tidy_connectors_test",
);
const integration = enabled ? test : test.skip;
const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };
const workspace = "10000000-0000-4000-8000-000000000001",
  remoteUser = "20000000-0000-4000-8000-000000000001";
const teamId = "30000000-0000-4000-8000-000000000001",
  issueUuid = "40000000-0000-4000-8000-000000000001",
  stateId = "50000000-0000-4000-8000-000000000001";
let identityWorkspace,
  identityUser,
  connection,
  refreshes,
  revocations,
  mutations,
  graphqlError,
  loseResponse,
  issue,
  tokenFailure;
const tokenResponse = () => ({
  access_token: "access-secret",
  refresh_token: "refresh-secret",
  expires_in: 86400,
  scope: "read write",
});
const page = (nodes) => ({ nodes, pageInfo: { hasNextPage: false, endCursor: null } });
async function connect(userId = "alice", org = "org", accountId) {
  const start = await beginLinearAuthorization(userId, org, accountId);
  await completeLinearAuthorization(userId, start.state, start.state, "code");
  return (await linearStatus(userId, org)).connections[0];
}
function input(extra = {}) {
  return { organizationId: "org", connectionId: connection.id, ...extra };
}
beforeAll(async () => {
  if (!enabled) return;
  admin = new Client({ connectionString: setupUrl });
  await admin.connect();
  expect((await db.query("select current_user as role")).rows[0].role).toBe("tidy_runtime_fixture");
});
beforeEach(async () => {
  if (!enabled) return;
  Object.assign(process.env, {
    LINEAR_CLIENT_ID: "test-client",
    LINEAR_CLIENT_SECRET: "test-client-secret",
    LINEAR_WEBHOOK_SECRET: "test-webhook-secret",
    VAULT_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
    BETTER_AUTH_URL: "http://localhost:3000",
  });
  identityWorkspace = workspace;
  identityUser = remoteUser;
  refreshes = 0;
  revocations = 0;
  mutations = 0;
  graphqlError = false;
  loseResponse = false;
  tokenFailure = false;
  issue = {
    id: issueUuid,
    identifier: "DES-1",
    title: "Design task",
    description: null,
    url: "https://linear.app/test/issue/DES-1",
    updatedAt: "2026-10-05T00:00:00.000Z",
    team: { id: teamId, name: "Design" },
    state: { id: stateId, name: "Todo", type: "unstarted" },
    assignee: null,
  };
  globalThis.fetch = mock(async (url, init) => {
    expect(init.redirect).toBe("manual");
    expect(new URL(url).hostname).toBe("api.linear.app");
    if (String(url).endsWith("/oauth/token")) {
      const params = new URLSearchParams(init.body);
      expect(params.get("client_id")).toBe("test-client");
      expect(init.headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
      if (params.get("grant_type") === "refresh_token") {
        refreshes++;
        if (tokenFailure) return new Response(null, { status: 400 });
      }
      return Response.json(tokenResponse());
    }
    if (String(url).endsWith("/oauth/revoke")) {
      revocations++;
      expect(new URLSearchParams(init.body).get("token")).toBe("refresh-secret");
      return new Response(null, { status: 200 });
    }
    const { query, variables } = JSON.parse(init.body);
    if (query.includes("TidyIdentity"))
      return Response.json({
        data: {
          viewer: { id: identityUser, name: "Alice Linear" },
          organization: {
            id: identityWorkspace,
            name: identityWorkspace === workspace ? "Design workspace" : "Another workspace",
          },
        },
      });
    if (graphqlError)
      return Response.json({ data: { issue }, errors: [{ extensions: { code: "FORBIDDEN" } }] });
    let data;
    if (query.includes("TidyTeams"))
      data = { teams: page([{ id: teamId, name: "Design", key: "DES" }]) };
    else if (query.includes("TidyTeam(")) data = { team: { id: teamId } };
    else if (query.includes("TidySearch")) data = { issues: page([issue]) };
    else if (query.includes("TidyComments"))
      data = {
        issue: {
          comments: page([
            {
              id: "comment",
              body: "Feedback",
              updatedAt: issue.updatedAt,
              user: { name: "Alice" },
            },
          ]),
        },
      };
    else if (query.includes("TidyIssue(")) data = { issue };
    else if (query.includes("TidyStates")) data = { workflowStates: page([issue.state]) };
    else if (query.includes("TidyState(")) data = { workflowState: { team: { id: teamId } } };
    else if (query.includes("TidyCreateIssue")) {
      mutations++;
      issue.title = variables.input.title;
      data = { issueCreate: { success: true, issue } };
    } else if (query.includes("TidyComment(")) {
      mutations++;
      data = {
        commentCreate: { success: true, comment: { id: "60000000-0000-4000-8000-000000000001" } },
      };
    } else if (query.includes("TidyUpdateIssue")) {
      mutations++;
      Object.assign(issue, variables.input);
      issue.updatedAt = "2026-10-05T01:00:00.000Z";
      data = { issueUpdate: { success: true, issue } };
    } else throw new Error(`Unexpected query ${query}`);
    if (loseResponse && query.startsWith("mutation")) throw new Error("Lost response");
    return Response.json({ data });
  });
  await admin.query(
    'truncate "user", "organization" cascade; update "billingDeployment" set "selfHosted"=true',
  );
  await admin.query(
    `insert into "user" ("id","name","email","emailVerified") values ('alice','Alice','alice@example.test',true),('bob','Bob','bob@example.test',true),('outsider','Outside','outside@example.test',true)`,
  );
  await admin.query(
    `insert into "session" ("id","userId","token","expiresAt","updatedAt") select 'session-'||"id","id",'token-'||"id",now()+interval '1 day',now() from "user"`,
  );
  await admin.query(
    `insert into "organization" ("id","name","slug","createdAt","createdByUserId") values ('org','Design','design',now(),'alice'),('other','Other','other',now(),'outsider')`,
  );
  await admin.query(
    `insert into "member" ("id","userId","organizationId","role","createdAt") values ('a','alice','org','owner',now()),('b','bob','org','viewer',now()),('c','alice','other','member',now())`,
  );
  connection = await connect();
});
afterAll(async () => {
  globalThis.fetch = originalFetch;
  for (const name of [
    "LINEAR_CLIENT_ID",
    "LINEAR_CLIENT_SECRET",
    "LINEAR_WEBHOOK_SECRET",
    "VAULT_ENCRYPTION_KEY",
    "BETTER_AUTH_URL",
  ]) {
    if (originalEnv[name] === undefined) delete process.env[name];
    else process.env[name] = originalEnv[name];
  }
  if (enabled) {
    await db.end();
    await admin.end();
  }
});

integration(
  "Linear OAuth rejects a different valid session for the same user before exchange",
  async () => {
    const started = await beginLinearAuthorization("alice", "org");
    await admin.query(
      `insert into "session" ("id","userId","token","expiresAt","updatedAt") values ('replacement','alice','replacement-token',now()+interval '1 day',now())`,
    );
    const calls = globalThis.fetch.mock.calls.length;
    await expect(
      completeSessionAuthorization("alice", started.state, started.state, "code", "replacement"),
    ).rejects.toThrow("expired");
    expect(globalThis.fetch.mock.calls.length).toBe(calls);
  },
);
for (const [name, change] of [
  ["session revocation", () => admin.query(`delete from "session" where "id"='session-alice'`)],
  [
    "session expiry",
    () =>
      admin.query(
        `update "session" set "expiresAt"=now()-interval '1 minute' where "id"='session-alice'`,
      ),
  ],
  ["disconnect", () => disconnectLinear("alice", "org", connection.id)],
]) {
  integration(`Linear OAuth cannot publish after ${name} during token exchange`, async () => {
    const started = await beginLinearAuthorization("alice", "org", connection.accountId);
    const before = (
      await admin.query('select "credentials" from "connectorAccount" where "id"=$1', [
        connection.accountId,
      ])
    ).rows[0].credentials;
    const provider = globalThis.fetch;
    let changed = false;
    globalThis.fetch = mock(async (url, init) => {
      const response = await provider(url, init);
      if (!changed && new URL(url).pathname === "/oauth/token") {
        changed = true;
        await change();
      }
      return response;
    });
    await expect(
      completeLinearAuthorization("alice", started.state, started.state, "code"),
    ).rejects.toThrow("expired");
    const after = (
      await admin.query('select "credentials" from "connectorAccount" where "id"=$1', [
        connection.accountId,
      ])
    ).rows[0]?.credentials;
    expect(after).toEqual(name === "disconnect" ? undefined : before);
    expect((await admin.query('select 1 from "connectorOAuthState"')).rowCount).toBe(0);
  });
}
integration(
  "Linear OAuth verifier-only legacy states fail closed without provider I/O",
  async () => {
    const started = await beginLinearAuthorization("alice", "org");
    await admin.query('update "connectorOAuthState" set "verifier"=$2 where "hash"=$1', [
      hash(started.state),
      seal("x".repeat(43), `linear:oauth:alice:${hash(started.state)}`),
    ]);
    const calls = globalThis.fetch.mock.calls.length;
    await expect(
      completeLinearAuthorization("alice", started.state, started.state, "code"),
    ).rejects.toThrow("expired");
    expect(globalThis.fetch.mock.calls.length).toBe(calls);
  },
);
integration(
  "OAuth binds state to the user, organisation and PKCE; consumes once and encrypts credentials",
  async () => {
    const start = await beginLinearAuthorization("alice", "org");
    const url = new URL(start.url);
    expect(url.searchParams.get("prompt")).toBe("consent");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    await expect(
      completeLinearAuthorization("bob", start.state, start.state, "code"),
    ).rejects.toThrow("expired");
    await expect(
      completeLinearAuthorization("alice", start.state, "wrong", "code"),
    ).rejects.toThrow("verified");
    await completeLinearAuthorization("alice", start.state, start.state, "code");
    await expect(
      completeLinearAuthorization("alice", start.state, start.state, "code"),
    ).rejects.toThrow("expired");
    const row = (await admin.query('select * from "connectorAccount"')).rows[0];
    expect(JSON.stringify(row.credentials)).not.toContain("access-secret");
    expect(unseal(row.credentials, credentialContext("alice", workspace))).toContain(
      "access-secret",
    );
    expect(() => unseal(row.credentials, credentialContext("bob", workspace))).toThrow();
    expect(JSON.stringify(await linearStatus("alice", "org"))).not.toContain("secret");
    expect((await linearStatus("alice", "org")).connections).toHaveLength(1);
  },
);
integration("expired states and membership removal cannot complete authorization", async () => {
  const start = await beginLinearAuthorization("alice", "org");
  await admin.query(
    `update "connectorOAuthState" set "expiresAt"=now()-interval '1 minute' where "hash"=$1`,
    [hash(start.state)],
  );
  await expect(
    completeLinearAuthorization("alice", start.state, start.state, "code"),
  ).rejects.toThrow("expired");
  const next = await beginLinearAuthorization("alice", "org");
  await admin.query(`delete from "member" where "id"='a'`);
  await expect(
    completeLinearAuthorization("alice", next.state, next.state, "code"),
  ).rejects.toThrow("denied");
});
integration(
  "supports multiple workspaces and rejects reconnecting to a different account",
  async () => {
    identityWorkspace = "10000000-0000-4000-8000-000000000002";
    await connect();
    expect((await linearStatus("alice", "org")).connections).toHaveLength(2);
    const start = await beginLinearAuthorization("alice", "org", connection.accountId);
    await expect(
      completeLinearAuthorization("alice", start.state, start.state, "code"),
    ).rejects.toThrow("same Linear");
    expect((await linearStatus("alice", "org")).connections).toHaveLength(2);
  },
);
integration(
  "isolates users and organisations; viewers read their own account but cannot write",
  async () => {
    expect((await linearStatus("bob", "org")).connections).toHaveLength(0);
    await expect(linearAccess("bob", "org", connection.id)).rejects.toThrow("not found");
    await expect(linearAccess("alice", "other", connection.id)).rejects.toThrow("not found");
    await expect(linearStatus("outsider", "org")).rejects.toThrow("denied");
    await expect(disconnectLinear("bob", "org", connection.id)).rejects.toThrow("not found");
    const bob = await connect("bob");
    await linearAccess("bob", "org", bob.id);
    await expect(linearAccess("bob", "org", bob.id, true)).rejects.toThrow("denied");
  },
);
integration("serializes token rotation and invalid refresh clears credentials", async () => {
  await admin.query(`update "connectorAccount" set "expiresAt"=now()-interval '1 minute'`);
  await Promise.all([
    linearAccess("alice", "org", connection.id),
    linearAccess("alice", "org", connection.id),
  ]);
  expect(refreshes).toBe(1);
  await admin.query(`update "connectorAccount" set "expiresAt"=now()-interval '1 minute'`);
  tokenFailure = true;
  await expect(linearAccess("alice", "org", connection.id)).rejects.toThrow("Reconnect");
  const row = (await admin.query('select "state","credentials" from "connectorAccount"')).rows[0];
  expect(row).toEqual({ state: "reconnect", credentials: null });
});
integration(
  "disconnect removes one organisation link and revokes only the final link",
  async () => {
    const other = await connect("alice", "other");
    await disconnectLinear("alice", "org", connection.id);
    expect(revocations).toBe(0);
    await linearAccess("alice", "other", other.id);
    await disconnectLinear("alice", "other", other.id);
    expect(revocations).toBe(1);
    expect((await admin.query('select * from "connectorAccount"')).rowCount).toBe(0);
    await expect(linearAccess("alice", "other", other.id)).rejects.toThrow("not found");
  },
);
integration("GraphQL partial errors and changed remote identity deny data", async () => {
  graphqlError = true;
  await expect(linearRequest("token", "query { issue { id } }")).rejects.toThrow("denied");
  identityWorkspace = "10000000-0000-4000-8000-000000000009";
  await expect(getLinearIssue("alice", input({ issueId: "DES-1" }))).rejects.toThrow("Reconnect");
});
integration(
  "direct connector operations read current teams, issues, statuses and comments",
  async () => {
    expect((await listLinearTeams("alice", input())).teams.nodes[0].id).toBe(teamId);
    expect(
      (await searchLinearIssues("alice", input({ query: "Design" }))).issues.nodes[0].identifier,
    ).toBe("DES-1");
    expect((await getLinearIssue("alice", input({ issueId: "DES-1" }))).states.nodes[0].id).toBe(
      stateId,
    );
    expect(
      (await listLinearComments("alice", input({ issueId: "DES-1" }))).comments.nodes[0].body,
    ).toBe("Feedback");
  },
);
integration("deduplicates published issues/comments and rejects operation ID reuse", async () => {
  const create = input({ operationId: randomUUID(), teamId, title: "Implement design" });
  await createLinearIssue("alice", create);
  await createLinearIssue("alice", create);
  expect(mutations).toBe(1);
  await expect(createLinearIssue("alice", { ...create, title: "Different" })).rejects.toThrow(
    "different request",
  );
  const comment = input({ operationId: randomUUID(), issueId: "DES-1", body: "Please review" });
  await addLinearComment("alice", comment);
  await addLinearComment("alice", comment);
  expect(mutations).toBe(2);
});
integration("does not repeat a mutation after an ambiguous network failure", async () => {
  loseResponse = true;
  const create = input({ operationId: randomUUID(), teamId, title: "Once" });
  await expect(createLinearIssue("alice", create)).rejects.toThrow("Lost response");
  loseResponse = false;
  await expect(createLinearIssue("alice", create)).rejects.toThrow("may already have reached");
  expect(mutations).toBe(1);
});
integration(
  "status updates reject intervening edits and repeat completed requests without another write",
  async () => {
    await expect(
      updateLinearIssue(
        "alice",
        input({
          operationId: randomUUID(),
          issueId: "DES-1",
          title: "New",
          expectedUpdatedAt: "2026-10-04T00:00:00.000Z",
        }),
      ),
    ).rejects.toThrow("changed");
    expect(mutations).toBe(0);
    const update = input({
      operationId: randomUUID(),
      issueId: "DES-1",
      title: "New",
      stateId,
      expectedUpdatedAt: issue.updatedAt,
    });
    await updateLinearIssue("alice", update);
    await updateLinearIssue("alice", update);
    expect(mutations).toBe(1);
  },
);
integration(
  "signed revocation validates timestamp/client/workspace and deduplicates deliveries",
  async () => {
    const payload = {
      type: "OAuthApp",
      action: "revoked",
      organizationId: workspace,
      oauthClientId: "test-client",
      webhookTimestamp: Date.now(),
    };
    const send = async (value, delivery = randomUUID()) => {
      const body = JSON.stringify(value);
      return linearWebhook(
        body,
        createHmac("sha256", "test-webhook-secret").update(body).digest("hex"),
        delivery,
      );
    };
    await expect(linearWebhook(JSON.stringify(payload), "bad", randomUUID())).rejects.toThrow(
      "signature",
    );
    await expect(
      linearWebhook(
        "{",
        createHmac("sha256", "test-webhook-secret").update("{").digest("hex"),
        randomUUID(),
      ),
    ).rejects.toMatchObject({ status: 400 });
    await expect(send({ ...payload, webhookTimestamp: Date.now() - 120000 })).rejects.toThrow(
      "Expired",
    );
    await send({ ...payload, oauthClientId: "other" });
    expect((await linearStatus("alice", "org")).connections[0].state).toBe("connected");
    const delivery = randomUUID();
    await send(payload, delivery);
    expect((await linearStatus("alice", "org")).connections[0].state).toBe("reconnect");
    await connect();
    await send(payload, delivery);
    expect((await linearStatus("alice", "org")).connections[0].state).toBe("connected");
  },
);

integration(
  "membership revoked while checking remote identity prevents use of the connection",
  async () => {
    const provider = globalThis.fetch;
    globalThis.fetch = mock(async (url, init) => {
      const response = await provider(url, init);
      if (
        String(url).endsWith("/graphql") &&
        JSON.parse(init.body).query.includes("TidyIdentity")
      ) {
        await admin.query(
          'delete from "member" where "userId"=\'alice\' and "organizationId"=\'org\'',
        );
      }
      return response;
    });
    await expect(linearAccess("alice", "org", connection.id, true)).rejects.toThrow(
      "access changed",
    );
    expect(mutations).toBe(0);
  },
);

integration("an account made unverified during OAuth cannot publish a new connection", async () => {
  await disconnectLinear("alice", "org", connection.id);
  const start = await beginLinearAuthorization("alice", "org");
  const provider = globalThis.fetch;
  globalThis.fetch = mock(async (url, init) => {
    const response = await provider(url, init);
    if (String(url).endsWith("/graphql") && JSON.parse(init.body).query.includes("TidyIdentity")) {
      await admin.query('update "user" set "emailVerified"=false where "id"=\'alice\'');
    }
    return response;
  });
  await expect(
    completeLinearAuthorization("alice", start.state, start.state, "code"),
  ).rejects.toThrow("expired");
  expect((await admin.query('select * from "connectorConnection"')).rows).toEqual([]);
});

const remoteHook = (queryName, hook) => {
  const provider = globalThis.fetch;
  globalThis.fetch = mock(async (url, init) => {
    const response = await provider(url, init);
    if (String(url).endsWith("/graphql") && JSON.parse(init.body).query.includes(queryName))
      await hook();
    return response;
  });
};
for (const [query, read] of [
  ["TidyTeams", () => listLinearTeams("alice", input())],
  ["TidySearch", () => searchLinearIssues("alice", input({ query: "Design" }))],
  ["TidyStates", () => getLinearIssue("alice", input({ issueId: "DES-1" }))],
  ["TidyComments", () => listLinearComments("alice", input({ issueId: "DES-1" }))],
])
  integration(`revocation during ${query} denies the resulting data`, async () => {
    remoteHook(query, () => admin.query(`update "member" set "role"='unknown' where "id"='a'`));
    await expect(read()).rejects.toMatchObject({ status: 403 });
  });
const changes = {
  membership: () => admin.query(`update "member" set "role"='viewer' where "id"='a'`),
  verification: () => admin.query(`update "user" set "emailVerified"=false where "id"='alice'`),
  credentials: () =>
    admin.query(`update "connectorAccount" set "credentials"=$1 where "id"=$2`, [
      seal(JSON.stringify(tokenResponse()), credentialContext("alice", workspace)),
      connection.accountId,
    ]),
  parent: () =>
    admin.query(`update "connectorConnection" set "organizationId"='other' where "id"=$1`, [
      connection.id,
    ]),
  revocation: () =>
    admin.query(
      `update "connectorAccount" set "credentials"=null,"state"='reconnect' where "id"=$1`,
      [connection.accountId],
    ),
};
for (const [boundary, work] of [
  [
    "TidyTeam(",
    () => createLinearIssue("alice", input({ operationId: randomUUID(), teamId, title: "New" })),
  ],
  [
    "TidyIssue(",
    () =>
      addLinearComment(
        "alice",
        input({ operationId: randomUUID(), issueId: "DES-1", body: "New" }),
      ),
  ],
  [
    "TidyState(",
    () =>
      updateLinearIssue(
        "alice",
        input({
          operationId: randomUUID(),
          issueId: "DES-1",
          stateId,
          title: "New",
          expectedUpdatedAt: issue.updatedAt,
        }),
      ),
  ],
])
  for (const [change, alter] of Object.entries(changes))
    integration(`${change} changed during ${boundary} prevents the external POST`, async () => {
      remoteHook(boundary, alter);
      await expect(work()).rejects.toMatchObject({ status: 403 });
      expect(mutations).toBe(0);
    });
integration(
  "external success and token rotation survive scoped rollback with all ordinary pool connections occupied",
  async () => {
    await admin.query(`update "connectorAccount" set "expiresAt"=now()-interval '1 minute'`);
    const clients = [];
    const create = input({ operationId: randomUUID(), teamId, title: "Once" });
    try {
      for (let i = 0; i < 5; i++) clients.push(await db.connect());
      const client = clients[0];
      await client.query("begin");
      await client.query("select pg_advisory_xact_lock(hashtextextended('org',0))");
      await client.query(`select 1 from "member" where "id"='a' for share`);
      await inDatabaseScope(client, async () => {
        await createLinearIssue("alice", create);
        // This later rejected tool rolls back only local product effects.
        await client.query("rollback");
      });
    } finally {
      for (const client of clients) client.release();
    }
    expect(refreshes).toBe(1);
    expect(mutations).toBe(1);
    expect(
      (
        await admin.query(`select "state" from "connectorOperation" where "id"=$1`, [
          create.operationId,
        ])
      ).rows[0].state,
    ).toBe("succeeded");
    expect(
      (
        await admin.query(
          `select "expiresAt">now() as fresh from "connectorAccount" where "id"=$1`,
          [connection.accountId],
        )
      ).rows[0].fresh,
    ).toBe(true);
    await createLinearIssue("alice", create);
    expect(mutations).toBe(1);
    expect(refreshes).toBe(1);
  },
  15000,
);
integration("concurrent attempts with one operation ID send at most one POST", async () => {
  const create = input({ operationId: randomUUID(), teamId, title: "Once" });
  const attempts = await Promise.allSettled(
    Array.from({ length: 10 }, () => createLinearIssue("alice", create)),
  );
  expect(attempts.some((x) => x.status === "fulfilled")).toBe(true);
  expect(mutations).toBe(1);
  for (const result of attempts)
    if (result.status === "rejected") expect(result.reason.status).toBe(409);
});
integration(
  "an admitted POST retains authority until its durable success receipt is recorded",
  async () => {
    let enter, release;
    const entered = new Promise((r) => (enter = r)),
      gate = new Promise((r) => (release = r));
    const provider = globalThis.fetch;
    const revoker = new Client({ connectionString: setupUrl });
    await revoker.connect();
    const pid = (await revoker.query("select pg_backend_pid() as pid")).rows[0].pid;
    let revocation;
    globalThis.fetch = mock(async (url, init) => {
      const response = await provider(url, init),
        query = JSON.parse(init.body).query;
      if (query?.includes("TidyCreateIssue")) {
        enter();
        await gate;
      }
      if (query?.includes("TidyIssue(")) await revocation;
      return response;
    });
    const create = input({ operationId: randomUUID(), teamId, title: "Once" });
    const work = createLinearIssue("alice", create).then(
      () => null,
      (error) => error,
    );
    try {
      await entered;
      revocation = revoker.query(`update "member" set "role"='viewer' where "id"='a'`);
      let blocked = false;
      for (let i = 0; i < 100; i++) {
        blocked = (
          await admin.query("select cardinality(pg_blocking_pids($1))>0 as blocked", [pid])
        ).rows[0].blocked;
        if (blocked) break;
        await new Promise((r) => setTimeout(r, 5));
      }
      expect(blocked).toBe(true);
      release();
      await revocation;
      expect(await work).toMatchObject({ status: 403 });
      expect(mutations).toBe(1);
      expect(
        (
          await admin.query(`select "state" from "connectorOperation" where "id"=$1`, [
            create.operationId,
          ])
        ).rows[0].state,
      ).toBe("succeeded");
    } finally {
      release();
      await work;
      await revoker.end();
    }
  },
);
integration("operation capacity rejects growth but retains exact successful retry", async () => {
  const create = input({ operationId: randomUUID(), teamId, title: "Once" });
  await createLinearIssue("alice", create);
  await admin.query(
    `insert into "connectorOperation" ("id","connectionId","kind","inputHash","state") select gen_random_uuid(),$1,'fixture','fixture','uncertain' from generate_series(1,$2)`,
    [connection.id, LINEAR_LIMITS.operationsPerConnection - 1],
  );
  await createLinearIssue("alice", create);
  expect(mutations).toBe(1);
  await expect(
    createLinearIssue("alice", { ...create, operationId: randomUUID() }),
  ).rejects.toMatchObject({ status: 409 });
  expect(mutations).toBe(1);
});
integration("pending sign-in capacity is atomic across concurrent starts", async () => {
  for (let i = 0; i < LINEAR_LIMITS.statesPerUserOrganization - 1; i++)
    await beginLinearAuthorization("alice", "org");
  const attempts = await Promise.allSettled(
    Array.from({ length: 8 }, () => beginLinearAuthorization("alice", "org")),
  );
  expect(attempts.filter((x) => x.status === "fulfilled")).toHaveLength(1);
  expect(
    (
      await admin.query(
        `select count(*)::int as count from "connectorOAuthState" where "userId"='alice' and "organizationId"='org'`,
      )
    ).rows[0].count,
  ).toBe(LINEAR_LIMITS.statesPerUserOrganization);
});
integration(
  "provider cancellation and oversized bodies stop before mutation and public errors hide infrastructure details",
  async () => {
    const controller = new AbortController();
    let fetches = 0;
    globalThis.fetch = mock(async () => {
      fetches++;
      return new Promise(() => {});
    });
    const work = runWithRequestSignal(controller.signal, () =>
      createLinearIssue("alice", input({ operationId: randomUUID(), teamId, title: "Once" })),
    );
    setTimeout(() => controller.abort(new Error("private internal database detail")), 20);
    try {
      await work;
      throw new Error("Expected cancellation");
    } catch (error) {
      expect((await connectorError(error).json()).error).not.toContain("private");
    }
    expect(fetches).toBe(1);
    expect(mutations).toBe(0);
    let cancelled = 0;
    const response = new Response(
      new ReadableStream({
        start(c) {
          c.enqueue(new Uint8Array(1_048_577));
        },
        cancel() {
          cancelled++;
          return new Promise(() => {});
        },
      }),
    );
    await expect(readLimited(response)).rejects.toMatchObject({ status: 413 });
    expect(cancelled).toBe(1);
    await expect(
      connectorJson(
        new Request("http://localhost", {
          method: "POST",
          headers: { "content-type": "application/json", "content-encoding": "gzip" },
          body: "{}",
        }),
      ),
    ).rejects.toMatchObject({ status: 415 });
  },
);

integration(
  "personal account capacity permits reconnection and rejects another workspace",
  async () => {
    await admin.query(
      `insert into "connectorAccount" ("id","provider","userId","externalWorkspaceId","externalUserId","workspaceName","accountName","credentials","scopes","expiresAt") select gen_random_uuid(),'linear','alice',gen_random_uuid()::text,$1,'Fixture','Fixture',$2,array['read','write'],now()+interval '1 day' from generate_series(1,$3)`,
      [
        remoteUser,
        seal(JSON.stringify(tokenResponse()), credentialContext("alice", workspace)),
        LINEAR_LIMITS.accountsPerUser - 1,
      ],
    );
    await connect("alice", "org", connection.accountId);
    identityWorkspace = randomUUID();
    const start = await beginLinearAuthorization("alice", "org");
    await expect(
      completeLinearAuthorization("alice", start.state, start.state, "code"),
    ).rejects.toMatchObject({ status: 409 });
    expect(
      (
        await admin.query(
          `select count(*)::int as count from "connectorAccount" where "userId"='alice'`,
        )
      ).rows[0].count,
    ).toBe(LINEAR_LIMITS.accountsPerUser);
  },
);
integration("workspace link capacity rejects a new connection atomically", async () => {
  await admin.query(
    `with accounts as (insert into "connectorAccount" ("id","provider","userId","externalWorkspaceId","externalUserId","workspaceName","accountName","credentials","scopes","expiresAt") select gen_random_uuid(),'linear','bob',gen_random_uuid()::text,$1,'Fixture','Fixture',null,array['read'],now()+interval '1 day' from generate_series(1,$2) returning "id") insert into "connectorConnection" ("id","accountId","organizationId") select gen_random_uuid(),"id",'org' from accounts`,
    [remoteUser, LINEAR_LIMITS.connectionsPerOrganization - 1],
  );
  identityWorkspace = randomUUID();
  const start = await beginLinearAuthorization("alice", "org");
  await expect(
    completeLinearAuthorization("alice", start.state, start.state, "code"),
  ).rejects.toMatchObject({ status: 409 });
  expect(
    (
      await admin.query(
        `select count(*)::int as count from "connectorConnection" where "organizationId"='org'`,
      )
    ).rows[0].count,
  ).toBe(LINEAR_LIMITS.connectionsPerOrganization);
  expect(
    (
      await admin.query(
        `select count(*)::int as count from "connectorAccount" where "userId"='alice'`,
      )
    ).rows[0].count,
  ).toBe(1);
});
integration("workspace receipt capacity applies across personal connections", async () => {
  const connections = [];
  for (
    let i = 0;
    i < LINEAR_LIMITS.operationsPerOrganization / LINEAR_LIMITS.operationsPerConnection;
    i++
  ) {
    identityWorkspace = randomUUID();
    const created = await beginLinearAuthorization("alice", "org");
    await completeLinearAuthorization("alice", created.state, created.state, "code");
    const conn = (
      await admin.query(
        `select c."id" from "connectorConnection" c join "connectorAccount" a on a."id"=c."accountId" where a."externalWorkspaceId"=$1`,
        [identityWorkspace],
      )
    ).rows[0].id;
    connections.push(conn);
    await admin.query(
      `insert into "connectorOperation" ("id","connectionId","kind","inputHash","state") select gen_random_uuid(),$1,'fixture','fixture','uncertain' from generate_series(1,$2)`,
      [conn, LINEAR_LIMITS.operationsPerConnection],
    );
  }
  identityWorkspace = workspace;
  await expect(
    createLinearIssue("alice", input({ operationId: randomUUID(), teamId, title: "Overflow" })),
  ).rejects.toMatchObject({ status: 409 });
  expect(mutations).toBe(0);
  expect(
    (await admin.query(`select count(*)::int as count from "connectorOperation"`)).rows[0].count,
  ).toBe(LINEAR_LIMITS.operationsPerOrganization);
});
