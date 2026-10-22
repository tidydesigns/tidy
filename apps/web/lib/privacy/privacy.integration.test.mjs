import { afterAll, beforeAll, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { Client } from "pg";
mock.module("server-only", () => ({}));
const { db } = await import("../db");
const { exportAccount } = await import("./export");
const { ACCOUNT_EXPORT_LIMITS } = await import("../security/resource-limits");
const { deleteAccount, DELETED_USER } = await import("./delete");
const { privacyAccount } = await import("./access");
const { processPrivacyCleanup } = await import("./cleanup");
const { recordConsent, recordedConsent, maintainConsentRecords, RECEIPT_COOKIE } =
  await import("./consent-store");
const { CONSENT_VERSION, MCP_NOTICE_VERSION, consentCookie } = await import("./consent");
const { completePostHogReview } = await import("./cleanup-operations");
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
  await admin.query(
    'truncate "user",organization,verification,"privacyCleanup","privacyConsent","privacyCleanupReceipt" cascade',
  );
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
  "consent is durable, idempotent, scoped to a secret receipt and linked only to the current account",
  async () => {
    const choices = {
      version: CONSENT_VERSION,
      at: Date.now(),
      analytics: false,
      replay: true,
      diagnostics: false,
    };
    const anonymous = await recordConsent(choices, null);
    const signedIn = await recordConsent(choices, "alice", anonymous.token);
    expect(signedIn.decision.browserId).toBe(anonymous.decision.browserId);
    expect((await recordConsent(choices, "alice", anonymous.token)).decision.id).toBe(
      signedIn.decision.id,
    );
    const other = await recordConsent(choices, "bob", anonymous.token);
    expect(other.decision.browserId).not.toBe(signedIn.decision.browserId);
    expect(
      await recordedConsent(
        `${consentCookie(choices)}; ${RECEIPT_COOKIE}=${anonymous.token}`,
        choices,
        other.decision.id,
        "bob",
      ),
    ).toBe(true);
    expect(await recordedConsent(consentCookie(choices), choices, other.decision.id, "bob")).toBe(
      false,
    );
    expect(
      await recordedConsent(
        `${RECEIPT_COOKIE}=${"0".repeat(64)}`,
        choices,
        other.decision.id,
        "bob",
      ),
    ).toBe(false);
    expect(
      await recordedConsent(
        `${RECEIPT_COOKIE}=${anonymous.token}`,
        choices,
        signedIn.decision.id,
        "alice",
      ),
    ).toBe(false);
    expect(
      await recordedConsent(
        `${RECEIPT_COOKIE}=${anonymous.token}`,
        choices,
        other.decision.id,
        "alice",
      ),
    ).toBe(false);
    const exported = await exportAccount("alice", "alice-session");
    expect(exported.privacyChoices).toHaveLength(1);
    expect(JSON.stringify(exported.privacyChoices)).not.toMatch(/tokenHash|browserId/);
    expect(
      (await admin.query('select "tokenHash" from "privacyConsent"')).rows.every(
        (r) => r.tokenHash !== anonymous.token,
      ),
    ).toBe(true);
  },
);

integration(
  "consent endpoint rejects forged origins and bodies, and returns a private receipt without disclosing its secret",
  async () => {
    const { auth } = await import("../auth");
    const { POST } = await import("../../app/api/privacy/consent/route");
    const session = spyOn(auth.api, "getSession").mockResolvedValue(null);
    const original = process.env.BETTER_AUTH_URL;
    process.env.BETTER_AUTH_URL = "https://app.example.test";
    const choice = { analytics: true, replay: false, diagnostics: false };
    const headers = {
      origin: "https://app.example.test",
      "x-tidy-privacy": "1",
      cookie: consentCookie(choice),
    };
    try {
      expect(
        (
          await POST(
            new Request("http://internal/api/privacy/consent", {
              method: "POST",
              headers: { ...headers, origin: "https://attacker.example" },
            }),
          )
        ).status,
      ).toBe(403);
      expect(session).not.toHaveBeenCalled();
      expect(
        (
          await POST(
            new Request("http://internal/api/privacy/consent", {
              method: "POST",
              headers,
              body: "x".repeat(1025),
            }),
          )
        ).status,
      ).toBe(413);
      const response = await POST(
        new Request("http://internal/api/privacy/consent", { method: "POST", headers }),
      );
      expect(response.status).toBe(200);
      // Next.js represents some bodyless POSTs with a non-null, zero-byte stream.
      const emptyStream = await POST(
        new Request("http://internal/api/privacy/consent", {
          method: "POST",
          headers,
          body: new Uint8Array(0),
        }),
      );
      expect(emptyStream.status).toBe(200);
      for (const invalid of [" ", "{", JSON.stringify({ revoke: false })]) {
        expect(
          (
            await POST(
              new Request("http://internal/api/privacy/consent", {
                method: "POST",
                headers,
                body: invalid,
              }),
            )
          ).status,
        ).toBe(400);
      }
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(response.headers.get("set-cookie")).toContain("HttpOnly");
      expect(response.headers.get("set-cookie")).toContain("; Secure");
      expect(response.headers.get("set-cookie")).not.toContain("tidy_consent=");
      const body = await response.json();
      expect(body.user).toBeNull();
      expect(Object.keys(body).sort()).toEqual(["browserId", "id", "user"]);
      const consent = {
        ...choice,
        version: CONSENT_VERSION,
        at: Number(
          (await admin.query('select at from "privacyConsent" where id=$1', [body.id])).rows[0].at,
        ),
      };
      const { authorizeTelemetry } = await import("./consent-store");
      const tokenCookie = response.headers.get("set-cookie").split(";")[0];
      const request = new Request("https://app.example.test/api/t/e", {
        headers: { cookie: `${headers.cookie}; ${tokenCookie}`, "x-tidy-receipt": body.id },
      });
      expect(await authorizeTelemetry(request, consent)).toBe(true);
      session.mockResolvedValueOnce({ user: { id: "bob" } });
      expect(await authorizeTelemetry(request, consent)).toBe(false);
      const revoked = await POST(
        new Request("http://internal/api/privacy/consent", {
          method: "POST",
          headers: {
            ...headers,
            cookie: `${headers.cookie}; ${tokenCookie}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ revoke: true }),
        }),
      );
      expect(revoked.status).toBe(200);
      expect(revoked.headers.get("set-cookie")).toContain("tidy_consent=");
      expect(await authorizeTelemetry(request, consent)).toBe(false);
      expect((await admin.query('select kind from "privacyCleanup"')).rows).toEqual([
        { kind: "posthog-review" },
      ]);
    } finally {
      session.mockRestore();
      if (original === undefined) delete process.env.BETTER_AUTH_URL;
      else process.env.BETTER_AUTH_URL = original;
    }
  },
);

integration(
  "withdrawal commits a selective manual review; stale grants are rejected and completion needs explicit evidence",
  async () => {
    const granted = {
      version: CONSENT_VERSION,
      at: Date.now() - 100,
      analytics: true,
      replay: true,
      diagnostics: true,
    };
    const receipt = await recordConsent(granted, "alice");
    const withdrawn = { ...granted, at: Date.now(), replay: false };
    await recordConsent(withdrawn, "alice", receipt.token);
    await expect(recordConsent(granted, "alice", receipt.token)).rejects.toThrow("superseded");
    await expect(
      recordConsent({ ...withdrawn, replay: true }, "alice", receipt.token),
    ).rejects.toThrow("superseded");
    const jobs = (await admin.query('select * from "privacyCleanup"')).rows;
    expect(jobs).toHaveLength(1);
    const scope = JSON.parse(jobs[0].subject);
    expect(scope.withdrawn).toEqual(["replay"]);
    expect(scope.remaining.analytics).toBe(true);
    expect(scope.distinctIds).toContain("alice");
    expect(scope.distinctIds).toContain(receipt.decision.browserId);
    await processPrivacyCleanup();
    expect(
      (await admin.query('select "nextAttemptAt"::text from "privacyCleanup"')).rows[0]
        .nextAttemptAt,
    ).toBe("infinity");
    await expect(completePostHogReview(db, jobs[0].id, "")).rejects.toThrow("evidence");
    const client = await db.connect();
    try {
      await completePostHogReview(client, jobs[0].id, "restricted-register/synthetic-completion");
    } finally {
      client.release();
    }
    expect((await admin.query('select id from "privacyCleanup"')).rowCount).toBe(0);
    expect(
      (await admin.query('select reference,"subjectHash" from "privacyCleanupReceipt"')).rows[0],
    ).toMatchObject({ reference: "restricted-register/synthetic-completion" });
  },
);

integration(
  "withdrawal after an authentication change queues identity verification instead of erasing another account automatically",
  async () => {
    const granted = {
      version: CONSENT_VERSION,
      at: Date.now() - 1000,
      analytics: true,
      replay: true,
      diagnostics: false,
    };
    const original = await recordConsent(granted, "alice");
    const changed = await recordConsent(
      { ...granted, at: Date.now(), analytics: false, replay: false },
      null,
      original.token,
    );
    expect(changed.decision.browserId).not.toBe(original.decision.browserId);
    const subject = JSON.parse(
      (await admin.query('select subject from "privacyCleanup"')).rows[0].subject,
    );
    expect(subject.identityVerificationRequired).toBe(true);
    expect(subject.distinctIds).toContain("alice");
    expect((await admin.query("select id from \"user\" where id='alice'")).rowCount).toBe(1);
  },
);

integration(
  "consent expiry queues review without another visit and account deletion includes anonymous browser history",
  async () => {
    const grant = {
      version: CONSENT_VERSION,
      at: Date.now(),
      analytics: true,
      replay: false,
      diagnostics: false,
    };
    const anonymous = await recordConsent(grant, null);
    await recordConsent(grant, "alice", anonymous.token);
    await admin.query('update "privacyConsent" set "expiresAt"=now()-interval \'1 minute\'');
    await maintainConsentRecords();
    await maintainConsentRecords();
    expect((await admin.query('select kind from "privacyCleanup"')).rowCount).toBe(1);
    expect(
      JSON.parse((await admin.query('select subject from "privacyCleanup"')).rows[0].subject)
        .reason,
    ).toBe("expiry");
    await deleteAccount("alice", "alice-session", "alice@example.test");
    expect((await admin.query('select id from "privacyConsent"')).rowCount).toBe(0);
    expect(
      (
        await admin.query("select subject from \"privacyCleanup\" where kind='posthog-review'")
      ).rows.some((r) => JSON.parse(r.subject).reason === "account-deletion"),
    ).toBe(true);
  },
);
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
integration(
  "deletion authentication check is read-only and rejects stale or revoked sessions",
  async () => {
    const { checkPrivacyAuthentication } = await import("./reauth");
    await checkPrivacyAuthentication("alice", "alice-session");
    expect(
      (
        await admin.query(
          `select id from verification where identifier='privacy-reauth:alice-session'`,
        )
      ).rowCount,
    ).toBe(0);
    await admin.query(
      `update session set "createdAt"=now()-interval '6 minutes' where id='alice-session'`,
    );
    await expect(checkPrivacyAuthentication("alice", "alice-session")).rejects.toThrow(
      "Authenticate again",
    );
    await admin.query(`insert into verification (id,identifier,value,"expiresAt")
    values ('privacy-reauth:alice-session','privacy-reauth:alice-session','alice',now()+interval '2 minutes')`);
    const expiry = (
      await admin.query(
        `select "expiresAt" from verification where id='privacy-reauth:alice-session'`,
      )
    ).rows[0].expiresAt;
    await checkPrivacyAuthentication("alice", "alice-session");
    expect(
      (
        await admin.query(
          `select "expiresAt" from verification where id='privacy-reauth:alice-session'`,
        )
      ).rows[0].expiresAt,
    ).toEqual(expiry);
    await admin.query(`delete from session where id='alice-session'`);
    await expect(checkPrivacyAuthentication("alice", "alice-session")).rejects.toThrow(
      "Authenticate again",
    );
    expect((await admin.query(`select id from "user" where id='alice'`)).rowCount).toBe(1);
    expect(
      (await admin.query(`select id from "designCommentMessage" where "authorId"='alice'`))
        .rowCount,
    ).toBe(1);
    expect((await admin.query(`select id from "privacyCleanup"`)).rowCount).toBe(0);
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
  "deletion preflight points sole owners to their organizations before reauthentication",
  async () => {
    const { auth } = await import("../auth");
    const { GET } = await import("../../app/api/privacy/reauth/route");
    const session = spyOn(auth.api, "getSession").mockResolvedValue({
      user: { id: "alice" },
      session: { id: "alice-session" },
    });
    const request = () => GET(new Request("https://app.example.test/api/privacy/reauth?check=1"));
    try {
      await admin.query(`update session set "createdAt"=now()-interval '6 minutes' where id='alice-session';
      update member set role='owner' where id='a';
      update member set role='editor' where id='b'`);
      const blocked = await request();
      expect(blocked.status).toBe(409);
      expect(blocked.headers.get("Cache-Control")).toBe("private, no-store");
      expect(await blocked.json()).toMatchObject({
        code: "ORGANIZATION_OWNERSHIP_REQUIRED",
        organizations: [{ id: "org", name: "Shared" }],
      });
      expect(
        (await admin.query(`select id from verification where identifier like 'privacy-%'`))
          .rowCount,
      ).toBe(0);
      expect((await admin.query('select id from "privacyCleanup"')).rowCount).toBe(0);

      // No membership (including the other user's organizations) is exposed without a session.
      session.mockResolvedValueOnce(null);
      const anonymous = await request();
      expect(anonymous.status).toBe(401);
      expect(await anonymous.json()).not.toHaveProperty("organizations");

      // With a second owner, the same stale session now advances to reauthentication.
      await admin.query(`update member set role='owner' where id='b'`);
      const stale = await request();
      expect(stale.status).toBe(401);
      expect(await stale.json()).toMatchObject({ code: "REAUTH_REQUIRED" });
      await admin.query(`insert into verification (id,identifier,value,"expiresAt")
      values ('privacy-reauth:alice-session','privacy-reauth:alice-session','alice',now()+interval '5 minutes')`);
      expect(await (await request()).json()).toEqual({ verified: true });

      // Ownership can change after preflight; final deletion still checks under locks.
      await admin.query(`update member set role='editor' where id='b'`);
      await expect(
        deleteAccount("alice", "alice-session", "alice@example.test"),
      ).rejects.toMatchObject({
        code: "ORGANIZATION_OWNERSHIP_REQUIRED",
        organizations: [{ id: "org", name: "Shared" }],
      });
      expect((await admin.query(`select id from "user" where id='alice'`)).rowCount).toBe(1);
    } finally {
      session.mockRestore();
    }
  },
);
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
  expect(await processPrivacyCleanup()).toMatchObject({ completed: 0, failed: 1 });
  expect((await admin.query('select attempts from "privacyCleanup"')).rows[0].attempts).toBe(1);
  await admin.query('update "privacyCleanup" set "nextAttemptAt"=now()');
  process.env.PRIVACY_POSTHOG_DISABLED = "1";
  expect(await processPrivacyCleanup()).toMatchObject({ completed: 1, failed: 0 });
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
    const { startSocialReauth, finishSocialReauth } = await import("./reauth");
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
        const url = new URL(await startSocialReauth("google", "alice", "alice-session"));
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
      await expect(
        finishSocialReauth("google", "bob", "bob-session", state, "fixture-code"),
      ).rejects.toThrow("expired");
      await expect(exportAccount("alice", "alice-session")).rejects.toThrow("Authenticate again");
      await finishSocialReauth("google", "alice", "alice-session", state, "fixture-code");
      expect((await exportAccount("alice", "alice-session")).profile[0].id).toBe("alice");
      await expect(
        finishSocialReauth("google", "alice", "alice-session", state, "fixture-code"),
      ).rejects.toThrow("expired");
      await admin.query(`delete from verification where identifier='privacy-reauth:alice-session'`);
      state = await begin("google-other");
      await expect(
        finishSocialReauth("google", "alice", "alice-session", state, "fixture-code"),
      ).rejects.toThrow("linked");
      state = await begin("google-alice", "wrong-nonce");
      await expect(
        finishSocialReauth("google", "alice", "alice-session", state, "fixture-code"),
      ).rejects.toThrow("verify your identity");
      state = await begin("google-alice", undefined, "wrong-client");
      await expect(
        finishSocialReauth("google", "alice", "alice-session", state, "fixture-code"),
      ).rejects.toThrow("verify your identity");
      state = await begin();
      await admin.query(
        `update verification set "expiresAt"=now()-interval '1 second' where id='privacy-google:alice-session'`,
      );
      await expect(
        finishSocialReauth("google", "alice", "alice-session", state, "fixture-code"),
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

integration("reauthentication offers configured sign-in providers only when linked", async () => {
  const { reauthMethods, startSocialReauth } = await import("./reauth");
  const keys = [
    "GOOGLE_CLIENT_ID",
    "GOOGLE_CLIENT_SECRET",
    "AUTH_GITHUB_CLIENT_ID",
    "AUTH_GITHUB_CLIENT_SECRET",
  ];
  const previous = keys.map((key) => process.env[key]);
  try {
    keys.forEach((key) => {
      process.env[key] = "fixture";
    });
    expect(await reauthMethods("alice")).toEqual({ password: true, google: false, github: false });
    await expect(startSocialReauth("github", "alice", "alice-session")).rejects.toThrow(
      "not linked",
    );
    await admin.query(`insert into account (id,"accountId","providerId","userId","createdAt","updatedAt") values
      ('alice-github','123','github','alice',now(),now()),('alice-google','google-alice','google','alice',now(),now())`);
    expect(await reauthMethods("alice")).toEqual({ password: true, google: true, github: true });
    await admin.query(`delete from account where "providerId" != 'github' and "userId"='alice'`);
    expect(await reauthMethods("alice")).toEqual({ password: false, google: false, github: true });
    process.env.AUTH_GITHUB_CLIENT_SECRET = " ";
    expect(await reauthMethods("alice")).toEqual({ password: false, google: false, github: false });
    await expect(startSocialReauth("github", "alice", "alice-session")).rejects.toThrow(
      "unavailable",
    );
  } finally {
    keys.forEach((key, index) => {
      if (previous[index] === undefined) delete process.env[key];
      else process.env[key] = previous[index];
    });
  }
});

integration(
  "GitHub reauthentication checks PKCE, identity, state, expiry and session revocation",
  async () => {
    const { spyOn } = await import("bun:test");
    const { createHash } = await import("node:crypto");
    const { startSocialReauth, finishSocialReauth } = await import("./reauth");
    const keys = ["AUTH_GITHUB_CLIENT_ID", "AUTH_GITHUB_CLIENT_SECRET", "BETTER_AUTH_URL"];
    const previous = keys.map((key) => process.env[key]);
    Object.assign(process.env, {
      AUTH_GITHUB_CLIENT_ID: "privacy-github-client",
      AUTH_GITHUB_CLIENT_SECRET: "privacy-github-secret",
      BETTER_AUTH_URL: "https://app.example.test",
    });
    let subject = 123,
      verified = true,
      tokenFailure = false,
      profileFailure = false;
    let authorization;
    let exchanges = 0;
    const transport = spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url === "https://github.com/login/oauth/access_token") {
        exchanges++;
        const body = new URLSearchParams(String(init?.body));
        expect(body.get("client_id")).toBe("privacy-github-client");
        expect(body.get("redirect_uri")).toBe("https://app.example.test/api/auth/callback/github");
        expect(createHash("sha256").update(body.get("code_verifier")).digest("base64url")).toBe(
          authorization.searchParams.get("code_challenge"),
        );
        return Response.json(
          tokenFailure
            ? { token_type: "bearer" }
            : {
                access_token: "fresh-github-token",
                token_type: "bearer",
                scope: "read:user,user:email",
              },
        );
      }
      if (url === "https://api.github.com/user" || url === "https://api.github.com/user/emails") {
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer fresh-github-token");
        if (url.endsWith("/emails"))
          return Response.json([{ email: "alice@example.test", primary: true, verified }]);
        return profileFailure
          ? Response.json({}, { status: 401 })
          : Response.json({ id: subject, login: "alice", email: null });
      }
      throw new Error("Unexpected external request");
    });
    try {
      await admin.query(
        `insert into account (id,"accountId","providerId","userId","createdAt","updatedAt") values ('alice-github','123','github','alice',now(),now())`,
      );
      await admin.query(
        `update session set "createdAt"=now()-interval '1 day' where "userId"='alice'`,
      );
      const begin = async () => {
        authorization = new URL(await startSocialReauth("github", "alice", "alice-session"));
        expect(authorization.origin).toBe("https://github.com");
        expect(authorization.searchParams.get("prompt")).toBe("select_account");
        expect(authorization.searchParams.get("code_challenge_method")).toBe("S256");
        expect(authorization.searchParams.get("redirect_uri")).toBe(
          "https://app.example.test/api/auth/callback/github",
        );
        return authorization.searchParams.get("state");
      };
      const finish = (state) =>
        finishSocialReauth("github", "alice", "alice-session", state, "fixture-code");
      let state = await begin();
      await expect(
        finishSocialReauth("github", "bob", "bob-session", state, "fixture-code"),
      ).rejects.toThrow("expired");
      await expect(
        finishSocialReauth("google", "alice", "alice-session", state, "fixture-code"),
      ).rejects.toThrow("expired");
      await expect(finish("privacy-github:" + "x".repeat(43))).rejects.toThrow("expired");
      expect(exchanges).toBe(0);
      await finish(state);
      expect((await exportAccount("alice", "alice-session")).profile[0].id).toBe("alice");
      await expect(finish(state)).rejects.toThrow("expired");
      expect(exchanges).toBe(1);
      await admin.query(`delete from verification where identifier='privacy-reauth:alice-session'`);
      subject = 456; // Same verified email must not authorize a different GitHub ID.
      await expect(finish(await begin())).rejects.toThrow("linked");
      subject = 123;
      verified = false;
      await expect(finish(await begin())).rejects.toThrow("verified GitHub");
      verified = true;
      tokenFailure = true;
      await expect(finish(await begin())).rejects.toThrow("verify your identity");
      tokenFailure = false;
      profileFailure = true;
      await expect(finish(await begin())).rejects.toThrow("verified GitHub");
      profileFailure = false;
      state = await begin();
      await admin.query(
        `update verification set "expiresAt"=now()-interval '1 second' where id='privacy-github:alice-session'`,
      );
      await expect(finish(state)).rejects.toThrow("expired");
      state = await begin();
      await begin(); // A newer attempt replaces the older state for this session.
      await expect(finish(state)).rejects.toThrow("expired");
      state = await begin();
      await admin.query(`delete from account where id='alice-github'`);
      await expect(finish(state)).rejects.toThrow("linked");
      await expect(exportAccount("alice", "alice-session")).rejects.toThrow("Authenticate again");
      await admin.query(
        `insert into account (id,"accountId","providerId","userId","createdAt","updatedAt") values ('alice-github','123','github','alice',now(),now())`,
      );
      state = await begin();
      await admin.query(`delete from session where id='alice-session'`);
      await expect(finish(state)).rejects.toThrow("session has ended");
      expect(
        (
          await admin.query(
            `select id from verification where identifier='privacy-reauth:alice-session'`,
          )
        ).rowCount,
      ).toBe(0);
    } finally {
      transport.mockRestore();
      keys.forEach((key, index) => {
        if (previous[index] === undefined) delete process.env[key];
        else process.env[key] = previous[index];
      });
    }
  },
);

const {
  activeMcpConsent,
  setMcpConsent,
  withMcpConsent,
  maintainMcpConsentRecords,
  mcpAnalyticsId,
} = await import("./mcp-consent");

integration(
  "MCP consent is explicit, account-specific and independent of browser consent",
  async () => {
    expect(await activeMcpConsent("alice")).toBeUndefined();
    await recordConsent(
      {
        version: CONSENT_VERSION,
        at: Date.now(),
        analytics: true,
        replay: true,
        diagnostics: true,
      },
      "alice",
    );
    expect(await activeMcpConsent("alice")).toBeUndefined();
    await setMcpConsent("alice", "alice-session", true);
    const id = await activeMcpConsent("alice");
    expect(id).toBeTruthy();
    expect(await activeMcpConsent("bob")).toBeUndefined();
    await setMcpConsent("alice", "alice-session", true);
    expect(await activeMcpConsent("alice")).toBe(id);
    const exported = await exportAccount("alice", "alice-session");
    expect(exported.mcpAnalyticsChoices).toHaveLength(1);
    expect(exported.mcpAnalyticsChoices[0].enabled).toBe(true);
    expect(exported.mcpAnalyticsChoices[0].noticeVersion).toBe(MCP_NOTICE_VERSION);
  },
);

integration(
  "MCP withdrawal fences in-flight calls, queues erasure and re-opt-in uses a new identifier",
  async () => {
    await setMcpConsent("alice", "alice-session", true);
    const id = await activeMcpConsent("alice");
    const send = mock(async () => {});
    await withMcpConsent("alice", id, send);
    expect(send).toHaveBeenCalledTimes(1);
    await withMcpConsent("bob", id, send);
    expect(send).toHaveBeenCalledTimes(1);
    await setMcpConsent("alice", "alice-session", false);
    await withMcpConsent("alice", id, send);
    expect(send).toHaveBeenCalledTimes(1);
    expect(await activeMcpConsent("alice")).toBeUndefined();
    const job = (await admin.query('select subject from "privacyCleanup"')).rows[0];
    expect(JSON.parse(job.subject)).toMatchObject({
      distinctIds: [mcpAnalyticsId(id)],
      withdrawn: ["mcp-analytics"],
    });
    await setMcpConsent("alice", "alice-session", true);
    expect(await activeMcpConsent("alice")).not.toBe(id);
    await withMcpConsent("alice", id, send);
    expect(send).toHaveBeenCalledTimes(1);
  },
);

integration(
  "MCP expiry and outdated notices stop collection and queue one erasure review",
  async () => {
    for (const condition of [
      "\"expiresAt\"=now()-interval '1 second'",
      "\"noticeVersion\"='old'",
    ]) {
      await setMcpConsent("alice", "alice-session", true);
      const id = await activeMcpConsent("alice");
      await admin.query(`update "mcpAnalyticsConsent" set ${condition} where id=$1`, [id]);
      expect(await activeMcpConsent("alice")).toBeUndefined();
      const send = mock(async () => {});
      await withMcpConsent("alice", id, send);
      expect(send).not.toHaveBeenCalled();
      await maintainMcpConsentRecords();
      await maintainMcpConsentRecords();
      const jobs = (await admin.query('select subject from "privacyCleanup"')).rows.map((r) =>
        JSON.parse(r.subject),
      );
      expect(jobs.filter((j) => j.distinctIds.includes(mcpAnalyticsId(id)))).toHaveLength(1);
    }
  },
);

integration(
  "MCP account deletion queues pseudonymous events and removes consent evidence",
  async () => {
    await setMcpConsent("alice", "alice-session", true);
    const id = await activeMcpConsent("alice");
    await deleteAccount("alice", "alice-session", "alice@example.test");
    expect((await admin.query('select id from "mcpAnalyticsConsent"')).rowCount).toBe(0);
    const jobs = (
      await admin.query("select subject from \"privacyCleanup\" where kind='posthog-review'")
    ).rows;
    expect(jobs.some((j) => JSON.parse(j.subject).distinctIds.includes(mcpAnalyticsId(id)))).toBe(
      true,
    );
    const send = mock(async () => {});
    await withMcpConsent("alice", id, send);
    expect(send).not.toHaveBeenCalled();
  },
);

integration(
  "MCP consent evidence is removed after a year only after erasure is queued",
  async () => {
    await setMcpConsent("alice", "alice-session", true);
    const id = await activeMcpConsent("alice");
    await admin.query(
      `update "mcpAnalyticsConsent" set "createdAt"=now()-interval '2 years', "expiresAt"=now()-interval '1 year' where id=$1`,
      [id],
    );
    await maintainMcpConsentRecords();
    expect((await admin.query('select id from "mcpAnalyticsConsent"')).rowCount).toBe(0);
    const job = (await admin.query('select subject from "privacyCleanup"')).rows[0];
    expect(JSON.parse(job.subject).distinctIds).toEqual([mcpAnalyticsId(id)]);
  },
);

integration(
  "MCP preference API records anonymous intent and rejects cross-origin, forged-account and stale-session changes",
  async () => {
    const { auth } = await import("../auth");
    const { POST } = await import("../../app/api/privacy/mcp-analytics/route");
    const session = spyOn(auth.api, "getSession").mockResolvedValue(null);
    const origin = new URL(process.env.BETTER_AUTH_URL).origin;
    const request = (body, headers = {}) =>
      POST(
        new Request(`${origin}/api/privacy/mcp-analytics`, {
          method: "POST",
          headers: { origin, "x-tidy-privacy": "1", ...headers },
          body: JSON.stringify(
            Array.isArray(body) ? body : { noticeVersion: MCP_NOTICE_VERSION, ...body },
          ),
        }),
      );
    try {
      const anonymous = await request({ enabled: true });
      expect(anonymous.status).toBe(200);
      expect(anonymous.headers.get("set-cookie")).toContain("HttpOnly");
      expect(anonymous.headers.get("set-cookie")).toContain("SameSite=Strict");
      expect(await activeMcpConsent("alice")).toBeUndefined();
      expect(await activeMcpConsent("bob")).toBeUndefined();
      session.mockResolvedValue({ user: { id: "alice" }, session: { id: "alice-session" } });
      expect((await request({ enabled: true }, { origin: "https://attacker.test" })).status).toBe(
        403,
      );
      expect((await request({ enabled: true }, { "x-tidy-privacy": "" })).status).toBe(403);
      for (const body of [{ enabled: "true" }, { enabled: true, userId: "bob" }, {}, []])
        expect((await request(body)).status).toBe(400);
      expect((await request({ enabled: true, noticeVersion: "old" })).status).toBe(409);
      expect((await request({ enabled: true, noticeVersion: undefined })).status).toBe(409);
      const result = await request({ enabled: true });
      expect(result.status).toBe(200);
      expect(result.headers.get("cache-control")).toBe("private, no-store");
      expect(await activeMcpConsent("alice")).toBeTruthy();
      expect(await activeMcpConsent("bob")).toBeUndefined();
      expect((await request({ enabled: false, noticeVersion: "old" })).status).toBe(200);
      expect(await activeMcpConsent("alice")).toBeUndefined();
      await admin.query("delete from session where id='alice-session'");
      expect((await request({ enabled: false })).status).toBe(401);
    } finally {
      session.mockRestore();
    }
  },
);

integration(
  "MCP withdrawal waits for admitted delivery, then forbids subsequent sends",
  async () => {
    await setMcpConsent("alice", "alice-session", true);
    const id = await activeMcpConsent("alice");
    let release;
    const held = new Promise((resolve) => {
      release = resolve;
    });
    let entered;
    const started = new Promise((resolve) => {
      entered = resolve;
    });
    const sending = withMcpConsent("alice", id, async () => {
      entered();
      await held;
    });
    await started;
    let finished = false;
    const withdrawing = setMcpConsent("alice", "alice-session", false).then(() => {
      finished = true;
    });
    try {
      // Observe a real lock waiter rather than assuming a timer schedules the write.
      for (let attempt = 0; attempt < 100; attempt++) {
        const blocked = (
          await admin.query(`select 1 from pg_stat_activity
        where datname=current_database() and wait_event_type='Lock'
        and query like 'select id from "user" where id=%for update'`)
        ).rowCount;
        if (blocked) break;
        if (attempt === 99) throw new Error("Withdrawal did not wait for delivery");
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(finished).toBe(false);
    } finally {
      release();
      await sending;
      await withdrawing;
    }
    expect(finished).toBe(true);
    const send = mock(async () => {});
    await withMcpConsent("alice", id, send);
    expect(send).not.toHaveBeenCalled();
  },
);

integration(
  "unlinked MCP retention is scheduled once per UTC day without account records",
  async () => {
    const { queueMcpMonitoringErasure, mcpMonitoringId } = await import("./mcp-retention");
    const start = new Date();
    start.setUTCHours(0, 0, 0, 0);
    const end = new Date(start.getTime() + 86_399_000);
    await Promise.all([queueMcpMonitoringErasure(start), queueMcpMonitoringErasure(end)]);
    const jobs = (await admin.query('select * from "privacyCleanup"')).rows;
    expect(jobs).toHaveLength(1);
    expect(JSON.parse(jobs[0].subject)).toEqual({
      reason: "mcp-monitoring-retention",
      distinctIds: [mcpMonitoringId(start)],
    });
    expect(new Date(jobs[0].nextAttemptAt).getTime()).toBe(start.getTime() + 90 * 86_400_000);
    expect((await admin.query('select id from "mcpAnalyticsConsent"')).rowCount).toBe(0);
    await processPrivacyCleanup();
    expect((await admin.query('select attempts from "privacyCleanup"')).rows[0].attempts).toBe(0);
    const expiredDay = new Date(start.getTime() - 91 * 86_400_000);
    await queueMcpMonitoringErasure(expiredDay);
    await processPrivacyCleanup();
    const due = (
      await admin.query('select id,attempts,"nextAttemptAt" from "privacyCleanup" where attempts>0')
    ).rows[0];
    expect(due.attempts).toBe(1);
    expect(due.nextAttemptAt).toBe(Infinity);
    await completePostHogReview(admin, due.id, "synthetic provider erasure verification");
    expect(
      (await admin.query('select id from "privacyCleanupReceipt" where id=$1', [due.id])).rowCount,
    ).toBe(1);
    expect((await admin.query('select id from "privacyCleanup"')).rowCount).toBe(1);
  },
);

const { recordMcpConsentIntent, pendingMcpConsent, claimMcpConsentIntent, mcpIntentToken } =
  await import("./mcp-consent");

integration(
  "a pre-auth MCP choice binds once, retains its expiry and cannot follow another account",
  async () => {
    const { token } = await recordMcpConsentIntent(true);
    expect(await pendingMcpConsent(token)).toEqual({ enabled: true });
    expect(await activeMcpConsent("alice")).toBeUndefined();
    const before = (
      await admin.query('select id,"expiresAt","intentTokenHash" from "mcpAnalyticsConsent"')
    ).rows[0];
    expect(before.intentTokenHash).not.toBe(token);
    await expect(claimMcpConsentIntent("alice", "bob-session", token)).rejects.toThrow("Sign in");
    await claimMcpConsentIntent("alice", "alice-session", "f".repeat(64));
    expect(await activeMcpConsent("alice")).toBeUndefined();
    await claimMcpConsentIntent("alice", "alice-session", token);
    expect(await activeMcpConsent("alice")).toBe(before.id);
    expect(await pendingMcpConsent(token)).toBeUndefined();
    await claimMcpConsentIntent("bob", "bob-session", token);
    expect(await activeMcpConsent("bob")).toBeUndefined();
    const after = (
      await admin.query('select "expiresAt" from "mcpAnalyticsConsent" where id=$1', [before.id])
    ).rows[0];
    expect(after.expiresAt).toEqual(before.expiresAt);
    await setMcpConsent("alice", "alice-session", false);
    await claimMcpConsentIntent("alice", "alice-session", token);
    expect(await activeMcpConsent("alice")).toBeUndefined();
    const data = await exportAccount("alice", "alice-session");
    expect(JSON.stringify(data.mcpAnalyticsChoices)).not.toContain(token);
    expect(JSON.stringify(data.mcpAnalyticsChoices)).not.toContain("intentTokenHash");
  },
);

integration(
  "pending MCP decisions preserve newer account choices and explicit refusals supersede pending grants",
  async () => {
    const old = await recordMcpConsentIntent(true);
    await setMcpConsent("alice", "alice-session", false);
    await claimMcpConsentIntent("alice", "alice-session", old.token);
    expect(await activeMcpConsent("alice")).toBeUndefined();
    const grant = await recordMcpConsentIntent(true);
    const refusal = await recordMcpConsentIntent(false, grant.token);
    expect(await pendingMcpConsent(grant.token)).toBeUndefined();
    await setMcpConsent("bob", "bob-session", true);
    // Make the account choice older than the explicit pre-auth refusal.
    await admin.query(
      `update "mcpAnalyticsConsent" set "createdAt"=now()-interval '1 day',"lastChosenAt"=now()-interval '1 day' where "userId"='bob'`,
    );
    await claimMcpConsentIntent("bob", "bob-session", refusal.token);
    expect(await activeMcpConsent("bob")).toBeUndefined();
    expect(
      (await admin.query('select subject from "privacyCleanup"')).rows.some(
        (r) => JSON.parse(r.subject).reason === "mcp-consent-ended",
      ),
    ).toBe(true);
  },
);

integration("concurrent accounts cannot both claim a pending MCP decision", async () => {
  const intent = await recordMcpConsentIntent(true);
  await Promise.all([
    claimMcpConsentIntent("alice", "alice-session", intent.token),
    claimMcpConsentIntent("bob", "bob-session", intent.token),
  ]);
  expect(
    [await activeMcpConsent("alice"), await activeMcpConsent("bob")].filter(Boolean),
  ).toHaveLength(1);
});

integration(
  "expired or outdated anonymous choices never grant linking or create provider erasure work",
  async () => {
    for (const condition of [`"expiresAt"=now()-interval '1 second'`, `"noticeVersion"='old'`]) {
      const intent = await recordMcpConsentIntent(true);
      await admin.query(
        `update "mcpAnalyticsConsent" set ${condition} where "userId" is null and "retiredAt" is null`,
      );
      expect(await pendingMcpConsent(intent.token)).toBeUndefined();
      await claimMcpConsentIntent("alice", "alice-session", intent.token);
      expect(await activeMcpConsent("alice")).toBeUndefined();
      await maintainMcpConsentRecords();
    }
    expect((await admin.query('select id from "privacyCleanup"')).rowCount).toBe(0);
  },
);

test("MCP intent cookies reject duplicates and malformed tokens", () => {
  const token = "a".repeat(64);
  expect(mcpIntentToken(`tidy_mcp_privacy_intent=${token}`)).toBe(token);
  expect(
    mcpIntentToken(`tidy_mcp_privacy_intent=${token}; tidy_mcp_privacy_intent=${token}`),
  ).toBeUndefined();
  expect(mcpIntentToken("tidy_mcp_privacy_intent=forged")).toBeUndefined();
  expect(mcpIntentToken(null)).toBeUndefined();
});

integration(
  "reaffirming an account choice defeats an older pending opposite choice without extending expiry",
  async () => {
    for (const enabled of [false, true]) {
      await setMcpConsent("alice", "alice-session", enabled);
      const before = (
        await admin.query(
          `select id,"expiresAt" from "mcpAnalyticsConsent" where "userId"='alice' and "retiredAt" is null`,
        )
      ).rows[0];
      const pending = await recordMcpConsentIntent(!enabled);
      await setMcpConsent("alice", "alice-session", enabled);
      await claimMcpConsentIntent("alice", "alice-session", pending.token);
      expect(Boolean(await activeMcpConsent("alice"))).toBe(enabled);
      const after = (
        await admin.query(
          `select id,"expiresAt" from "mcpAnalyticsConsent" where "userId"='alice' and "retiredAt" is null`,
        )
      ).rows[0];
      expect(after).toEqual(before);
    }
  },
);

integration(
  "export rejects aggregate document bytes and recovers without truncating supported exports",
  async () => {
    const { parseDesignDocument } = await import("../design/document");
    const content = JSON.stringify(
      parseDesignDocument({
        schemaVersion: 1,
        warnings: [],
        nodes: Array.from({ length: 450 }, (_, index) => ({
          id: `text-${index}`,
          name: "Text",
          type: "text",
          parentId: null,
          box: { x: 0, y: index, width: 100, height: 20 },
          text: "漢😊".repeat(1300),
        })),
      }),
    );
    expect(Buffer.byteLength(content)).toBeLessThan(ACCOUNT_EXPORT_LIMITS.bytes);
    await admin.query(
      `insert into "designFile" (id,"organizationId",name,"createdBy") values ('large-second','org','Second design','alice')`,
    );
    await admin.query(
      `insert into "designDocument" ("fileId",content) values ('f',$1),('large-second',$1)`,
      [content],
    );
    const failure = await exportAccount("alice", "alice-session").catch((error) => error);
    expect(failure.status).toBe(413);
    expect(failure.message).toContain("complete personal data export");
    expect((await admin.query('select "fileId" from "designDocument"')).rowCount).toBe(2);
    // Removing one large fixture restores the complete supported download, and
    // the failed request must have released its capacity and transaction locks.
    await admin.query(`delete from "designFile" where id='large-second'`);
    const complete = await exportAccount("alice", "alice-session");
    expect(complete.documents).toHaveLength(1);
    expect(complete.documents[0].content.nodes).toHaveLength(450);
    expect(complete.comments.map((row) => row.body)).toEqual(["My private comment"]);
    expect(Buffer.byteLength(JSON.stringify(complete))).toBeLessThanOrEqual(
      ACCOUNT_EXPORT_LIMITS.bytes,
    );
  },
);

integration(
  "export bounds the total number of small records before returning any partial download",
  async () => {
    await admin.query(
      `insert into "designFile" (id,"organizationId",name,"createdBy")
    select 'export-row-' || n,'org','Small file','alice' from generate_series(1,$1::int) n`,
      [ACCOUNT_EXPORT_LIMITS.rows],
    );
    const failure = await exportAccount("alice", "alice-session").catch((error) => error);
    expect(failure.status).toBe(413);
    expect(failure.message).toContain("complete personal data export");
    expect((await exportAccount("bob", "bob-session")).profile[0].id).toBe("bob");
  },
);

integration(
  "export rejects concurrent isolate work without queuing another database connection",
  async () => {
    await admin.query("begin");
    await admin.query(`select id from "user" where id='alice' for update`);
    const pending = exportAccount("alice", "alice-session");
    void pending.catch(() => {});
    try {
      let waiting = false;
      for (let attempt = 0; attempt < 200; attempt++) {
        await db.query("select pg_stat_clear_snapshot()");
        if (
          (
            await db.query(`select 1 from pg_stat_activity where datname=current_database()
        and pid<>pg_backend_pid() and wait_event_type='Lock'`)
          ).rowCount
        ) {
          waiting = true;
          break;
        }
        await Bun.sleep(5);
      }
      expect(waiting).toBe(true);
      const failure = await exportAccount("bob", "bob-session").catch((error) => error);
      expect(failure.status).toBe(503);
      expect(failure.message).toContain("Another data export");
      await admin.query("commit");
      expect((await pending).profile[0].id).toBe("alice");
    } finally {
      await admin.query("rollback").catch(() => {});
      await pending.catch(() => {});
    }
    expect((await exportAccount("bob", "bob-session")).profile[0].id).toBe("bob");
  },
);
