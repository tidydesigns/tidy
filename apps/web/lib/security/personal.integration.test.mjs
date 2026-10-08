import { afterAll, beforeAll, beforeEach, expect, mock, test } from "bun:test";
import { Client } from "pg";
import { createHmac, randomUUID } from "node:crypto";
import { db } from "../db";
mock.module("server-only", () => ({}));
const { createVaultLogin, updateVaultLogin, deleteVaultLogin, listVaultLogins, VAULT_LOGIN_LIMIT } =
  await import("../vault/logins");
const { decryptVaultLogin } = await import("../vault/server");
const { startNativeLogin, refreshNativeConnection, disconnectAgentConnection, connectionStatus } =
  await import("../agents/connections");
const { agentBody, agentFailure } = await import("../agents/http");
const { runnerRequest } = await import("../agents/runner-client");
const { listAccountSessions } = await import("../account/sessions");
const { revokeMcpAuthorization, authorizedClients } = await import("../mcp/authorizations");
const { actionError } = await import("../action-error");
const { runWithRequestSignal } = await import("../request-lifecycle");
const { PublicActionError } = await import("./public-error");
const { UserAccessError } = await import("./user-authority");
const testUrl = process.env.PERSONAL_TEST_DATABASE_URL,
  setupUrl = process.env.PERSONAL_SETUP_DATABASE_URL;
const enabled = Boolean(
  testUrl &&
  setupUrl &&
  process.env.DATABASE_URL === testUrl &&
  new URL(testUrl).hostname === "127.0.0.1" &&
  new URL(setupUrl).hostname === "127.0.0.1" &&
  new URL(testUrl).pathname === "/tidy_personal_test" &&
  new URL(setupUrl).pathname === "/tidy_personal_test" &&
  new URL(testUrl).port === new URL(setupUrl).port,
);
const integration = enabled ? test : test.skip;
const originalFetch = globalThis.fetch,
  originalEnv = { ...process.env };
let admin, remoteActions, remoteHook, responseFactory;
const login = () => ({
  type: "chatgptDeviceCode",
  loginId: "fixture-login",
  verificationUrl: "https://auth.openai.com/codex/device",
  userCode: "ABCD-EFGH",
});
const secret = "personal-fixture-runner-secret-at-least-32-characters";
const pause = () => {
  let enter, release;
  const entered = new Promise((r) => (enter = r)),
    gate = new Promise((r) => (release = r));
  return {
    entered,
    release,
    hook: async () => {
      enter();
      await gate;
    },
  };
};
async function blocked(pid) {
  for (let i = 0; i < 200; i++) {
    if (
      (await admin.query("select cardinality(pg_blocking_pids($1))>0 as blocked", [pid])).rows[0]
        .blocked
    )
      return true;
    await new Promise((r) => setTimeout(r, 5));
  }
  return false;
}
async function waitingApplication() {
  for (let i = 0; i < 200; i++) {
    const row = (
      await admin.query(
        `select pid from pg_stat_activity where usename='tidy_runtime_fixture' and state='active' and wait_event='advisory' limit 1`,
      )
    ).rows[0];
    if (row) return row.pid;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("Expected application advisory wait");
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
    AGENT_RUNNER_URL: "https://runner.example",
    AGENT_RUNNER_SECRET: secret,
    VAULT_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
  });
  remoteActions = [];
  remoteHook = undefined;
  responseFactory = undefined;
  globalThis.fetch = mock(async (url, init) => {
    const parsed = new URL(url);
    expect(parsed.origin).toBe("https://runner.example");
    expect(init.redirect).toBe("error");
    expect(init.headers.Authorization).toBe(`Bearer ${secret}`);
    const parts = parsed.pathname.split("/"),
      owner = parts.at(-2),
      action = parts.at(-1);
    expect(owner).toMatch(/^[a-f0-9]{64}$/);
    remoteActions.push({ owner, action });
    await remoteHook?.(action);
    return responseFactory
      ? responseFactory(action)
      : Response.json(
          action === "login"
            ? login()
            : action === "account"
              ? { account: { type: "chatgpt", email: "private-account@example.test" } }
              : { ok: true },
        );
  });
  await admin.query(`truncate "user","organization" cascade; update "billingDeployment" set "selfHosted"=true;
    insert into "user" ("id","name","email","emailVerified") values ('alice','Alice','alice@example.test',true),('bob','Bob','bob@example.test',true),('unverified','Unverified','unverified@example.test',false);
    insert into "agentConnection" ("id","userId","provider","subject","clientId","accountLabel","status") select gen_random_uuid(),u."id",'codex','','codex-managed',u."name",'connected' from "user" u;`);
});
afterAll(async () => {
  globalThis.fetch = originalFetch;
  for (const key of ["AGENT_RUNNER_URL", "AGENT_RUNNER_SECRET", "VAULT_ENCRYPTION_KEY"]) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
  if (enabled) {
    await db.end();
    await admin.end();
  }
});
integration(
  "Vault returns metadata and isolates every read/update/delete by verified account",
  async () => {
    const own = await createVaultLogin("alice", " Mail ", "first-user", "first-password");
    expect(own).toEqual({ id: own.id, name: "Mail" });
    expect(await listVaultLogins("bob")).toEqual([]);
    await expect(updateVaultLogin("bob", own.id, { name: "Stolen" })).rejects.toThrow("not found");
    await expect(deleteVaultLogin("bob", own.id)).rejects.toThrow("not found");
    await Promise.all([
      updateVaultLogin("alice", own.id, { username: "new-user" }),
      updateVaultLogin("alice", own.id, { password: "new-password" }),
    ]);
    const stored = (await admin.query(`select * from "vaultLogin" where "id"=$1`, [own.id]))
      .rows[0];
    expect(decryptVaultLogin(stored, "alice", own.id)).toEqual({
      username: "new-user",
      password: "new-password",
    });
    expect(() => decryptVaultLogin(stored, "bob", own.id)).toThrow();
    expect(() => decryptVaultLogin(stored, "alice", randomUUID())).toThrow();
    expect(JSON.stringify(await listVaultLogins("alice"))).not.toContain("password");
    expect(Object.keys((await listVaultLogins("alice"))[0]).sort()).toEqual(["id", "name"]);
    await admin.query(`update "user" set "emailVerified"=false where "id"='alice'`);
    for (const work of [
      () => createVaultLogin("alice", "X", "X", "X"),
      () => updateVaultLogin("alice", own.id, { name: "X" }),
      () => deleteVaultLogin("alice", own.id),
      () => listVaultLogins("alice"),
    ])
      await expect(work()).rejects.toBeInstanceOf(UserAccessError);
    expect(
      (await admin.query(`select "name" from "vaultLogin" where "id"=$1`, [own.id])).rows[0].name,
    ).toBe("Mail");
  },
);
integration(
  "Vault bounds records atomically, permits reduction and preserves existing credentials",
  async () => {
    const seed = await createVaultLogin("alice", "Seed", "user", "password");
    await admin.query(
      `insert into "vaultLogin" ("id","userId","name","ciphertext","iv","authTag","keyVersion","createdAt") select gen_random_uuid()::text,'alice','Fixture',v."ciphertext",v."iv",v."authTag",v."keyVersion",now() from "vaultLogin" v cross join generate_series(1,$2) where v."id"=$1`,
      [seed.id, VAULT_LOGIN_LIMIT - 2],
    );
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, () => createVaultLogin("alice", "Last", "user", "password")),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await listVaultLogins("alice")).toHaveLength(VAULT_LOGIN_LIMIT);
    await updateVaultLogin("alice", seed.id, { name: "Updated" });
    await deleteVaultLogin("alice", seed.id);
    await expect(createVaultLogin("alice", "Freed", "user", "password")).resolves.toBeDefined();
    expect(
      (await admin.query(`select count(*)::int as count from "vaultLogin" where "userId"='alice'`))
        .rows[0].count,
    ).toBe(VAULT_LOGIN_LIMIT);
  },
);
integration(
  "queued Vault writes recheck verification after admission without modifying ciphertext",
  async () => {
    const stored = await createVaultLogin("alice", "Seed", "user", "password");
    const blocker = new Client({ connectionString: setupUrl });
    await blocker.connect();
    let work;
    try {
      await blocker.query("begin");
      await blocker.query("select pg_advisory_xact_lock(hashtextextended('vault:alice',0))");
      work = updateVaultLogin("alice", stored.id, { password: "forbidden" }).then(
        () => null,
        (e) => e,
      );
      await waitingApplication();
      await blocker.query(`update "user" set "emailVerified"=false where "id"='alice'`);
      await blocker.query("commit");
      expect(await work).toBeInstanceOf(UserAccessError);
      expect(
        decryptVaultLogin(
          (await admin.query(`select * from "vaultLogin" where "id"=$1`, [stored.id])).rows[0],
          "alice",
          stored.id,
        ).password,
      ).toBe("password");
    } finally {
      await blocker.query("rollback").catch(() => {});
      await work;
      await blocker.end();
    }
  },
);
integration(
  "Vault rollback preserves data and unexpected errors never disclose crypto or SQL details",
  async () => {
    const stored = await createVaultLogin("alice", "Seed", "user", "password");
    await admin.query(`update "vaultLogin" set "authTag"='invalid' where "id"=$1`, [stored.id]);
    let error;
    try {
      await updateVaultLogin("alice", stored.id, { password: "new" });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(Error);
    expect(actionError(error, "safe fallback")).toBe("safe fallback");
    expect(
      actionError(new Error("private provider token and internal host"), "safe fallback"),
    ).toBe("safe fallback");
    expect(actionError(new PublicActionError("Sign in to manage your account."), "fallback")).toBe(
      "Sign in to manage your account.",
    );
    expect(
      (await admin.query(`select "name","authTag" from "vaultLogin" where "id"=$1`, [stored.id]))
        .rows[0],
    ).toEqual({ name: "Seed", authTag: "invalid" });
  },
);
integration("malformed Vault fields and patches cannot allocate or update records", async () => {
  for (const fields of [
    ["", "u", "p"],
    ["x".repeat(101), "u", "p"],
    ["bad\u0000name", "u", "p"],
    ["x", "u".repeat(321), "p"],
    ["x", "u", "p".repeat(4097)],
    [undefined, "u", "p"],
    ["x", undefined, "p"],
    ["x", "u", undefined],
  ])
    await expect(createVaultLogin("alice", ...fields)).rejects.toBeInstanceOf(PublicActionError);
  const stored = await createVaultLogin("alice", "Seed", "u", "p");
  for (const patch of [
    { userId: "bob" },
    {},
    { name: undefined },
    { password: 10 },
    { name: null },
    [],
    null,
  ])
    await expect(updateVaultLogin("alice", stored.id, patch)).rejects.toBeInstanceOf(
      PublicActionError,
    );
  expect(await listVaultLogins("alice")).toHaveLength(1);
});
for (const actor of ["unverified", "missing"])
  integration(
    `${actor} cannot read, refresh, start or disconnect an agent connection`,
    async () => {
      for (const work of [
        () => connectionStatus(actor),
        () => startNativeLogin(actor),
        () => refreshNativeConnection(actor),
        () => disconnectAgentConnection(actor),
      ])
        await expect(work()).rejects.toMatchObject({ code: "access_denied", status: 403 });
      expect(remoteActions).toEqual([]);
    },
  );
integration(
  "native connection results contain own metadata and runner identities are opaque and distinct",
  async () => {
    const before = await connectionStatus("alice");
    expect(before.accountLabel).toBe("Alice");
    expect(JSON.stringify(before)).not.toContain(secret);
    expect(JSON.stringify(before)).not.toContain("encryptedTokens");
    const started = await startNativeLogin("alice");
    expect(started).toEqual(login());
    expect((await connectionStatus("alice")).status).toBe("connecting");
    expect((await refreshNativeConnection("alice")).accountLabel).toBe(
      "private-account@example.test",
    );
    await refreshNativeConnection("bob");
    expect(remoteActions[0].owner).toBe(
      createHmac("sha256", secret).update("tidy:runner:owner:alice").digest("hex"),
    );
    expect(new Set(remoteActions.map((x) => x.owner)).size).toBe(2);
  },
);
integration("verification loss during runner lookup prevents connection publication", async () => {
  remoteHook = async (action) => {
    if (action === "account")
      await admin.query(`update "user" set "emailVerified"=false where "id"='alice'`);
  };
  await expect(refreshNativeConnection("alice")).rejects.toMatchObject({ status: 403 });
  expect(
    (await admin.query(`select "accountLabel" from "agentConnection" where "userId"='alice'`))
      .rows[0].accountLabel,
  ).toBe("Alice");
});
integration("a delayed account lookup cannot revive a disconnected connection", async () => {
  const held = pause();
  remoteHook = async (action) => {
    if (action === "account") await held.hook();
  };
  const refresh = refreshNativeConnection("alice");
  await held.entered;
  await disconnectAgentConnection("alice");
  held.release();
  expect((await refresh).status).toBe("disconnected");
  expect((await connectionStatus("alice")).accountLabel).toBeNull();
});
integration(
  "reconnect waits for an older logout while its disconnect fence remains committed",
  async () => {
    const held = pause();
    remoteHook = async (action) => {
      if (action === "logout") await held.hook();
    };
    const disconnect = disconnectAgentConnection("alice");
    await held.entered;
    const native = startNativeLogin("alice");
    try {
      const pid = await waitingApplication();
      expect(await blocked(pid)).toBe(true);
      expect(remoteActions.map((x) => x.action)).toEqual(["logout"]);
      expect(
        (await admin.query(`select "status" from "agentConnection" where "userId"='alice'`)).rows[0]
          .status,
      ).toBe("disconnected");
    } finally {
      held.release();
      await disconnect;
      await native;
    }
    expect(remoteActions.map((x) => x.action)).toEqual(["logout", "login"]);
    expect((await connectionStatus("alice")).status).toBe("connecting");
  },
);
integration(
  "five occupied disconnect gates can independently commit their durable fences",
  async () => {
    await admin.query(`insert into "user" ("id","name","email","emailVerified") select 'user-'||n,'Fixture','user-'||n||'@example.test',true from generate_series(1,5) n;
    insert into "agentConnection" ("id","userId","provider","subject","clientId","accountLabel","status") select gen_random_uuid(),u."id",'codex','','codex-managed','','connected' from "user" u where u."id" like 'user-%';`);
    let count = 0,
      enter,
      release;
    const entered = new Promise((r) => (enter = r)),
      gate = new Promise((r) => (release = r));
    remoteHook = async (action) => {
      if (action === "logout") {
        if (++count === 5) enter();
        await gate;
      }
    };
    const works = Array.from({ length: 5 }, (_, i) => disconnectAgentConnection(`user-${i + 1}`));
    try {
      await entered;
      expect(
        (
          await admin.query(
            `select count(*)::int as count from "agentConnection" where "userId" like 'user-%' and "status"='disconnected'`,
          )
        ).rows[0].count,
      ).toBe(5);
    } finally {
      release();
      await Promise.all(works);
    }
  },
  15000,
);
integration("failed logout leaves revocation durable and releases the reconnect gate", async () => {
  remoteHook = async (action) => {
    if (action === "logout") throw new Error("private service secret failure");
  };
  await disconnectAgentConnection("alice");
  expect((await connectionStatus("alice")).status).toBe("disconnected");
  remoteHook = undefined;
  await expect(startNativeLogin("alice")).resolves.toEqual(login());
});
integration("runner headers and streamed bodies obey cancellation and byte ceilings", async () => {
  const controller = new AbortController();
  globalThis.fetch = mock(async () => new Promise(() => {}));
  const stalled = runWithRequestSignal(controller.signal, () => runnerRequest("alice", "account"));
  setTimeout(() => controller.abort(new Error("private timeout reason")), 20);
  await expect(stalled).rejects.toMatchObject({ status: 503 });
  let cancelled = 0;
  globalThis.fetch = mock(
    async () =>
      new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(new Uint8Array(1_048_577));
          },
          cancel() {
            cancelled++;
            return new Promise(() => {});
          },
        }),
      ),
  );
  await expect(runnerRequest("alice", "account")).rejects.toMatchObject({ status: 502 });
  expect(cancelled).toBe(1);
  const bodyController = new AbortController();
  globalThis.fetch = mock(
    async () =>
      new Response(
        new ReadableStream({
          pull() {
            return new Promise(() => {});
          },
          cancel() {
            cancelled++;
            return new Promise(() => {});
          },
        }),
      ),
  );
  const body = runWithRequestSignal(bodyController.signal, () => runnerRequest("alice", "account"));
  setTimeout(() => bodyController.abort(), 20);
  await expect(body).rejects.toMatchObject({ status: 502 });
  expect(cancelled).toBe(2);
});
integration(
  "agent JSON rejects unsupported encoding, oversized streams and cancellation without waiting for cancellation acknowledgement",
  async () => {
    const req = (body, headers = {}, signal) =>
      new Request("https://app.example/api/agents", {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body,
        duplex: "half",
        signal,
      });
    await expect(agentBody(req("{}", { "content-encoding": "gzip" }))).rejects.toMatchObject({
      status: 415,
    });
    let cancelled = 0;
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(new Uint8Array(33));
      },
      cancel() {
        cancelled++;
        return new Promise(() => {});
      },
    });
    await expect(agentBody(req(stream), 32)).rejects.toMatchObject({ status: 413 });
    expect(cancelled).toBe(1);
    const controller = new AbortController();
    const stalled = agentBody(
      req(
        new ReadableStream({
          pull() {
            return new Promise(() => {});
          },
          cancel() {
            cancelled++;
            return new Promise(() => {});
          },
        }),
        {},
        controller.signal,
      ),
    );
    setTimeout(() => controller.abort(), 20);
    await expect(stalled).rejects.toMatchObject({ status: 408 });
    expect(cancelled).toBe(2);
    expect((await agentFailure(new Error("private credential host")).json()).error).not.toContain(
      "private",
    );
  },
);

integration(
  "unverified accounts cannot list personal session or OAuth metadata and unknown OAuth revocation creates no permanent markers",
  async () => {
    await expect(listAccountSessions("unverified")).rejects.toBeInstanceOf(UserAccessError);
    await expect(
      authorizedClients("unverified", "https://app.example/api/mcp"),
    ).rejects.toBeInstanceOf(UserAccessError);
    await expect(revokeMcpAuthorization("unverified", "unknown")).rejects.toBeInstanceOf(
      UserAccessError,
    );
    for (let n = 0; n < 20; n++) await revokeMcpAuthorization("alice", `unknown-${n}`);
    expect((await admin.query(`select 1 from "verification"`)).rows).toEqual([]);
  },
);
integration(
  "hosted personal limits fail closed before credential handling and provider calls",
  async () => {
    const key = Symbol.for("__cloudflare-context__"),
      old = globalThis[key],
      nav = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    try {
      Object.defineProperty(globalThis, "navigator", {
        value: { userAgent: "Cloudflare-Workers" },
        configurable: true,
      });
      globalThis[key] = {
        env: {
          BETTER_AUTH_SECRET: "personal-guard-fixture-secret-at-least-32-characters",
          HYPERDRIVE: { connectionString: testUrl },
          AUTH_GUARD: {
            idFromName: (n) => n,
            get: () => ({ consume: async () => ({ allowed: false, retryAfter: 60 }) }),
          },
        },
        ctx: { waitUntil() {} },
      };
      const originalKey = process.env.VAULT_ENCRYPTION_KEY;
      process.env.VAULT_ENCRYPTION_KEY = "invalid-private-key";
      try {
        await expect(createVaultLogin("alice", "Seed", "u", "p")).rejects.toMatchObject({
          status: 429,
        });
      } finally {
        process.env.VAULT_ENCRYPTION_KEY = originalKey;
      }
      await expect(startNativeLogin("alice")).rejects.toMatchObject({ status: 429 });
      expect(remoteActions).toEqual([]);
      globalThis[key].env.AUTH_GUARD.get = () => ({
        consume: async () => {
          throw new Error("private guard internal-host");
        },
      });
      let failure;
      try {
        await refreshNativeConnection("alice");
      } catch (error) {
        failure = error;
      }
      expect(failure.status).toBe(503);
      expect(JSON.stringify(await agentFailure(failure).json())).not.toContain("internal-host");
      expect(remoteActions).toEqual([]);
      expect((await admin.query(`select 1 from "vaultLogin"`)).rows).toEqual([]);
    } finally {
      if (nav) Object.defineProperty(globalThis, "navigator", nav);
      else delete globalThis.navigator;
      if (old === undefined) delete globalThis[key];
      else globalThis[key] = old;
    }
  },
);
