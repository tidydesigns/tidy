import { afterAll, beforeAll, beforeEach, expect, mock, spyOn, test } from "bun:test";
mock.module("server-only", () => ({}));
const { db } = await import("../db");
const { inDatabaseScope } = await import("../database-scope");
const { userToken } = await import("../github/client");
const { seal, unseal } = await import("../github/crypto");
const url = process.env.RUNTIME_TEST_DATABASE_URL;
const enabled = Boolean(
  url &&
  url === process.env.DATABASE_URL &&
  new URL(url).hostname === "127.0.0.1" &&
  new URL(url).pathname === "/tidy_runtime_test" &&
  new URL(url).username === "tidy_runtime_fixture",
);
const integration = enabled ? test : test.skip;
const environment: Record<string, string | undefined> = process.env;
const previousKey = environment.VAULT_ENCRYPTION_KEY,
  previousSecret = environment.GITHUB_CLIENT_SECRET;
let providerFails = false,
  refreshes = 0;
let fetchMock: ReturnType<typeof spyOn<typeof globalThis, "fetch">>;
beforeAll(() => {
  if (!enabled) return;
  environment.VAULT_ENCRYPTION_KEY = Buffer.alloc(32, 11).toString("base64");
  environment.GITHUB_CLIENT_SECRET = "disposable-provider-client";
  fetchMock = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        if (String(input) !== "https://github.com/login/oauth/access_token")
          throw new Error("Unexpected network request in restricted runtime fixture.");
        refreshes++;
        const body = JSON.parse(String(init?.body)) as { refresh_token: string };
        return providerFails
          ? new Response(null, { status: 503 })
          : Response.json({
              access_token: `new-${body.refresh_token}`,
              refresh_token: `rotated-${body.refresh_token}`,
              expires_in: 3600,
              refresh_token_expires_in: 86400,
            });
      },
      { preconnect: globalThis.fetch.preconnect },
    ),
  );
});
beforeEach(async () => {
  if (!enabled) return;
  providerFails = false;
  refreshes = 0;
  await db.query('delete from "user"');
  for (let index = 0; index < 5; index++) {
    const id = `runtime-${index}`;
    await db.query(
      'insert into "user" ("id","name","email","emailVerified") values ($1,$1,$2,true)',
      [id, `${id}@example.test`],
    );
    await db.query(
      `insert into "githubUser" ("userId","githubId","login","credentials","expiresAt","refreshExpiresAt") values ($1,$2,$1,$3,now()-interval '1 minute',now()+interval '1 day')`,
      [id, index + 1, seal(JSON.stringify({ access_token: "old", refresh_token: id }), id)],
    );
  }
});
afterAll(async () => {
  if (!enabled) return;
  fetchMock.mockRestore();
  if (previousKey === undefined) delete environment.VAULT_ENCRYPTION_KEY;
  else environment.VAULT_ENCRYPTION_KEY = previousKey;
  if (previousSecret === undefined) delete environment.GITHUB_CLIENT_SECRET;
  else environment.GITHUB_CLIENT_SECRET = previousSecret;
  await db.end();
});

integration(
  "the application connects as the real restricted login without inherited administrator privileges",
  async () => {
    expect((await db.query("select current_user as role, session_user as login")).rows[0]).toEqual({
      role: "tidy_runtime_fixture",
      login: "tidy_runtime_fixture",
    });
    expect(
      (
        await db.query(
          `select rolsuper,rolbypassrls,rolcreatedb,rolcreaterole from pg_roles where rolname=current_user`,
        )
      ).rows[0],
    ).toEqual({ rolsuper: false, rolbypassrls: false, rolcreatedb: false, rolcreaterole: false });
    await expect(db.query('update "billingPlan" set "fileLimit"=null')).rejects.toMatchObject({
      code: "42501",
    });
    expect(
      (
        await db.query(
          `select has_sequence_privilege(current_user, '"designFileVersion_sequence_seq"', 'USAGE') as allocate,
            has_sequence_privilege(current_user, '"designFileVersion_sequence_seq"', 'UPDATE') as reset`,
        )
      ).rows[0],
    ).toEqual({ allocate: true, reset: false });
    await expect(db.query("create table public.forbidden_runtime (id text)")).rejects.toMatchObject(
      { code: "42501" },
    );
  },
);

integration(
  "five occupied application connections can rotate credentials independently under restricted grants",
  async () => {
    const clients = await Promise.all(Array.from({ length: 5 }, () => db.connect()));
    try {
      await Promise.all(
        clients.map(async (client, index) => {
          const id = `runtime-${index}`;
          await client.query("begin");
          try {
            await inDatabaseScope(client, async () => {
              await db.query('update "user" set "name"=$2 where "id"=$1', [
                id,
                "Rolled-back product change",
              ]);
              expect(await userToken(id)).toBe(`new-${id}`);
              expect((await db.query("select current_user as role")).rows[0].role).toBe(
                "tidy_runtime_fixture",
              );
            });
          } finally {
            await client.query("rollback");
          }
        }),
      );
    } finally {
      clients.forEach((client) => client.release());
    }
    expect(refreshes).toBe(5);
    for (let index = 0; index < 5; index++) {
      const id = `runtime-${index}`;
      const row = (
        await db.query(
          'select u."name",g."credentials" from "user" u join "githubUser" g on g."userId"=u."id" where u."id"=$1',
          [id],
        )
      ).rows[0];
      expect(row.name).toBe(id);
      expect(JSON.parse(unseal(row.credentials, id)).refresh_token).toBe(`rotated-${id}`);
    }
    expect(
      Number(
        (
          await db.query(
            "select count(*) from pg_stat_activity where usename=current_user and datname=current_database()",
          )
        ).rows[0].count,
      ),
    ).toBeGreaterThanOrEqual(6);
  },
);

integration(
  "a failed provider refresh preserves the old encrypted grant and remains retryable",
  async () => {
    providerFails = true;
    const previous = (
      await db.query('select "credentials" from "githubUser" where "userId"=$1', ["runtime-0"])
    ).rows[0].credentials;
    await expect(userToken("runtime-0")).rejects.toBeDefined();
    expect(
      (await db.query('select "credentials" from "githubUser" where "userId"=$1', ["runtime-0"]))
        .rows[0].credentials,
    ).toEqual(previous);
    providerFails = false;
    expect(await userToken("runtime-0")).toBe("new-runtime-0");
  },
);
