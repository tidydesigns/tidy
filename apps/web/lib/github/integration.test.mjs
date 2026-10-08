import { afterAll, beforeAll, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { generateKeyPairSync } from "node:crypto";
import { Client } from "pg";
import { blankDesignDocument, buildDrawnNode } from "../design/document";
import { seal } from "./crypto";
import { hash } from "./crypto";

mock.module("server-only", () => ({}));
const { db } = await import("../db");
const { attachInstallation, repositoryAccess, connectionStatus } = await import("./connections");
const { inDatabaseScope } = await import("../database-scope");
const {
  authorizedReview,
  createFeedback,
  getReviewContext,
  linkPullRequest,
  listReviews,
  recordFeedbackResponse,
  sendFeedback,
  uploadCapture,
  verifyFeedback,
} = await import("./reviews");
const { processWebhook } = await import("./webhooks");
const { userToken } = await import("./client");
const {
  beginAuthorization: beginSessionAuthorization,
  completeAuthorization: completeSessionAuthorization,
} = await import("./oauth");
const sessionId = (userId) => `session-${userId}`;
const beginAuthorization = (userId, org) =>
  beginSessionAuthorization(userId, org, sessionId(userId));
const completeAuthorization = (userId, state, cookie, code) =>
  completeSessionAuthorization(userId, state, cookie, code, sessionId(userId));
const { registerGitHubTools } = await import("./mcp");
const { GITHUB_HISTORY_LIMITS: historyLimits } = await import("../security/resource-limits");
const { GITHUB_OAUTH_LIMITS: oauthLimits } = await import("./oauth-budget");
const { disconnectGithubUser } = await import("./connections");

// Run explicitly against a disposable local database; never fall back to .env.local.
const testUrl = process.env.GITHUB_TEST_DATABASE_URL,
  setupUrl = process.env.GITHUB_SETUP_DATABASE_URL;
let admin;
const enabled = Boolean(
  testUrl &&
  setupUrl &&
  new URL(setupUrl).hostname === "127.0.0.1" &&
  new URL(setupUrl).pathname === "/tidy_github_test" &&
  new URL(setupUrl).port === new URL(testUrl).port &&
  process.env.DATABASE_URL === testUrl &&
  new URL(testUrl).hostname === "127.0.0.1" &&
  new URL(testUrl).pathname === "/tidy_github_test",
);
const integration = enabled ? test : test.skip;
const sha1 = "1".repeat(40),
  sha2 = "2".repeat(40);
const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRz0AAAAASUVORK5CYII=";
const originalFetch = globalThis.fetch;
let head = sha1,
  repoAllowed = true,
  posts = 0,
  refreshes = 0,
  comments = [];
const frame = buildDrawnNode("frame", "artboard", null, { x: 0, y: 0, width: 400, height: 300 });
const document = {
  ...blankDesignDocument(),
  nodes: [
    frame,
    {
      ...buildDrawnNode("label", "text", "frame", { x: 10, y: 10, width: 100, height: 30 }),
      text: "Original",
      sourcePath: "app/page.tsx",
      sourceKey: "heading",
    },
    {
      ...buildDrawnNode("image", "image", "frame", { x: 0, y: 60, width: 1, height: 1 }),
      type: "image",
      assetId: "00000000-0000-4000-8000-000000000001",
    },
  ],
};
const pull = () => ({
  number: 7,
  title: "Improve login",
  html_url: "https://github.com/tidydesigns/tidy/pull/7",
  state: "open",
  merged: false,
  head: { sha: head, ref: "feat/login" },
  base: { sha: "0".repeat(40), repo: { id: 42, full_name: "tidydesigns/tidy" } },
});
const linked = () =>
  linkPullRequest("alice", "file", {
    url: "https://github.com/tidydesigns/tidy/pull/7",
    frameIds: ["frame"],
    expectedRevision: 1,
  });
for (const scenario of ["oversized", "encoded", "canceled"]) {
  integration(
    `review route rejects ${scenario} JSON before provider or snapshot work`,
    async () => {
      const { auth } = await import("../auth");
      const { githubConfig } = await import("./config");
      const { POST } = await import("../../app/api/files/[uid]/reviews/route");
      const session = spyOn(auth.api, "getSession").mockResolvedValue({ user: { id: "alice" } });
      const controller = new AbortController();
      const canceled = mock(() => {});
      const requestsBefore = globalThis.fetch.mock.calls.length;
      try {
        const headers = { origin: githubConfig().origin, "content-type": "application/json" };
        if (scenario === "encoded") headers["content-encoding"] = "gzip";
        const body =
          scenario === "canceled"
            ? new ReadableStream({ cancel: canceled })
            : scenario === "oversized"
              ? "x".repeat(3 * 1024 * 1024 + 1)
              : "{}";
        const work = POST(
          new Request("http://localhost/api/files/file/reviews", {
            method: "POST",
            headers,
            body,
            signal: controller.signal,
          }),
          { params: Promise.resolve({ uid: "file" }) },
        );
        if (scenario === "canceled") {
          await Bun.sleep(5);
          controller.abort();
        }
        const response = await work;
        expect(response.status).toBe(
          scenario === "canceled" ? 408 : scenario === "encoded" ? 415 : 413,
        );
        expect(globalThis.fetch.mock.calls.length).toBe(requestsBefore);
        expect(
          (await admin.query('select count(*)::int as count from "githubReview"')).rows[0].count,
        ).toBe(0);
        if (scenario === "canceled") expect(canceled).toHaveBeenCalledTimes(1);
      } finally {
        session.mockRestore();
      }
    },
  );
}
const captureInput = () => ({
  frameId: "frame",
  sha: head,
  route: "/login",
  width: 1,
  height: 1,
  mimeType: "image/png",
  base64: png,
});
beforeAll(async () => {
  if (!enabled) return;
  admin = new Client({ connectionString: setupUrl });
  await admin.connect();
  expect((await db.query("select current_user as role")).rows[0].role).toBe("tidy_runtime_fixture");
  await admin.query('update "billingDeployment" set "selfHosted"=true');
});
beforeEach(async () => {
  if (!enabled) return;
  process.env.VAULT_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
  process.env.GITHUB_CLIENT_SECRET = "test-only-secret";
  process.env.GITHUB_APP_ID = "12345";
  process.env.GITHUB_CLIENT_ID = "fixture-github-client";
  process.env.GITHUB_APP_SLUG = "fixture-github-app";
  process.env.BETTER_AUTH_URL = "http://localhost:3000";
  process.env.BETTER_AUTH_SECRET = "local-test-secret-with-at-least-32-characters";
  process.env.GITHUB_PRIVATE_KEY = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
    publicKeyEncoding: { type: "pkcs1", format: "pem" },
  }).privateKey;
  head = sha1;
  repoAllowed = true;
  posts = 0;
  refreshes = 0;
  comments = [];
  globalThis.fetch = mock(async (input, init) => {
    const url = new URL(input);
    let value;
    if (url.pathname === "/login/oauth/access_token") {
      refreshes++;
      value = {
        access_token: "refreshed",
        refresh_token: "new-refresh",
        expires_in: 28800,
        refresh_token_expires_in: 10000,
      };
    } else if (url.pathname === "/user") value = { id: 100, login: "alice" };
    else if (url.pathname === "/user/installations")
      value = {
        installations: [
          { id: 9, app_id: 12345, account: { login: "tidydesigns" }, suspended_at: null },
        ],
      };
    else if (url.pathname === "/user/installations/9/repositories")
      value = { repositories: repoAllowed ? [{ id: 42, full_name: "tidydesigns/tidy" }] : [] };
    else if (url.pathname === "/repos/tidydesigns/tidy") value = { id: 42 };
    else if (url.pathname === "/repos/tidydesigns/tidy/pulls/7") value = pull();
    else if (url.pathname.endsWith("/commits")) value = [{ sha: sha1 }, { sha: sha2 }];
    else if (url.pathname.endsWith("/check-runs"))
      value = { check_runs: [{ name: "build", status: "completed", conclusion: "success" }] };
    else if (url.pathname.endsWith("/status")) value = { state: "success" };
    else if (url.pathname.endsWith("/deployments"))
      value = [{ id: 1, sha: head, environment: "preview" }];
    else if (url.pathname.endsWith("/deployments/1/statuses"))
      value = [{ state: "success", environment_url: "https://preview.example.com/login" }];
    else if (url.pathname.endsWith("/issues/7/comments")) {
      if (init?.method === "POST") {
        posts++;
        const comment = {
          id: posts,
          body: JSON.parse(init.body).body,
          html_url: "https://github.com/tidydesigns/tidy/pull/7#issuecomment-1",
          user: { id: 100, login: "alice" },
        };
        comments.push(comment);
        value = comment;
      } else value = comments;
    } else if (url.pathname === "/app/installations/9/access_tokens")
      value = { token: "installation-token" };
    else throw new Error(`Unexpected test HTTP request: ${url.pathname}`);
    return Response.json(value);
  });
  await admin.query(`truncate "user","organization" cascade`);
  // The original-object ledger deliberately has no organization cascade: clear
  // disposable fixture claims explicitly, including successful R2 publications.
  await admin.query('truncate "designObject"');
  await admin.query(
    `insert into "user" ("id","name","email","emailVerified") values ('alice','Alice','alice@example.test',true),('bob','Bob','bob@example.test',true),('outsider','Outsider','outsider@example.test',true)`,
  );
  await admin.query(
    `insert into "session" ("id","userId","token","expiresAt","updatedAt") select 'session-'||"id","id",'token-'||"id",now()+interval '1 day',now() from "user"`,
  );
  await admin.query(
    `insert into "organization" ("id","name","slug","createdAt","createdByUserId") values ('org','Test organisation','test',now(),'alice')`,
  );
  await admin.query(
    `insert into "member" ("id","organizationId","userId","role","createdAt") values ('a','org','alice','owner',now()),('b','org','bob','member',now())`,
  );
  await admin.query(
    `insert into "designFile" ("id","organizationId","name","createdBy") values ('file','org','Login','alice')`,
  );
  await admin.query(`insert into "designDocument" ("fileId","content") values ('file',$1)`, [
    document,
  ]);
  await admin.query(
    `insert into "designAsset" ("id","organizationId","mimeType","sha256","body") values ('00000000-0000-4000-8000-000000000001','org','image/png','fixture',$1)`,
    [Buffer.from(png, "base64")],
  );
  for (const id of ["alice", "bob"])
    await admin.query(
      `insert into "githubUser" ("userId","githubId","login","credentials") values ($1,$2,$1,$3)`,
      [
        id,
        id === "alice" ? 100 : 101,
        seal(JSON.stringify({ access_token: `token-${id}`, refresh_token: "refresh" }), id),
      ],
    );
  await attachInstallation("alice", "org", 9);
});
afterAll(async () => {
  globalThis.fetch = originalFetch;
  if (enabled) {
    await db.end();
    await admin.end();
  }
});

async function cloneReviews(reviewId, count, fileId = "file") {
  await admin.query(
    `insert into "githubReview" ("id","fileId","organizationId","installationId","repositoryId","repository","number","title","url","state","branch","baseSha","headSha","linkedSha","revision","frameIds","frameKey","content","createdBy")
    select 'retained-review-'||s,$3,r."organizationId",r."installationId",r."repositoryId",r."repository",r."number",r."title",r."url",r."state",r."branch",r."baseSha",r."headSha",r."linkedSha",100+s,r."frameIds",'retained-'||s,r."content",r."createdBy"
    from "githubReview" r cross join generate_series(1,$2::int) s where r."id"=$1`,
    [reviewId, count, fileId],
  );
}
async function cloneCaptures(captureId, count) {
  await admin.query(
    `insert into "githubCapture" ("id","reviewId","frameId","sha","route","width","height","mimeType","body","sha256","objectKey","byteSize")
    select 'retained-capture-'||s,c."reviewId",c."frameId",c."sha",'/retained-'||s,c."width",c."height",c."mimeType",c."body",c."sha256",c."objectKey",c."byteSize"
    from "githubCapture" c cross join generate_series(1,$2::int) s where c."id"=$1`,
    [captureId, count],
  );
}
async function seedFeedback(reviewId, count) {
  await admin.query(
    `insert into "githubFeedback" ("id","reviewId","sha","body","authorId")
    select 'retained-feedback-'||s,$1,$3,'Legacy feedback','alice' from generate_series(1,$2::int) s`,
    [reviewId, count, sha1],
  );
}
async function historyBytes() {
  return Number(
    (
      await admin.query(`select sum(bytes)::text as bytes from (
    select "retainedBytes" as bytes from "githubReview" where "organizationId"='org'
    union all select a."retainedBytes" from "githubReviewAsset" a join "githubReview" r on r."id"=a."reviewId" where r."organizationId"='org'
    union all select c."retainedBytes" from "githubCapture" c join "githubReview" r on r."id"=c."reviewId" where r."organizationId"='org'
    union all select f."retainedBytes" from "githubFeedback" f join "githubReview" r on r."id"=f."reviewId" where r."organizationId"='org'
  ) retained`)
    ).rows[0].bytes,
  );
}
async function reserveLegacyBytes(reviewId, target) {
  const increase = target - (await historyBytes());
  await admin.query(
    `update "githubReviewAsset" set "byteSize"=coalesce("byteSize",octet_length("body"))+$2,"body"=null,"objectKey"='legacy-retained-original' where "reviewId"=$1`,
    [reviewId, increase],
  );
  expect(await historyBytes()).toBe(target);
}

integration(
  "review admission serializes the final file slot and preserves exact retries at capacity",
  async () => {
    const original = await linked();
    await cloneReviews(original.reviewId, historyLimits.reviewsPerFile - 2);
    const next = structuredClone(document);
    next.nodes.push({ ...frame, id: "second-frame" });
    await admin.query(
      `update "designDocument" set "revision"=2,"content"=$1 where "fileId"='file'`,
      [next],
    );
    const inputs = [["frame"], ["second-frame"]].map((frameIds) => ({
      url: "https://github.com/tidydesigns/tidy/pull/7",
      frameIds,
      expectedRevision: 2,
    }));
    const results = await Promise.allSettled(
      inputs.map((input) => linkPullRequest("alice", "file", input)),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")[0].reason.message).toContain(
      "history limit",
    );
    expect(
      (await admin.query(`select count(*)::int as count from "githubReview" where "fileId"='file'`))
        .rows[0].count,
    ).toBe(historyLimits.reviewsPerFile);
    const admitted = results.findIndex((result) => result.status === "fulfilled");
    expect(await linkPullRequest("alice", "file", inputs[admitted])).toEqual(
      results[admitted].value,
    );
  },
);

integration(
  "organization review capacity cannot be bypassed with a new file and does not charge another tenant",
  async () => {
    const { reviewId } = await linked();
    await cloneReviews(reviewId, historyLimits.reviewsPerOrganization - 1);
    await admin.query(
      `insert into "designFile" ("id","organizationId","name","createdBy") values ('another-file','org','Another','alice')`,
    );
    await admin.query(
      `insert into "designDocument" ("fileId","content") values ('another-file',$1)`,
      [document],
    );
    const input = {
      url: "https://github.com/tidydesigns/tidy/pull/7",
      frameIds: ["frame"],
      expectedRevision: 1,
    };
    await expect(linkPullRequest("alice", "another-file", input)).rejects.toThrow("history limit");
    expect((await linked()).reviewId).toBe(reviewId);
    await admin.query(`insert into "organization" ("id","name","slug","createdAt","createdByUserId") values ('separate-org','Separate','separate',now(),'outsider');
    insert into "member" ("id","organizationId","userId","role","createdAt") values ('separate-member','separate-org','alice','owner',now());
    insert into "githubConnection" ("organizationId","installationId","account") values ('separate-org',9,'tidydesigns');
    insert into "designFile" ("id","organizationId","name","createdBy") values ('separate-file','separate-org','Separate','alice');`);
    await admin.query(
      `insert into "designDocument" ("fileId","content") values ('separate-file',$1)`,
      [document],
    );
    // This snapshot has no shared asset from the other tenant.
    const separate = structuredClone(document);
    separate.nodes = separate.nodes.filter((node) => node.type !== "image");
    await admin.query(`update "designDocument" set "content"=$1 where "fileId"='separate-file'`, [
      separate,
    ]);
    expect(await linkPullRequest("alice", "separate-file", input)).toHaveProperty("reviewId");
    expect(
      (
        await admin.query(
          `select count(*)::int as count from "githubReview" where "fileId"='another-file'`,
        )
      ).rows[0].count,
    ).toBe(0);
  },
);

integration(
  "capture admission serializes the final review slot before R2 and avoids uploading exact retries",
  async () => {
    const { reviewId } = await linked();
    const original = await uploadCapture("alice", reviewId, captureInput());
    await cloneCaptures(original.captureId, historyLimits.capturesPerReview - 2);
    let puts = 0;
    const symbol = Symbol.for("__cloudflare-context__"),
      previous = globalThis[symbol];
    globalThis[symbol] = {
      env: {
        HYPERDRIVE: { connectionString: setupUrl },
        DESIGN_OBJECTS: {
          put: async () => {
            puts++;
            return { etag: "fixture" };
          },
        },
      },
      ctx: {},
    };
    try {
      const results = await Promise.allSettled(
        ["/first", "/second"].map((route) =>
          uploadCapture("alice", reviewId, { ...captureInput(), route }),
        ),
      );
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(results.filter((r) => r.status === "rejected")[0].reason.message).toContain(
        "history limit",
      );
      expect(puts).toBe(1);
      expect(await uploadCapture("alice", reviewId, captureInput())).toEqual(original);
      expect(puts).toBe(1);
      expect(
        (
          await admin.query(
            `select count(*)::int as count from "githubCapture" where "reviewId"=$1`,
            [reviewId],
          )
        ).rows[0].count,
      ).toBe(historyLimits.capturesPerReview);
      expect(
        (await admin.query('select count(*)::int as count from "designObject"')).rows[0].count,
      ).toBe(1);
    } finally {
      if (previous === undefined) delete globalThis[symbol];
      else globalThis[symbol] = previous;
    }
  },
);

integration(
  "organization capture history blocks growth in another review while legacy captures remain readable",
  async () => {
    const { reviewId } = await linked();
    const original = await uploadCapture("alice", reviewId, captureInput());
    await cloneCaptures(original.captureId, historyLimits.capturesPerOrganization - 1);
    await admin.query(`update "designDocument" set "revision"=2 where "fileId"='file'`);
    const next = await linkPullRequest("alice", "file", {
      url: "https://github.com/tidydesigns/tidy/pull/7",
      frameIds: ["frame"],
      expectedRevision: 2,
    });
    await expect(uploadCapture("alice", next.reviewId, captureInput())).rejects.toThrow(
      "history limit",
    );
    expect(await uploadCapture("alice", reviewId, captureInput())).toEqual(original);
    expect((await getReviewContext("alice", reviewId)).captures).toHaveLength(
      historyLimits.capturesPerOrganization,
    );
  },
);

integration(
  "feedback admission serializes the final review slot with current viewer permission",
  async () => {
    const { reviewId } = await linked();
    await seedFeedback(reviewId, historyLimits.feedbackPerReview - 1);
    await admin.query(`update "member" set "role"='viewer' where "userId"='bob'`);
    const results = await Promise.allSettled(
      ["first", "second"].map((body) => createFeedback("bob", reviewId, { body, sha: sha1 })),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")[0].reason.message).toContain(
      "history limit",
    );
    expect(
      (
        await admin.query(
          'select count(*)::int as count from "githubFeedback" where "reviewId"=$1',
          [reviewId],
        )
      ).rows[0].count,
    ).toBe(historyLimits.feedbackPerReview);
  },
);

integration(
  "organization feedback limits cover every review rather than only the selected parent",
  async () => {
    const { reviewId } = await linked();
    await seedFeedback(reviewId, historyLimits.feedbackPerOrganization);
    await admin.query(`update "designDocument" set "revision"=2 where "fileId"='file'`);
    const next = await linkPullRequest("alice", "file", {
      url: "https://github.com/tidydesigns/tidy/pull/7",
      frameIds: ["frame"],
      expectedRevision: 2,
    });
    await expect(
      createFeedback("alice", next.reviewId, { body: "new", sha: sha1 }),
    ).rejects.toThrow("history limit");
    expect(
      (await admin.query('select count(*)::int as count from "githubFeedback"')).rows[0].count,
    ).toBe(historyLimits.feedbackPerOrganization);
  },
);

integration(
  "history byte admission counts UTF-8 feedback and rolls back rejected response growth",
  async () => {
    const { reviewId } = await linked();
    await reserveLegacyBytes(reviewId, historyLimits.bytesPerOrganization - 1000);
    await expect(
      createFeedback("alice", reviewId, { body: "界".repeat(300), sha: sha1 }),
    ).rejects.toThrow("history limit");
    expect((await admin.query('select 1 from "githubFeedback"')).rowCount).toBe(0);
    const { feedbackId } = await createFeedback("alice", reviewId, {
      body: "a".repeat(300),
      sha: sha1,
    });
    await expect(
      recordFeedbackResponse("alice", reviewId, { feedbackId, sha: sha2, body: "界".repeat(100) }),
    ).rejects.toThrow("history limit");
    expect(
      (
        await admin.query('select "response","status" from "githubFeedback" where "id"=$1', [
          feedbackId,
        ])
      ).rows[0],
    ).toEqual({ response: null, status: "open" });
    expect(
      await recordFeedbackResponse("alice", reviewId, { feedbackId, sha: sha2, body: "ok" }),
    ).toHaveProperty("status", "proposed");
    await reserveLegacyBytes(reviewId, historyLimits.bytesPerOrganization + 1);
    // Equal-size retry and reduction remain available for a legacy over-cap workspace.
    expect(
      await recordFeedbackResponse("alice", reviewId, { feedbackId, sha: sha2, body: "ok" }),
    ).toHaveProperty("status", "proposed");
    expect(
      await recordFeedbackResponse("alice", reviewId, { feedbackId, sha: sha2, body: "o" }),
    ).toHaveProperty("status", "proposed");
  },
);

integration(
  "history byte rejection prevents object claims and R2 side effects before capture publication",
  async () => {
    const { reviewId } = await linked();
    await reserveLegacyBytes(reviewId, historyLimits.bytesPerOrganization - 1);
    const put = mock(async () => {
      throw new Error("No upload allowed");
    });
    const symbol = Symbol.for("__cloudflare-context__"),
      previous = globalThis[symbol];
    globalThis[symbol] = {
      env: { HYPERDRIVE: { connectionString: setupUrl }, DESIGN_OBJECTS: { put } },
      ctx: {},
    };
    try {
      await expect(uploadCapture("alice", reviewId, captureInput())).rejects.toThrow(
        "history limit",
      );
      expect(put).not.toHaveBeenCalled();
      expect((await admin.query('select 1 from "githubCapture"')).rowCount).toBe(0);
      expect((await admin.query('select 1 from "designObject"')).rowCount).toBe(0);
    } finally {
      if (previous === undefined) delete globalThis[symbol];
      else globalThis[symbol] = previous;
    }
    // Match the other browser-route fixtures: mock the long-lived Node auth
    // instance, rather than its per-Worker request initialization proxy.
    const { auth } = await import("../auth");
    const { POST } = await import("../../app/api/github/reviews/[id]/captures/route");
    const session = spyOn(auth.api, "getSession").mockResolvedValue({ user: { id: "alice" } });
    try {
      const response = await POST(
        new Request("http://localhost:3000/captures", {
          method: "POST",
          headers: { origin: "http://localhost:3000", "content-type": "application/json" },
          body: JSON.stringify(captureInput()),
        }),
        { params: Promise.resolve({ id: reviewId }) },
      );
      expect(response.status).toBe(409);
      expect((await response.json()).error).toContain("history limit");
    } finally {
      session.mockRestore();
    }
  },
);

integration(
  "snapshots reserve canonical JSON and repeated original references before publication",
  async () => {
    const { reviewId } = await linked();
    await reserveLegacyBytes(reviewId, historyLimits.bytesPerOrganization - 1);
    await admin.query(`update "designDocument" set "revision"=2 where "fileId"='file'`);
    await expect(
      linkPullRequest("alice", "file", {
        url: "https://github.com/tidydesigns/tidy/pull/7",
        frameIds: ["frame"],
        expectedRevision: 2,
      }),
    ).rejects.toThrow("history limit");
    expect(
      (await admin.query('select count(*)::int as count from "githubReview"')).rows[0].count,
    ).toBe(1);
    expect(
      (await admin.query('select count(*)::int as count from "githubReviewAsset"')).rows[0].count,
    ).toBe(1);
    const oversized = structuredClone(document);
    oversized.nodes[1].text = "界".repeat(1700000);
    await admin.query(`update "designDocument" set "content"=$1 where "fileId"='file'`, [
      oversized,
    ]);
    await expect(
      linkPullRequest("alice", "file", {
        url: "https://github.com/tidydesigns/tidy/pull/7",
        frameIds: ["frame"],
        expectedRevision: 2,
      }),
    ).rejects.toThrow("snapshot is too large");
  },
);

integration(
  "history migration reruns preserve legacy rows and generated accounting cannot be overridden",
  async () => {
    const { reviewId } = await linked();
    await seedFeedback(reviewId, 3);
    const before = await historyBytes();
    const snapshot = (
      await admin.query('select "content" from "githubReview" where "id"=$1', [reviewId])
    ).rows[0].content;
    await admin.query(
      await readFile(
        new URL("../../../../migrations/20261007-github-history-limits.sql", import.meta.url),
        "utf8",
      ),
    );
    expect(await historyBytes()).toBe(before);
    expect(
      (await admin.query('select "content" from "githubReview" where "id"=$1', [reviewId])).rows[0]
        .content,
    ).toEqual(snapshot);
    await expect(
      admin.query('update "githubReview" set "retainedBytes"=0 where "id"=$1', [reviewId]),
    ).rejects.toThrow("can only be updated to DEFAULT");
    expect(
      (await admin.query('select count(*)::int as count from "githubFeedback"')).rows[0].count,
    ).toBe(3);
  },
);

integration(
  "unmetered legacy R2 references reject history growth while preserving exact review retries",
  async () => {
    const original = await linked();
    // Simulate metadata predating the original-storage trigger, without changing production behavior.
    await admin.query('alter table "githubReviewAsset" disable trigger "githubReviewAsset_plan"');
    try {
      await admin.query(
        `update "githubReviewAsset" set "body"=null,"byteSize"=null,"objectKey"='legacy-unmetered' where "reviewId"=$1`,
        [original.reviewId],
      );
    } finally {
      await admin.query('alter table "githubReviewAsset" enable trigger "githubReviewAsset_plan"');
    }
    expect(await linked()).toEqual(original);
    await expect(
      createFeedback("alice", original.reviewId, { body: "new", sha: sha1 }),
    ).rejects.toThrow("history limit");
    expect((await admin.query('select 1 from "githubFeedback"')).rowCount).toBe(0);
    expect((await getReviewContext("alice", original.reviewId)).review.id).toBe(original.reviewId);
  },
);

integration(
  "links idempotently and preserves design and asset bytes after live edits and deletion",
  async () => {
    const { reviewId } = await linked();
    expect((await linked()).reviewId).toBe(reviewId);
    const changed = structuredClone(document);
    changed.nodes[1].text = "Changed";
    await admin.query(
      `update "designDocument" set "content"=$1,"revision"=2 where "fileId"='file'`,
      [changed],
    );
    await admin.query(`delete from "designAsset"`);
    const context = await getReviewContext("alice", reviewId);
    expect(context.review.content.nodes[1].text).toBe("Original");
    expect(context.review.revision).toBe(1);
    expect(context.previewUrl).toBe("https://preview.example.com/login");
    expect(
      (await admin.query(`select "body" from "githubReviewAsset" where "reviewId"=$1`, [reviewId]))
        .rows[0].body,
    ).toEqual(Buffer.from(png, "base64"));
    await expect(linked()).rejects.toThrow("design changed");
  },
);
integration("enforces both membership and current GitHub repository access", async () => {
  const { reviewId } = await linked();
  await expect(authorizedReview("outsider", reviewId)).rejects.toThrow("access denied");
  await expect(attachInstallation("bob", "org", 9)).rejects.toThrow("access denied");
  repoAllowed = false;
  await expect(repositoryAccess("bob", "org", 42)).rejects.toThrow("access was removed");
  await expect(authorizedReview("alice", reviewId)).rejects.toThrow("access was removed");
});
integration(
  "rejects outdated captures and keeps prior captures across new head commits",
  async () => {
    const { reviewId } = await linked();
    const oldInput = captureInput();
    const first = await uploadCapture("alice", reviewId, oldInput);
    expect((await uploadCapture("alice", reviewId, oldInput)).captureId).toBe(first.captureId);
    head = sha2;
    await expect(uploadCapture("alice", reviewId, oldInput)).rejects.toThrow("head changed");
    await uploadCapture("alice", reviewId, captureInput());
    const context = await getReviewContext("alice", reviewId);
    expect(context.review.headSha).toBe(sha2);
    expect(context.captures.map((capture) => capture.sha)).toEqual([sha2, sha1]);
  },
);
integration(
  "feedback handoff, repeat-safe GitHub posting and author-only visual verification",
  async () => {
    const { reviewId } = await linked();
    const initialCapture = await uploadCapture("alice", reviewId, captureInput());
    const { feedbackId } = await createFeedback("alice", reviewId, {
      body: "Increase the title spacing",
      sha: sha1,
      nodeId: "label",
      captureId: initialCapture.captureId,
      point: { x: 0.2, y: 0.3 },
    });
    await sendFeedback("alice", reviewId, feedbackId);
    await sendFeedback("alice", reviewId, feedbackId);
    expect(posts).toBe(1);
    expect(comments[0].body).toContain("app/page.tsx");
    await expect(sendFeedback("bob", reviewId, feedbackId)).rejects.toThrow(
      "Only the feedback author",
    );
    await expect(
      recordFeedbackResponse("alice", reviewId, { feedbackId, sha: "f".repeat(40), body: "Fixed" }),
    ).rejects.toThrow("not part");
    head = sha2;
    await recordFeedbackResponse("bob", reviewId, {
      feedbackId,
      sha: sha2,
      body: "Updated spacing in the PR branch",
    });
    await expect(
      verifyFeedback("alice", reviewId, feedbackId, initialCapture.captureId),
    ).rejects.toThrow();
    const fix = await uploadCapture("bob", reviewId, captureInput());
    await expect(verifyFeedback("bob", reviewId, feedbackId, fix.captureId)).rejects.toThrow(
      "Only the feedback author",
    );
    await verifyFeedback("alice", reviewId, feedbackId, fix.captureId);
    expect((await getReviewContext("alice", reviewId)).feedback[0].status).toBe("verified");
  },
);
integration("webhook deduplication, canonical head reconciliation and revocation", async () => {
  const { reviewId } = await linked();
  head = sha2;
  await processWebhook("delivery-1", "pull_request", {
    installation: { id: 9 },
    repository: { id: 42 },
    pull_request: { head: { sha: sha1 } },
  });
  expect(
    (await admin.query(`select "headSha" from "githubReview" where "id"=$1`, [reviewId])).rows[0]
      .headSha,
  ).toBe(sha2);
  await processWebhook("delivery-1", "installation", {
    action: "deleted",
    installation: { id: 9 },
  });
  expect((await admin.query(`select "active" from "githubConnection"`)).rows[0].active).toBe(true);
  await processWebhook("delivery-2", "installation", {
    action: "suspend",
    installation: { id: 9 },
  });
  await expect(authorizedReview("alice", reviewId)).rejects.toThrow();
  await processWebhook("delivery-3", "github_app_authorization", {
    action: "revoked",
    sender: { id: 100 },
  });
  expect((await admin.query(`select 1 from "githubUser" where "userId"='alice'`)).rowCount).toBe(0);
});
integration(
  "failed webhook reconciliation rolls back its receipt and can be redelivered",
  async () => {
    const { reviewId } = await linked();
    const fetchBeforeFailure = globalThis.fetch;
    globalThis.fetch = mock(async () => new Response(null, { status: 503 }));
    await expect(
      processWebhook("retry-delivery", "pull_request", {
        installation: { id: 9 },
        repository: { id: 42 },
      }),
    ).rejects.toThrow();
    expect(
      (await admin.query(`select 1 from "githubWebhookDelivery" where "id"='retry-delivery'`))
        .rowCount,
    ).toBe(0);
    globalThis.fetch = fetchBeforeFailure;
    head = sha2;
    await processWebhook("retry-delivery", "pull_request", {
      installation: { id: 9 },
      repository: { id: 42 },
    });
    expect((await getReviewContext("alice", reviewId)).review.headSha).toBe(sha2);
  },
);
integration(
  "verification requires the same frame, route and viewport as the original screenshot",
  async () => {
    const { reviewId } = await linked();
    const original = await uploadCapture("alice", reviewId, captureInput());
    const { feedbackId } = await createFeedback("alice", reviewId, {
      body: "Fix the login screen",
      sha: sha1,
      captureId: original.captureId,
    });
    head = sha2;
    const otherRoute = await uploadCapture("alice", reviewId, {
      ...captureInput(),
      route: "/other",
    });
    await recordFeedbackResponse("bob", reviewId, { feedbackId, sha: sha2, body: "Fixed" });
    await expect(
      verifyFeedback("alice", reviewId, feedbackId, otherRoute.captureId),
    ).rejects.toThrow();
    const matching = await uploadCapture("alice", reviewId, captureInput());
    await verifyFeedback("alice", reviewId, feedbackId, matching.captureId);
  },
);
integration("concurrent token reads rotate an expired user token once", async () => {
  await admin.query(
    `update "githubUser" set "expiresAt"=now()-interval '1 minute',"refreshExpiresAt"=now()+interval '1 day' where "userId"='alice'`,
  );
  expect(await Promise.all([userToken("alice"), userToken("alice")])).toEqual([
    "refreshed",
    "refreshed",
  ]);
  expect(refreshes).toBe(1);
});
integration(
  "OAuth binds single-use state to the initiating account, cookie and unexpired organization membership",
  async () => {
    const started = await beginAuthorization("alice", "org");
    const redirect = new URL(started.url);
    expect(redirect.searchParams.get("code_challenge_method")).toBe("S256");
    await expect(
      completeAuthorization("alice", started.state, "other-cookie", "code"),
    ).rejects.toThrow("not be verified");
    await expect(
      completeAuthorization("bob", started.state, started.state, "code"),
    ).rejects.toThrow("expired");
    expect(refreshes).toBe(0);
    await completeAuthorization("alice", started.state, started.state, "code");
    await expect(
      completeAuthorization("alice", started.state, started.state, "code"),
    ).rejects.toThrow("expired");
    expect(refreshes).toBe(1);
    const expired = await beginAuthorization("alice", "org");
    await admin.query(
      `update "githubOAuthState" set "expiresAt"=now()-interval '1 minute' where "hash"=$1`,
      [hash(expired.state)],
    );
    await expect(
      completeAuthorization("alice", expired.state, expired.state, "code"),
    ).rejects.toThrow("expired");
    const revoked = await beginAuthorization("alice", "org");
    await admin.query(`delete from "member" where "userId"='alice'`);
    await expect(
      completeAuthorization("alice", revoked.state, revoked.state, "code"),
    ).rejects.toThrow("access denied");
    expect(refreshes).toBe(1);
  },
);
integration(
  "GitHub OAuth rejects a different live session for the same user before provider I/O",
  async () => {
    const started = await beginAuthorization("alice", "org");
    await admin.query(
      `insert into "session" ("id","userId","token","expiresAt","updatedAt") values ('replacement','alice','replacement-token',now()+interval '1 day',now())`,
    );
    const calls = globalThis.fetch.mock.calls.length;
    await expect(
      completeSessionAuthorization("alice", started.state, started.state, "code", "replacement"),
    ).rejects.toThrow("expired");
    expect(globalThis.fetch.mock.calls.length).toBe(calls);
    expect((await admin.query('select 1 from "githubOAuthState"')).rowCount).toBe(0);
  },
);
integration(
  "GitHub and Linear connect forms reject oversized, encoded and cancelled bodies before auth or state allocation",
  async () => {
    const { auth } = await import("../auth");
    const session = spyOn(auth.api, "getSession").mockRejectedValue(
      new Error("Unexpected auth lookup"),
    );
    const calls = globalThis.fetch.mock.calls.length;
    try {
      for (const provider of ["github", "linear"]) {
        const { POST } =
          provider === "github"
            ? await import("../../app/api/github/connect/route")
            : await import("../../app/api/linear/connect/route");
        for (const scenario of ["oversized", "encoded", "cancelled"]) {
          const controller = new AbortController();
          const headers = { "content-type": "application/x-www-form-urlencoded" };
          if (scenario === "encoded") headers["content-encoding"] = "gzip";
          const body =
            scenario === "cancelled"
              ? new ReadableStream({
                  cancel() {
                    return new Promise(() => {});
                  },
                })
              : scenario === "oversized"
                ? "x".repeat(16 * 1024 + 1)
                : "organizationId=org";
          const request = new Request(`http://localhost/api/${provider}/connect`, {
            method: "POST",
            headers,
            body,
            signal: controller.signal,
          });
          const handling = POST(request);
          if (scenario === "cancelled") {
            await Bun.sleep(5);
            controller.abort();
          }
          expect((await handling).status).toBe(
            scenario === "oversized" ? 413 : scenario === "encoded" ? 415 : 408,
          );
        }
      }
      expect(session).not.toHaveBeenCalled();
      expect(globalThis.fetch.mock.calls.length).toBe(calls);
      expect((await admin.query('select 1 from "githubOAuthState"')).rowCount).toBe(0);
      expect((await admin.query('select 1 from "connectorOAuthState"')).rowCount).toBe(0);
    } finally {
      session.mockRestore();
    }
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
  [
    "verification loss",
    () => admin.query(`update "user" set "emailVerified"=false where "id"='alice'`),
  ],
  ["membership removal", () => admin.query(`delete from "member" where "userId"='alice'`)],
  [
    "unknown role",
    () => admin.query(`update "member" set "role"='viewer,owner' where "userId"='alice'`),
  ],
  ["disconnect", () => disconnectGithubUser("alice")],
  [
    "state expiry",
    () => admin.query(`update "githubOAuthState" set "expiresAt"=now()-interval '1 minute'`),
  ],
]) {
  integration(
    `GitHub OAuth cannot publish after ${name} during provider identity lookup`,
    async () => {
      const started = await beginAuthorization("alice", "org");
      const before = (
        await admin.query(`select "credentials" from "githubUser" where "userId"='alice'`)
      ).rows[0].credentials;
      revokeDuringProvider("/user", change);
      await expect(
        completeAuthorization("alice", started.state, started.state, "code"),
      ).rejects.toThrow();
      const after = (
        await admin.query(`select "credentials" from "githubUser" where "userId"='alice'`)
      ).rows[0]?.credentials;
      expect(after).toEqual(name === "disconnect" ? undefined : before);
      if (name === "verification loss")
        await expect(disconnectGithubUser("alice")).rejects.toThrow("verified email");
      expect((await admin.query('select 1 from "githubOAuthState"')).rowCount).toBe(0);
    },
  );
}
integration("GitHub OAuth legacy verifier state fails closed before token exchange", async () => {
  const started = await beginAuthorization("alice", "org");
  await admin.query('update "githubOAuthState" set "verifier"=$2 where "hash"=$1', [
    hash(started.state),
    seal("x".repeat(43), `alice:${hash(started.state)}`),
  ]);
  const calls = globalThis.fetch.mock.calls.length;
  await expect(
    completeAuthorization("alice", started.state, started.state, "code"),
  ).rejects.toThrow("expired");
  expect(globalThis.fetch.mock.calls.length).toBe(calls);
});
integration(
  "GitHub OAuth callback is claimed once while disconnect can still remove pending authority",
  async () => {
    const started = await beginAuthorization("alice", "org");
    const provider = globalThis.fetch;
    let enter, release;
    const entered = new Promise((r) => {
        enter = r;
      }),
      gate = new Promise((r) => {
        release = r;
      });
    globalThis.fetch = mock(async (input, init) => {
      const response = await provider(input, init);
      if (new URL(input).pathname === "/user") {
        enter();
        await gate;
      }
      return response;
    });
    const completing = completeAuthorization("alice", started.state, started.state, "code");
    try {
      await entered;
      await expect(
        completeAuthorization("alice", started.state, started.state, "code"),
      ).rejects.toThrow("expired");
      expect(refreshes).toBe(1);
      expect((await admin.query('select 1 from "githubOAuthState"')).rowCount).toBe(1);
      await disconnectGithubUser("alice");
      release();
      await expect(completing).rejects.toThrow("expired");
      expect(
        (await admin.query(`select 1 from "githubUser" where "userId"='alice'`)).rowCount,
      ).toBe(0);
    } finally {
      release();
      await completing.catch(() => {});
    }
  },
);
integration(
  "GitHub OAuth pending state capacity is atomic and separate across users and workspaces",
  async () => {
    const seed = await beginAuthorization("alice", "org");
    await admin.query(
      `insert into "githubOAuthState" ("hash","userId","organizationId","verifier","expiresAt")
    select 'pending-'||s,"userId","organizationId","verifier","expiresAt" from "githubOAuthState", generate_series(1,$2::int) s where "hash"=$1`,
      [hash(seed.state), oauthLimits.statesPerUserOrganization - 2],
    );
    const attempts = await Promise.allSettled(
      Array.from({ length: 8 }, () => beginAuthorization("alice", "org")),
    );
    expect(attempts.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(
      (
        await admin.query(
          `select count(*)::int as n from "githubOAuthState" where "userId"='alice'`,
        )
      ).rows[0].n,
    ).toBe(oauthLimits.statesPerUserOrganization);
    await expect(beginAuthorization("bob", "org")).resolves.toBeDefined();
    await admin.query(`insert into "organization" ("id","name","slug","createdAt","createdByUserId") values ('other-oauth','Other','other-oauth',now(),'bob');
    insert into "member" ("id","organizationId","userId","role","createdAt") values ('other-oauth-member','other-oauth','alice','viewer',now())`);
    await expect(beginAuthorization("alice", "other-oauth")).resolves.toBeDefined();
    await admin.query(
      `insert into "githubOAuthState" ("hash","userId","organizationId","verifier","expiresAt")
    select 'global-pending-'||s,"userId","organizationId","verifier","expiresAt" from "githubOAuthState", generate_series(1,$2::int) s where "hash"=$1`,
      [hash(seed.state), oauthLimits.statesPerUser - 21],
    );
    await expect(beginAuthorization("alice", "other-oauth")).rejects.toMatchObject({ status: 429 });
  },
);
integration(
  "hosted GitHub OAuth budgets fail closed before encryption or state allocation",
  async () => {
    const key = Symbol.for("__cloudflare-context__"),
      previous = globalThis[key],
      nav = Object.getOwnPropertyDescriptor(globalThis, "navigator"),
      encryptionKey = process.env.VAULT_ENCRYPTION_KEY;
    const calls = globalThis.fetch.mock.calls.length;
    try {
      Object.defineProperty(globalThis, "navigator", {
        value: { userAgent: "Cloudflare-Workers" },
        configurable: true,
      });
      globalThis[key] = {
        env: {
          HYPERDRIVE: { connectionString: testUrl },
          BETTER_AUTH_SECRET: "oauth-guard-fixture-secret-at-least-32-characters",
          AUTH_GUARD: {
            idFromName: (n) => n,
            get: () => ({ consume: async () => ({ allowed: false, retryAfter: 60 }) }),
          },
        },
        ctx: { waitUntil() {} },
      };
      process.env.VAULT_ENCRYPTION_KEY = "invalid-key";
      await expect(beginAuthorization("alice", "org")).rejects.toMatchObject({ status: 429 });
      globalThis[key].env.AUTH_GUARD.get = () => ({
        consume: async () => {
          throw new Error("private internal guard");
        },
      });
      let failure;
      try {
        await beginAuthorization("alice", "org");
      } catch (error) {
        failure = error;
      }
      expect(failure.status).toBe(503);
      expect(failure.message).not.toContain("internal");
      expect((await admin.query('select 1 from "githubOAuthState"')).rowCount).toBe(0);
      expect(globalThis.fetch.mock.calls.length).toBe(calls);
    } finally {
      process.env.VAULT_ENCRYPTION_KEY = encryptionKey;
      if (nav) Object.defineProperty(globalThis, "navigator", nav);
      else delete globalThis.navigator;
      if (previous === undefined) delete globalThis[key];
      else globalThis[key] = previous;
    }
  },
);
integration(
  "admitted GitHub OAuth publication retains its initiating session until commit",
  async () => {
    const started = await beginAuthorization("alice", "org"),
      blocker = new Client({ connectionString: setupUrl }),
      revoker = new Client({ connectionString: setupUrl });
    await blocker.connect();
    await revoker.connect();
    await admin.query(`create function "testOAuthPublication"() returns trigger language plpgsql as $$ begin perform pg_advisory_xact_lock(hashtextextended('oauth-publication-fixture',0)); return NEW; end $$;
    create trigger "testOAuthPublication" before insert on "githubUser" for each row execute function "testOAuthPublication"()`);
    let completing, revoking;
    try {
      await blocker.query("begin");
      await blocker.query(
        "select pg_advisory_xact_lock(hashtextextended('oauth-publication-fixture',0))",
      );
      const blockerPid = (await blocker.query("select pg_backend_pid() as pid")).rows[0].pid;
      completing = completeAuthorization("alice", started.state, started.state, "code");
      let admitted = false;
      for (let n = 0; n < 100 && !admitted; n++) {
        admitted = (
          await admin.query(
            `select exists(select 1 from pg_stat_activity where usename='tidy_runtime_fixture' and $1=any(pg_blocking_pids(pid))) as admitted`,
            [blockerPid],
          )
        ).rows[0].admitted;
        if (!admitted) await Bun.sleep(5);
      }
      expect(admitted).toBe(true);
      const revokerPid = (await revoker.query("select pg_backend_pid() as pid")).rows[0].pid;
      revoking = revoker.query(`delete from "session" where "id"='session-alice'`);
      let blocked = false;
      for (let n = 0; n < 100 && !blocked; n++) {
        blocked = (
          await admin.query("select cardinality(pg_blocking_pids($1))>0 as blocked", [revokerPid])
        ).rows[0].blocked;
        if (!blocked) await Bun.sleep(5);
      }
      expect(blocked).toBe(true);
      await blocker.query("commit");
      await expect(completing).resolves.toEqual({ organizationId: "org" });
      await revoking;
      await expect(beginAuthorization("alice", "org")).rejects.toThrow("expired");
    } finally {
      await blocker.query("rollback").catch(() => {});
      await completing?.catch(() => {});
      await revoking?.catch(() => {});
      await admin.query(
        'drop trigger "testOAuthPublication" on "githubUser"; drop function "testOAuthPublication"()',
      );
      await blocker.end();
      await revoker.end();
    }
  },
);
integration("MCP exposes the full review loop and cannot bypass repository access", async () => {
  const tools = new Map();
  registerGitHubTools(
    { registerTool: (name, definition, handler) => tools.set(name, { definition, handler }) },
    "alice",
  );
  expect([...tools.keys()]).toHaveLength(8);
  const linked = await tools.get("link_pull_request").handler({
    file_id: "file",
    url: "https://github.com/tidydesigns/tidy/pull/7",
    frame_ids: ["frame"],
    expected_revision: 1,
  });
  const reviewId = linked.structuredContent.reviewId;
  const capture = await tools
    .get("upload_implementation_capture")
    .handler({ review_id: reviewId, ...captureInput() });
  expect(capture.isError).toBeUndefined();
  const image = await tools.get("get_review_image").handler({
    review_id: reviewId,
    kind: "capture",
    image_id: capture.structuredContent.captureId,
  });
  expect(image.structuredContent.base64).toBe(png);
  repoAllowed = false;
  expect((await tools.get("get_review_context").handler({ review_id: reviewId })).isError).toBe(
    true,
  );
  expect(
    (
      await tools.get("get_review_image").handler({
        review_id: reviewId,
        kind: "capture",
        image_id: capture.structuredContent.captureId,
      })
    ).isError,
  ).toBe(true);
});
integration(
  "review routes enforce authentication, same-origin writes and authenticated image access",
  async () => {
    const { auth } = await import("../auth");
    const { GET: list, POST: link } = await import("../../app/api/files/[uid]/reviews/route");
    const { GET: image } =
      await import("../../app/api/github/reviews/[id]/captures/[captureId]/route");
    const { POST: webhook } = await import("../../app/api/github/webhook/route");
    const session = spyOn(auth.api, "getSession").mockResolvedValue(null);
    try {
      expect(
        (
          await list(new Request("http://localhost/api/files/file/reviews"), {
            params: Promise.resolve({ uid: "file" }),
          })
        ).status,
      ).toBe(401);
      expect(
        (
          await link(
            new Request("http://localhost/api/files/file/reviews", {
              method: "POST",
              headers: { origin: "https://attacker.example" },
              body: "{}",
            }),
            { params: Promise.resolve({ uid: "file" }) },
          )
        ).status,
      ).toBe(403);
      session.mockResolvedValue({ user: { id: "alice" } });
      const { reviewId } = await linked();
      const { captureId } = await uploadCapture("alice", reviewId, captureInput());
      const response = await image(new Request("http://localhost/image"), {
        params: Promise.resolve({ id: reviewId, captureId }),
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("private, no-cache");
      expect(Buffer.from(await response.arrayBuffer()).toString("base64")).toBe(png);
      session.mockResolvedValue({ user: { id: "outsider" } });
      expect(
        (
          await image(new Request("http://localhost/image"), {
            params: Promise.resolve({ id: reviewId, captureId }),
          })
        ).status,
      ).toBe(403);
      process.env.GITHUB_WEBHOOK_SECRET = "test-hook";
      expect(
        (
          await webhook(
            new Request("http://localhost/hook", {
              method: "POST",
              headers: { "x-github-delivery": "bad-signature", "x-github-event": "ping" },
              body: "{}",
            }),
          )
        ).status,
      ).toBe(401);
      expect(
        (await admin.query(`select 1 from "githubWebhookDelivery" where "id"='bad-signature'`))
          .rowCount,
      ).toBe(0);
    } finally {
      session.mockRestore();
    }
  },
);

integration(
  "a role revoked during provider I/O cannot publish an installation connection",
  async () => {
    await admin.query('delete from "githubConnection"');
    const provider = globalThis.fetch;
    globalThis.fetch = mock(async (input, init) => {
      const response = await provider(input, init);
      if (new URL(input).pathname === "/user/installations/9/repositories") {
        await admin.query('update "member" set "role"=\'viewer\' where "userId"=\'alice\'');
      }
      return response;
    });
    await expect(attachInstallation("alice", "org", 9)).rejects.toThrow("access denied");
    expect((await admin.query('select * from "githubConnection"')).rows).toEqual([]);
  },
);

const revocations = {
  "membership removal": () => admin.query('delete from "member" where "userId"=\'alice\''),
  "editor downgrade": () =>
    admin.query('update "member" set "role"=\'viewer\' where "userId"=\'alice\''),
  "verification loss": () =>
    admin.query('update "user" set "emailVerified"=false where "id"=\'alice\''),
  "installation suspension": () => admin.query('update "githubConnection" set "active"=false'),
  "GitHub disconnect": () => admin.query('delete from "githubUser" where "userId"=\'alice\''),
  "credential replacement": () =>
    admin.query('update "githubUser" set "credentials"=$1 where "userId"=\'alice\'', [
      seal(JSON.stringify({ access_token: "replacement", refresh_token: "replacement" }), "alice"),
    ]),
  "file archival": () =>
    admin.query('update "designFile" set "archivedAt"=now() where "id"=\'file\''),
};
function revokeDuringProvider(path, revoke, predicate = () => true) {
  const provider = globalThis.fetch;
  let revoked = false;
  globalThis.fetch = mock(async (input, init) => {
    const response = await provider(input, init);
    if (!revoked && new URL(input).pathname === path && predicate(init)) {
      revoked = true;
      await revoke();
    }
    return response;
  });
}
for (const [reason, revoke] of Object.entries(revocations)) {
  integration(`review linking rejects ${reason} during pull lookup`, async () => {
    revokeDuringProvider("/repos/tidydesigns/tidy/pulls/7", revoke);
    await expect(linked()).rejects.toThrow("access denied");
    expect((await admin.query('select 1 from "githubReview"')).rowCount).toBe(0);
    expect((await admin.query('select 1 from "githubReviewAsset"')).rowCount).toBe(0);
  });
  integration(`capture publication rejects ${reason} before touching object storage`, async () => {
    const { reviewId } = await linked();
    let puts = 0;
    const symbol = Symbol.for("__cloudflare-context__"),
      previous = globalThis[symbol];
    globalThis[symbol] = {
      env: {
        HYPERDRIVE: { connectionString: setupUrl },
        DESIGN_OBJECTS: {
          put: async () => {
            puts++;
            throw new Error("Should not publish.");
          },
        },
      },
      ctx: {},
    };
    try {
      revokeDuringProvider("/repos/tidydesigns/tidy/pulls/7", revoke);
      await expect(uploadCapture("alice", reviewId, captureInput())).rejects.toThrow(
        "access denied",
      );
      expect((await admin.query('select 1 from "githubCapture"')).rowCount).toBe(0);
      expect((await admin.query('select 1 from "designObject"')).rowCount).toBe(0);
      expect(puts).toBe(0);
    } finally {
      if (previous === undefined) delete globalThis[symbol];
      else globalThis[symbol] = previous;
    }
  });
  if (reason !== "editor downgrade") {
    integration(`review context rejects ${reason} before publishing pull metadata`, async () => {
      const { reviewId } = await linked();
      head = sha2;
      revokeDuringProvider("/repos/tidydesigns/tidy/pulls/7", revoke);
      await expect(getReviewContext("alice", reviewId)).rejects.toThrow("access denied");
      expect(
        (await admin.query('select "headSha" from "githubReview" where "id"=$1', [reviewId]))
          .rows[0].headSha,
      ).toBe(sha1);
    });
  }
}
integration("feedback creation rechecks verification after the current-commit lookup", async () => {
  const { reviewId } = await linked();
  head = sha2;
  revokeDuringProvider("/repos/tidydesigns/tidy/pulls/7", revocations["verification loss"]);
  await expect(
    createFeedback("alice", reviewId, { sha: sha2, body: "Private feedback" }),
  ).rejects.toThrow("access denied");
  expect((await admin.query('select 1 from "githubFeedback"')).rowCount).toBe(0);
});
integration("fix responses recheck editor authority after reading pull commits", async () => {
  const { reviewId } = await linked();
  const { feedbackId } = await createFeedback("alice", reviewId, {
    sha: sha1,
    body: "Private feedback",
  });
  revokeDuringProvider("/repos/tidydesigns/tidy/pulls/7/commits", revocations["editor downgrade"]);
  await expect(
    recordFeedbackResponse("alice", reviewId, { feedbackId, sha: sha2, body: "Fixed" }),
  ).rejects.toThrow("access denied");
  expect(
    (
      await admin.query('select "status","response","fixSha" from "githubFeedback" where "id"=$1', [
        feedbackId,
      ])
    ).rows[0],
  ).toEqual({ status: "open", response: null, fixSha: null });
});
integration(
  "feedback handoff rechecks authority after remote retry recovery and does not POST",
  async () => {
    const { reviewId } = await linked();
    const { feedbackId } = await createFeedback("alice", reviewId, {
      sha: sha1,
      body: "Private feedback",
    });
    revokeDuringProvider(
      "/repos/tidydesigns/tidy/issues/7/comments",
      revocations["editor downgrade"],
      (init) => init?.method !== "POST",
    );
    await expect(sendFeedback("alice", reviewId, feedbackId)).rejects.toThrow("access denied");
    expect(posts).toBe(0);
    expect(
      (
        await admin.query('select "githubCommentId" from "githubFeedback" where "id"=$1', [
          feedbackId,
        ])
      ).rows[0].githubCommentId,
    ).toBeNull();
  },
);
integration("late provider reads cannot return context after verification loss", async () => {
  const { reviewId } = await linked();
  revokeDuringProvider(
    "/repos/tidydesigns/tidy/commits/" + sha1 + "/check-runs",
    revocations["verification loss"],
  );
  await expect(getReviewContext("alice", reviewId)).rejects.toThrow("access denied");
});

integration("private review originals retain live membership through R2 retrieval", async () => {
  const { reviewId } = await linked();
  const { captureId } = await uploadCapture("alice", reviewId, captureInput());
  const { reviewImage } = await import("./images");
  const { Client } = await import("pg");
  const bytes = Buffer.from(png, "base64"),
    symbol = Symbol.for("__cloudflare-context__");
  const previous = globalThis[symbol],
    previousCaches = globalThis.caches;
  let enter, release;
  const entered = new Promise((resolve) => {
      enter = resolve;
    }),
    gate = new Promise((resolve) => {
      release = resolve;
    });
  await admin.query(
    `update "githubCapture" set "objectKey"='private-review-original',"body"=null,"byteSize"=$2 where "id"=$1`,
    [captureId, bytes.length],
  );
  globalThis[symbol] = {
    env: {
      HYPERDRIVE: { connectionString: setupUrl },
      DESIGN_OBJECTS: {
        get: async () => {
          enter();
          await gate;
          return { size: bytes.length, body: new Response(new Uint8Array(bytes)).body };
        },
      },
    },
    ctx: { waitUntil: (promise) => promise.catch(() => {}) },
  };
  globalThis.caches = { default: { match: async () => null, put: async () => {} } };
  const reading = reviewImage(
    "alice",
    reviewId,
    captureId,
    true,
    new Request("http://localhost/image"),
  );
  const revoker = new Client({ connectionString: setupUrl });
  await revoker.connect();
  let pending;
  try {
    await entered;
    const pid = (await revoker.query("select pg_backend_pid() as pid")).rows[0].pid;
    pending = revoker.query(
      `delete from "member" where "organizationId"='org' and "userId"='alice'`,
    );
    let blocked = false;
    for (let attempt = 0; attempt < 100 && !blocked; attempt++) {
      blocked = (await admin.query("select cardinality(pg_blocking_pids($1))>0 as blocked", [pid]))
        .rows[0].blocked;
      if (!blocked) await Bun.sleep(5);
    }
    expect(blocked).toBe(true);
    release();
    const response = await reading;
    expect(response.status).toBe(200);
    await pending;
    expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
    await expect(
      reviewImage("alice", reviewId, captureId, true, new Request("http://localhost/image")),
    ).rejects.toThrow("access denied");
  } finally {
    release();
    await reading.catch(() => {});
    await pending;
    await revoker.end();
    if (previous === undefined) delete globalThis[symbol];
    else globalThis[symbol] = previous;
    if (previousCaches === undefined) delete globalThis.caches;
    else globalThis.caches = previousCaches;
  }
});

integration(
  "raw review image tools bound actual object bytes despite understated metadata",
  async () => {
    const { reviewId } = await linked();
    const { captureId } = await uploadCapture("alice", reviewId, captureInput());
    const { reviewImageBytes } = await import("./images");
    const symbol = Symbol.for("__cloudflare-context__"),
      previous = globalThis[symbol];
    await admin.query(
      `update "githubCapture" set "objectKey"='private-review-original',"body"=null,"byteSize"=1 where "id"=$1`,
      [captureId],
    );
    globalThis[symbol] = {
      env: {
        HYPERDRIVE: { connectionString: setupUrl },
        DESIGN_OBJECTS: {
          get: async () => ({ size: 1, body: new Response(new Uint8Array(3_000_001)).body }),
        },
      },
      ctx: {},
    };
    try {
      await expect(reviewImageBytes("alice", reviewId, captureId, true)).rejects.toThrow(
        "too large",
      );
    } finally {
      if (previous === undefined) delete globalThis[symbol];
      else globalThis[symbol] = previous;
    }
  },
);
integration(
  "repository/image access rejects a credential replacement during repository lookup",
  async () => {
    const { reviewId } = await linked();
    const { captureId } = await uploadCapture("alice", reviewId, captureInput());
    revokeDuringProvider(
      "/user/installations/9/repositories",
      revocations["credential replacement"],
    );
    const { reviewImage } = await import("./images");
    await expect(
      reviewImage(
        "alice",
        reviewId,
        captureId,
        true,
        new Request("http://localhost/image", { headers: { "If-None-Match": "anything" } }),
      ),
    ).rejects.toThrow("access denied");
  },
);
integration(
  "viewer comments remain allowed, while unknown roles and mismatched parents are denied",
  async () => {
    const { reviewId } = await linked();
    await admin.query('update "member" set "role"=\'viewer\' where "userId"=\'alice\'');
    expect(
      (await createFeedback("alice", reviewId, { sha: sha1, body: "Viewer comment" })).feedbackId,
    ).toBeDefined();
    await admin.query('update "member" set "role"=\'viewer,owner\' where "userId"=\'alice\'');
    await expect(authorizedReview("alice", reviewId)).rejects.toThrow("access denied");
    await admin.query('update "member" set "role"=\'owner\' where "userId"=\'alice\'');
    await admin.query(
      'insert into "organization" ("id","name","slug","createdAt","createdByUserId") values (\'foreign\',\'Foreign\',\'foreign\',now(),\'outsider\')',
    );
    await admin.query(
      'insert into "githubConnection" ("organizationId","installationId","account") values (\'foreign\',9,\'foreign\')',
    );
    await admin.query('update "githubReview" set "organizationId"=\'foreign\' where "id"=$1', [
      reviewId,
    ]);
    await expect(authorizedReview("alice", reviewId)).rejects.toThrow("access denied");
  },
);
integration("capture feedback cannot substitute a child from another review", async () => {
  const { reviewId } = await linked();
  const { captureId } = await uploadCapture("alice", reviewId, captureInput());
  await admin.query('update "designDocument" set "revision"=2 where "fileId"=\'file\'');
  const { reviewId: second } = await linkPullRequest("alice", "file", {
    url: "https://github.com/tidydesigns/tidy/pull/7",
    frameIds: ["frame"],
    expectedRevision: 2,
  });
  await expect(
    createFeedback("alice", second, { sha: sha1, captureId, body: "Wrong parent" }),
  ).rejects.toThrow("does not match");
});
integration("review listings discard access validated with replaced credentials", async () => {
  const { reviewId } = await linked();
  expect((await listReviews("alice", "file")).reviews.map((row) => row.id)).toEqual([reviewId]);
  revokeDuringProvider("/user/installations/9/repositories", revocations["credential replacement"]);
  expect((await listReviews("alice", "file")).reviews).toEqual([]);
});
integration(
  "installation status discards stale identity results and rechecks membership",
  async () => {
    revokeDuringProvider("/user/installations", revocations["credential replacement"]);
    const status = await connectionStatus("alice", "org");
    expect(status.installations).toEqual([]);
    expect(status.error).toContain("connection changed");
    revokeDuringProvider("/user/installations", revocations["membership removal"]);
    await expect(connectionStatus("alice", "org")).rejects.toThrow("access denied");
  },
);
integration(
  "installation status does not expose provider results when credential validation fails",
  async () => {
    const query = db.query.bind(db);
    const check = spyOn(db, "query").mockImplementation((sql, ...args) => {
      if (typeof sql === "string" && sql.includes('select 1 from "githubUser" g'))
        return Promise.reject(new Error("Credential validation unavailable."));
      return query(sql, ...args);
    });
    try {
      const status = await connectionStatus("alice", "org");
      expect(status.installations).toEqual([]);
      expect(status.error).toBe("Could not complete the request.");
    } finally {
      check.mockRestore();
    }
  },
);

integration(
  "review services compose in a tool transaction and refresh commits independently of rollback",
  async () => {
    const { reviewId } = await linked();
    await admin.query(
      'update "githubUser" set "expiresAt"=now()-interval \'1 minute\',"refreshExpiresAt"=now()+interval \'1 day\' where "userId"=\'alice\'',
    );
    const before = (
      await admin.query('select "credentials" from "githubUser" where "userId"=\'alice\'')
    ).rows[0].credentials;
    const client = await db.connect();
    let captureId;
    try {
      await client.query("begin");
      await client.query('update "user" set "name"=\'Scoped actor\' where "id"=\'alice\'');
      await inDatabaseScope(client, async () => {
        expect((await getReviewContext("alice", reviewId)).review.id).toBe(reviewId);
        captureId = (await uploadCapture("alice", reviewId, captureInput())).captureId;
        expect(
          (
            await createFeedback("alice", reviewId, {
              captureId,
              sha: sha1,
              body: "Scoped feedback",
            })
          ).feedbackId,
        ).toBeDefined();
        expect(await userToken("alice")).toBe("refreshed");
        expect(
          (await db.query('select 1 from "githubCapture" where "id"=$1', [captureId])).rowCount,
        ).toBe(1);
      });
      await client.query("rollback");
    } finally {
      await client.query("rollback").catch(() => {});
      client.release();
    }
    expect(refreshes).toBe(1);
    expect(
      (await admin.query('select "credentials" from "githubUser" where "userId"=\'alice\'')).rows[0]
        .credentials,
    ).not.toEqual(before);
    expect((await admin.query('select "name" from "user" where "id"=\'alice\'')).rows[0].name).toBe(
      "Alice",
    );
    expect(
      (await admin.query('select 1 from "githubCapture" where "id"=$1', [captureId])).rowCount,
    ).toBe(0);
    expect((await admin.query('select 1 from "githubFeedback"')).rowCount).toBe(0);
  },
);
integration(
  "an admitted GitHub POST holds authority through publication and serializes a role downgrade",
  async () => {
    const { reviewId } = await linked();
    const { feedbackId } = await createFeedback("alice", reviewId, {
      sha: sha1,
      body: "Admitted feedback",
    });
    const { Client } = await import("pg");
    const revoker = new Client({ connectionString: setupUrl });
    await revoker.connect();
    const pid = (await revoker.query("select pg_backend_pid() as pid")).rows[0].pid;
    let revoked = false,
      pending;
    const provider = globalThis.fetch;
    globalThis.fetch = mock(async (input, init) => {
      if (new URL(input).pathname.endsWith("/issues/7/comments") && init?.method === "POST") {
        pending = revoker
          .query('update "member" set "role"=\'viewer\' where "userId"=\'alice\'')
          .then(() => {
            revoked = true;
          });
        let blocked = false;
        for (let attempt = 0; attempt < 20 && !blocked; attempt++) {
          blocked = (
            await admin.query("select cardinality(pg_blocking_pids($1))>0 as blocked", [pid])
          ).rows[0].blocked;
          if (!blocked) await Bun.sleep(5);
        }
        expect(blocked).toBe(true);
        expect(revoked).toBe(false);
      }
      return provider(input, init);
    });
    try {
      expect((await sendFeedback("alice", reviewId, feedbackId)).commentId).toBe("1");
      await pending;
      expect(revoked).toBe(true);
      expect(posts).toBe(1);
      await expect(sendFeedback("alice", reviewId, feedbackId)).rejects.toThrow("access denied");
      expect(posts).toBe(1);
    } finally {
      await pending;
      await revoker.end();
    }
  },
);
integration(
  "scoped discovery does not retain a review lock ahead of webhook reconciliation",
  async () => {
    const { reviewId } = await linked();
    const { Client } = await import("pg");
    const reconciler = new Client({ connectionString: setupUrl });
    await reconciler.connect();
    const actor = await db.connect();
    let pending;
    try {
      await actor.query("begin");
      const actorPid = (await actor.query("select pg_backend_pid() as pid")).rows[0].pid;
      await inDatabaseScope(actor, async () => {
        await authorizedReview("alice", reviewId);
        await reconciler.query("begin");
        await reconciler.query("set local lock_timeout='500ms'");
        await reconciler.query("select pg_advisory_xact_lock(hashtext($1))", [reviewId]);
        // Same lock order as the webhook. An early discovery FOR SHARE would
        // block this update while the actor later waits for its advisory lock.
        await reconciler.query(
          'update "githubReview" set "title"=\'Webhook observation\' where "id"=$1',
          [reviewId],
        );
        pending = getReviewContext("alice", reviewId);
        let blocked = false;
        for (let attempt = 0; attempt < 50 && !blocked; attempt++) {
          blocked = (
            await reconciler.query("select cardinality(pg_blocking_pids($1))>0 as blocked", [
              actorPid,
            ])
          ).rows[0].blocked;
          if (!blocked) await Bun.sleep(5);
        }
        expect(blocked).toBe(true);
        await reconciler.query("commit");
        expect((await pending).review.title).toBe("Improve login");
      });
      await actor.query("rollback");
      expect(
        (await admin.query('select "title" from "githubReview" where "id"=$1', [reviewId])).rows[0]
          .title,
      ).toBe("Webhook observation");
    } finally {
      await reconciler.query("rollback").catch(() => {});
      await pending?.catch(() => {});
      await actor.query("rollback").catch(() => {});
      actor.release();
      await reconciler.end();
    }
  },
);
