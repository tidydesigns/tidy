import { afterAll, beforeAll, beforeEach, expect, mock, test } from "bun:test";
import { Client } from "pg";
mock.module("server-only", () => ({}));
const { db } = await import("../db");
const { exportAccount } = await import("./export");
const { deleteAccount, DELETED_USER } = await import("./delete");
const { privacyAccount } = await import("./access");
const { processPrivacyCleanup } = await import("./cleanup");
const url = process.env.PRIVACY_TEST_DATABASE_URL;
const setup = process.env.PRIVACY_SETUP_DATABASE_URL;
const enabled =
  url &&
  setup &&
  process.env.DATABASE_URL === url &&
  new URL(url).hostname === "127.0.0.1" &&
  new URL(url).pathname === "/tidy_privacy_test" &&
  new URL(setup).hostname === "127.0.0.1" &&
  new URL(setup).pathname === "/tidy_privacy_test";
const integration = enabled ? test : test.skip;
let admin;
beforeAll(async () => {
  if (enabled) {
    admin = new Client({ connectionString: setup });
    await admin.connect();
  }
});
beforeEach(async () => {
  if (!enabled) return;
  await admin.query('update "billingDeployment" set "selfHosted"=true');
  await admin.query('truncate "user",organization,verification,"privacyCleanup" cascade');
  await admin.query(
    `insert into "user" (id,name,email,"emailVerified") values
 ('alice','Alice','alice@example.test',true),('bob','Bob','bob@example.test',true),($1,'Deleted user','deleted@tidy.invalid',false)`,
    [DELETED_USER],
  );
  await admin.query(`insert into session (id,token,"userId","expiresAt","createdAt","updatedAt") values
 ('alice-session','ALICE_SESSION_SECRET','alice',now()+interval '1 day',now(),now()),
 ('bob-session','BOB_SESSION_SECRET','bob',now()+interval '1 day',now(),now())`);
  await admin.query(`insert into organization (id,name,slug,"createdAt","createdByUserId") values ('org','Shared','shared',now(),'alice');
 insert into member (id,"userId","organizationId",role,"createdAt") values ('a','alice','org','editor',now()),('b','bob','org','owner',now());
 insert into account (id,"accountId","providerId","userId",password,"accessToken","createdAt","updatedAt") values ('a','a','credential','alice','PASSWORD_SECRET','ACCESS_SECRET',now(),now());
 insert into "designFile" (id,"organizationId",name,"createdBy") values ('f','org','My design','alice');
 insert into "designCommentThread" (id,"fileId",x,y,"createdBy") values ('t','f',0,0,'alice');
 insert into "designCommentMessage" (id,"threadId","authorId",body) values ('ma','t','alice','My private comment'),('mb','t','bob','Another persons comment');
 insert into verification (id,identifier,value,"expiresAt") values ('reset','reset-password:secret','alice',now()+interval '1 hour');`);
});
afterAll(async () => {
  if (enabled) {
    await admin.end();
    await db.end();
  }
});
integration(
  "export includes personal contributions and excludes secrets and other members",
  async () => {
    const data = await exportAccount("alice", "alice-session");
    expect(data.profile[0].email).toBe("alice@example.test");
    expect(data.comments.map((x) => x.body)).toEqual(["My private comment"]);
    expect(data.files[0].name).toBe("My design");
    const serialized = JSON.stringify(data);
    expect(serialized).not.toMatch(
      /PASSWORD_SECRET|ACCESS_SECRET|SESSION_SECRET|bob@example|Another persons comment/,
    );
  },
);
integration("export rejects expired, other-user and old sessions", async () => {
  await expect(exportAccount("alice", "bob-session")).rejects.toThrow("Authenticate again");
  await admin.query(
    `update session set "createdAt"=now()-interval '6 minutes' where id='alice-session'`,
  );
  await expect(exportAccount("alice", "alice-session")).rejects.toThrow("Authenticate again");
});
integration("wrong confirmation and last owner cannot delete or enqueue cleanup", async () => {
  await expect(deleteAccount("alice", "alice-session", "wrong")).rejects.toThrow("email address");
  await admin.query(
    `update member set role='owner' where id='a';update member set role='editor' where id='b'`,
  );
  await expect(deleteAccount("alice", "alice-session", "alice@example.test")).rejects.toThrow(
    "Transfer ownership",
  );
  expect((await admin.query('select * from "privacyCleanup"')).rows).toHaveLength(0);
  expect((await admin.query(`select * from "user" where id='alice'`)).rows).toHaveLength(1);
});
integration(
  "deletion revokes access and removes personal data while retaining shared work",
  async () => {
    await deleteAccount("alice", "alice-session", "alice@example.test");
    for (const table of ["user", "session", "account", "member"]) {
      const column = table === "user" ? "id" : "userId";
      expect(
        (await admin.query(`select * from "${table}" where "${column}"='alice'`)).rows,
      ).toHaveLength(0);
    }
    expect((await admin.query('select "createdBy" from "designFile"')).rows[0].createdBy).toBe(
      DELETED_USER,
    );
    expect(
      (await admin.query('select body from "designCommentMessage"')).rows.map((x) => x.body),
    ).toEqual(["Another persons comment"]);
    expect((await admin.query(`select * from verification where value='alice'`)).rows).toHaveLength(
      0,
    );
    expect((await admin.query('select kind from "privacyCleanup"')).rows).toEqual([
      { kind: "posthog" },
    ]);
    await expect(exportAccount("alice", "alice-session")).rejects.toThrow("Authenticate again");
  },
);
integration(
  "cross-origin and missing CSRF headers are rejected before authentication",
  async () => {
    for (const headers of [
      { origin: "https://evil.test", "x-tidy-privacy": "1" },
      { origin: "https://app.test" },
    ]) {
      await expect(
        privacyAccount(
          new Request("https://app.test/api/privacy/delete", { method: "POST", headers }),
          "privacy-delete",
        ),
      ).rejects.toThrow("configured app address");
    }
  },
);
integration("external cleanup retains failed jobs and erases successful job subjects", async () => {
  await deleteAccount("alice", "alice-session", "alice@example.test");
  const original = process.env.PRIVACY_POSTHOG_DISABLED;
  delete process.env.PRIVACY_POSTHOG_DISABLED;
  expect(await processPrivacyCleanup()).toEqual({ completed: 0, failed: 1 });
  expect((await admin.query('select attempts from "privacyCleanup"')).rows[0].attempts).toBe(1);
  await admin.query('update "privacyCleanup" set "nextAttemptAt"=now()');
  process.env.PRIVACY_POSTHOG_DISABLED = "1";
  expect(await processPrivacyCleanup()).toEqual({ completed: 1, failed: 0 });
  expect((await admin.query('select * from "privacyCleanup"')).rows).toHaveLength(0);
  if (original === undefined) delete process.env.PRIVACY_POSTHOG_DISABLED;
  else process.env.PRIVACY_POSTHOG_DISABLED = original;
});

integration(
  "database failures roll back erasure, revocation and external cleanup together",
  async () => {
    await admin.query(`create function privacy_test_failure() returns trigger language plpgsql as $$ begin raise exception 'fixture failure'; end; $$;
 create trigger privacy_test_failure before delete on "user" for each row execute function privacy_test_failure();`);
    try {
      await expect(deleteAccount("alice", "alice-session", "alice@example.test")).rejects.toThrow(
        "fixture failure",
      );
      expect(
        (await admin.query(`select "createdBy" from "designFile" where id='f'`)).rows[0].createdBy,
      ).toBe("alice");
      expect(
        (await admin.query(`select id from session where "userId"='alice'`)).rows,
      ).toHaveLength(1);
      expect(
        (await admin.query(`select id from "designCommentMessage" where "authorId"='alice'`)).rows,
      ).toHaveLength(1);
      expect((await admin.query('select * from "privacyCleanup"')).rows).toHaveLength(0);
    } finally {
      await admin.query(
        'drop trigger privacy_test_failure on "user";drop function privacy_test_failure()',
      );
    }
  },
);

integration("erasure clears retained author names, personal uploads and feedback", async () => {
  await admin.query(`insert into "designFileVersion" ("fileId",revision,content,name,kind,"createdBy","createdByName") values ('f',1,'{}','First','named','alice','Alice');
 insert into "designImport" (id,"userId","organizationId",name) values ('import','alice','org','Private import');
 insert into "feedbackSubmission" (id,"userId",category,message) values ('11111111-1111-4111-8111-111111111111','alice','general','Personal feedback');
 insert into "feedbackUpload" (id,"userId",fingerprint,attachments) values ('11111111-1111-4111-8111-111111111111','alice','digest','[{"key":"feedback/fixture/0","name":"personal.png"}]');
 update "user" set image='/api/avatars/user/alice?v=11111111-1111-4111-8111-111111111111' where id='alice';`);
  await deleteAccount("alice", "alice-session", "alice@example.test");
  const version = (await admin.query('select "createdBy","createdByName" from "designFileVersion"'))
    .rows[0];
  expect(version).toEqual({ createdBy: null, createdByName: null });
  for (const table of ["designImport", "feedbackSubmission", "feedbackUpload"])
    expect((await admin.query(`select * from "${table}"`)).rows).toHaveLength(0);
  expect(
    (await admin.query('select kind from "privacyCleanup" order by kind')).rows.map((x) => x.kind),
  ).toEqual(["avatar", "feedback", "posthog"]);
});

integration(
  "privacy uses the configured public origin across internal rewrites without trusting forwarded headers",
  async () => {
    const previous = process.env.BETTER_AUTH_URL;
    process.env.BETTER_AUTH_URL = "https://app.example.test";
    try {
      for (const operation of ["privacy-export", "privacy-delete"]) {
        const request = (headers) =>
          new Request("http://localhost:3046/api/privacy/export", {
            method: "POST",
            headers,
          });
        // No cookie: reaching authentication proves the legitimate origin passed.
        await expect(
          privacyAccount(
            request({ origin: "https://app.example.test", "x-tidy-privacy": "1" }),
            operation,
          ),
        ).rejects.toThrow("Sign in to manage your data");
        for (const headers of [
          {
            origin: "https://evil.test",
            "x-tidy-privacy": "1",
            "x-forwarded-host": "evil.test",
            "x-forwarded-proto": "https",
          },
          { origin: "http://localhost:3046", "x-tidy-privacy": "1" },
          { origin: "https://app.example.test" },
          { "x-tidy-privacy": "1" },
        ]) {
          await expect(privacyAccount(request(headers), operation)).rejects.toThrow(
            "configured app address",
          );
        }
      }
    } finally {
      if (previous === undefined) delete process.env.BETTER_AUTH_URL;
      else process.env.BETTER_AUTH_URL = previous;
    }
  },
);

integration(
  "password reauthentication unlocks only the current live session and expires after five minutes",
  async () => {
    const { hashPassword } = await import("better-auth/crypto");
    const { reauthenticatePassword } = await import("./reauth");
    await admin.query(`update account set password=$1 where "userId"='alice'`, [
      await hashPassword("fixture-password-123"),
    ]);
    await admin.query(
      `update session set "createdAt"=now()-interval '1 day' where "userId"='alice'`,
    );
    await expect(
      reauthenticatePassword("alice", "alice-session", "wrong-password"),
    ).rejects.toThrow("incorrect");
    await expect(exportAccount("alice", "alice-session")).rejects.toThrow("Authenticate again");
    await reauthenticatePassword("alice", "alice-session", "fixture-password-123");
    expect((await exportAccount("alice", "alice-session")).profile[0].id).toBe("alice");
    expect(
      (
        await admin.query(
          `select "createdAt"<now()-interval '1 hour' as old from session where id='alice-session'`,
        )
      ).rows[0].old,
    ).toBe(true);
    await admin.query(
      `insert into session (id,token,"userId","expiresAt","createdAt","updatedAt") values ('alice-other','OTHER_SECRET','alice',now()+interval '1 day',now()-interval '1 day',now())`,
    );
    await expect(exportAccount("alice", "alice-other")).rejects.toThrow("Authenticate again");
    await expect(
      reauthenticatePassword("bob", "alice-session", "fixture-password-123"),
    ).rejects.toThrow("session has ended");
    await admin.query(
      `update verification set "expiresAt"=now()-interval '1 second' where identifier='privacy-reauth:alice-session'`,
    );
    await expect(exportAccount("alice", "alice-session")).rejects.toThrow("Authenticate again");
    await admin.query(`delete from session where id='alice-session'`);
    await expect(
      reauthenticatePassword("alice", "alice-session", "fixture-password-123"),
    ).rejects.toThrow("session has ended");
  },
);

integration(
  "revoking a verified session blocks export and deletion without affecting other sessions",
  async () => {
    const { hashPassword } = await import("better-auth/crypto");
    const { reauthenticatePassword } = await import("./reauth");
    await admin.query(`update account set password=$1 where "userId"='alice'`, [
      await hashPassword("fixture-password-123"),
    ]);
    await admin.query(
      `update session set "createdAt"=now()-interval '1 day' where id='alice-session'`,
    );
    await admin.query(`insert into session (id,token,"userId","expiresAt","createdAt","updatedAt")
    values ('alice-other','OTHER_SECRET','alice',now()+interval '1 day',now(),now())`);
    await reauthenticatePassword("alice", "alice-session", "fixture-password-123");
    await admin.query(`delete from session where id='alice-other'`);
    expect((await exportAccount("alice", "alice-session")).profile[0].id).toBe("alice");
    await admin.query(`delete from session where id='alice-session'`);
    expect(
      (
        await admin.query(`select id from verification where identifier='privacy-reauth:alice-session'
    and "expiresAt">now()`)
      ).rowCount,
    ).toBe(1);
    await expect(exportAccount("alice", "alice-session")).rejects.toThrow("Authenticate again");
    await expect(deleteAccount("alice", "alice-session", "alice@example.test")).rejects.toThrow(
      "Authenticate again",
    );
    await expect(
      reauthenticatePassword("alice", "alice-session", "fixture-password-123"),
    ).rejects.toThrow("session has ended");
    expect((await admin.query(`select id from "user" where id='alice'`)).rowCount).toBe(1);
    expect(
      (await admin.query(`select id from "designCommentMessage" where "authorId"='alice'`))
        .rowCount,
    ).toBe(1);
    expect((await admin.query(`select id from "privacyCleanup"`)).rowCount).toBe(0);
  },
);

integration(
  "reauthenticated deletion removes the verification proof with the account",
  async () => {
    const { hashPassword } = await import("better-auth/crypto");
    const { reauthenticatePassword } = await import("./reauth");
    await admin.query(`update account set password=$1 where "userId"='alice'`, [
      await hashPassword("fixture-password-123"),
    ]);
    await admin.query(
      `update session set "createdAt"=now()-interval '1 day' where "userId"='alice'`,
    );
    await reauthenticatePassword("alice", "alice-session", "fixture-password-123");
    await deleteAccount("alice", "alice-session", "alice@example.test");
    expect(
      (
        await admin.query(
          `select id from verification where identifier='privacy-reauth:alice-session'`,
        )
      ).rowCount,
    ).toBe(0);
  },
);

integration(
  "Google reauthentication binds signed identity, nonce, one-use state and the original session",
  async () => {
    const { spyOn } = await import("bun:test");
    const { generateKeyPair, exportJWK, SignJWT } = await import("jose");
    const { startGoogleReauth, finishGoogleReauth } = await import("./reauth");
    const keys = ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "BETTER_AUTH_URL"];
    const previous = keys.map((key) => process.env[key]);
    Object.assign(process.env, {
      GOOGLE_CLIENT_ID: "privacy-fixture-client",
      GOOGLE_CLIENT_SECRET: "privacy-fixture-secret",
      BETTER_AUTH_URL: "https://app.example.test",
    });
    const pair = await generateKeyPair("RS256");
    const jwk = {
      ...(await exportJWK(pair.publicKey)),
      kid: "privacy-fixture",
      alg: "RS256",
      use: "sig",
    };
    let idToken;
    const transport = spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url === "https://oauth2.googleapis.com/token")
        return Response.json({
          access_token: "fixture",
          token_type: "Bearer",
          expires_in: 3600,
          id_token: idToken,
        });
      if (url === "https://www.googleapis.com/oauth2/v3/certs")
        return Response.json({ keys: [jwk] });
      throw new Error("Unexpected external request");
    });
    try {
      await admin.query(
        `insert into account (id,"accountId","providerId","userId","createdAt","updatedAt") values ('alice-google','google-alice','google','alice',now(),now())`,
      );
      await admin.query(
        `update session set "createdAt"=now()-interval '1 day' where "userId"='alice'`,
      );
      const begin = async (
        subject = "google-alice",
        nonceOverride,
        audience = "privacy-fixture-client",
      ) => {
        const url = new URL(await startGoogleReauth("alice", "alice-session"));
        expect(url.searchParams.get("prompt")).toBe("select_account");
        expect(url.searchParams.get("code_challenge_method")).toBe("S256");
        idToken = await new SignJWT({
          nonce: nonceOverride ?? url.searchParams.get("nonce"),
          email_verified: true,
        })
          .setProtectedHeader({ alg: "RS256", kid: "privacy-fixture" })
          .setIssuer("https://accounts.google.com")
          .setAudience(audience)
          .setSubject(subject)
          .setIssuedAt()
          .setExpirationTime("5m")
          .sign(pair.privateKey);
        return url.searchParams.get("state");
      };
      let state = await begin();
      await expect(finishGoogleReauth("bob", "bob-session", state, "fixture-code")).rejects.toThrow(
        "expired",
      );
      await expect(exportAccount("alice", "alice-session")).rejects.toThrow("Authenticate again");
      await finishGoogleReauth("alice", "alice-session", state, "fixture-code");
      expect((await exportAccount("alice", "alice-session")).profile[0].id).toBe("alice");
      await expect(
        finishGoogleReauth("alice", "alice-session", state, "fixture-code"),
      ).rejects.toThrow("expired");
      await admin.query(`delete from verification where identifier='privacy-reauth:alice-session'`);
      state = await begin("google-other");
      await expect(
        finishGoogleReauth("alice", "alice-session", state, "fixture-code"),
      ).rejects.toThrow("linked");
      state = await begin("google-alice", "wrong-nonce");
      await expect(
        finishGoogleReauth("alice", "alice-session", state, "fixture-code"),
      ).rejects.toThrow("verify your identity");
      state = await begin("google-alice", undefined, "wrong-client");
      await expect(
        finishGoogleReauth("alice", "alice-session", state, "fixture-code"),
      ).rejects.toThrow("verify your identity");
      state = await begin();
      await admin.query(
        `update verification set "expiresAt"=now()-interval '1 second' where id='privacy-google:alice-session'`,
      );
      await expect(
        finishGoogleReauth("alice", "alice-session", state, "fixture-code"),
      ).rejects.toThrow("expired");
      await expect(exportAccount("alice", "alice-session")).rejects.toThrow("Authenticate again");
    } finally {
      transport.mockRestore();
      keys.forEach((key, index) => {
        if (previous[index] === undefined) delete process.env[key];
        else process.env[key] = previous[index];
      });
    }
  },
);

integration(
  "reauthentication attempts are atomically limited across sessions and cleaned on deletion",
  async () => {
    const { reserveReauthAttempts } = await import("./reauth");
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () => reserveReauthAttempts("alice")),
    );
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(5);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(3);
    await admin.query(
      `update verification set "expiresAt"=now()-interval '1 second' where id='privacy-attempt:alice:60'`,
    );
    await reserveReauthAttempts("alice");
    await admin.query(`update verification set value='20' where id='privacy-attempt:alice:3600'`);
    await expect(reserveReauthAttempts("alice")).rejects.toMatchObject({ status: 429 });
    await deleteAccount("alice", "alice-session", "alice@example.test");
    expect(
      (await admin.query(`select id from verification where identifier='privacy-attempt:alice'`))
        .rowCount,
    ).toBe(0);
  },
);
