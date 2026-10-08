import { afterAll, beforeAll, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type Stripe from "stripe";
import { db } from "../db";
import { planLimitMessage } from "./plans";

// Destructive fixtures require the private cluster owned by test:plans.
const url = process.env.PLANS_TEST_DATABASE_URL;
const enabled = Boolean(
  url &&
  process.env.DATABASE_URL === url &&
  new URL(url).hostname === "127.0.0.1" &&
  new URL(url).pathname === "/tidy_plan_limits_test",
);
const integration = enabled ? test : test.skip;
mock.module("server-only", () => ({}));
let auth: (typeof import("../auth"))["auth"];
let createOrganizationForUser: (typeof import("../organizations/creation"))["createOrganizationForUser"];
let plans: typeof import("./plan-server");
let service: typeof import("../design/service");
let documents: typeof import("../design/document-service");
let billing: typeof import("./server");
let processBillingEvent: (typeof import("./webhooks"))["processBillingEvent"];
let mailMock: ReturnType<typeof spyOn<typeof import("../auth-email"), "sendAuthEmail">>;
let owner: { id: string; headers: Headers },
  other: { id: string; headers: Headers },
  third: { id: string; headers: Headers };
let org: string;
let consumeMcpCall: (typeof import("../mcp/usage"))["consumeMcpCall"];
const env: Record<string, string | undefined> = process.env;
const originalPrice = env.STRIPE_PRO_PRICE_ID,
  originalKey = env.STRIPE_SECRET_KEY;

async function account(email: string) {
  const result = await auth.api.signUpEmail({
    body: { email, name: "Designer", password: "disposable-plans-password-123" },
    returnHeaders: true,
  });
  // Billing fixtures own a disposable database; verification behavior has its own suite.
  await db.query('update "user" set "emailVerified"=true where "id"=$1', [result.response.user.id]);
  const signedIn = await auth.api.signInEmail({
    body: { email, password: "disposable-plans-password-123" },
    returnHeaders: true,
  });
  return {
    id: result.response.user.id,
    headers: new Headers({
      cookie: signedIn.headers
        .getSetCookie()
        .map((v) => v.split(";")[0])
        .join("; "),
    }),
  };
}
async function usage() {
  return plans.organizationPlanUsage(org);
}
async function file() {
  return service.createDesignFileForUser(owner.id, org, "Design");
}
async function member(userId: string, role: string) {
  await db.query(
    'insert into "member" ("id", "organizationId", "userId", "role", "createdAt") values ($1,$2,$3,$4,now())',
    [randomUUID(), org, userId, role],
  );
}
async function subscription(status = "active", price = "price_pro") {
  await db.query(
    `insert into "organization_billing" ("organizationId", "stripeStatus", "stripePriceId") values ($1,$2,$3)
    on conflict ("organizationId") do update set "stripeStatus"=$2,"stripePriceId"=$3`,
    [org, status, price],
  );
}
async function object(digest: string, bytes: number, kind = "asset") {
  await db.query(
    `insert into "designObject" ("objectKey","organizationId","mimeType","sha256","byteSize","usageKind") values ($1,$2,'image/png',$3,$4,$5)`,
    [`originals/${org}/${digest}.png`, org, digest, bytes, kind],
  );
}
async function invitation(email: string, role: "editor" | "viewer" = "editor") {
  return auth.api.createInvitation({
    headers: owner.headers,
    body: { organizationId: org, email, role },
  });
}

beforeAll(async () => {
  if (!enabled) return;
  mailMock = spyOn(await import("../auth-email"), "sendAuthEmail").mockResolvedValue();
  env.STRIPE_PRO_PRICE_ID = "price_pro";
  env.STRIPE_SECRET_KEY = "sk_test_fixture";
  await db.query("drop schema public cascade; create schema public");
  for (const migration of [
    "schema.sql",
    "schema-organization.sql",
    "schema-vault.sql",
    "schema-mcp.sql",
    "schema-design-files.sql",
    "schema-design-rectangles.sql",
    "schema-design-folders.sql",
    "schema-design-document.sql",
    "schema-design-comments.sql",
    "schema-design-comment-reactions.sql",
    "schema-github.sql",
    "20260928-file-multiplayer.sql",
    "20260929-organization-billing.sql",
    "20261003-design-object-storage.sql",
    "20261003-file-thumbnails.sql",
    "20261003-editor-change-deltas.sql",
    "20261003-plan-limits.sql",
    "20261006-mcp-call-limits.sql",
    "20261007-github-history-limits.sql",
    "20261004-organization-creation-limit.sql",
    "20261006-thumbnail-storage-limits.sql",
    "20261006-document-history-bounds.sql",
    "20261007-file-version-history.sql",
  ]) {
    await db.query(
      await readFile(resolve(import.meta.dir, "../../../..", "migrations", migration), "utf8"),
    );
  }
  ({ createOrganizationForUser } = await import("../organizations/creation"));
  ({ auth } = await import("../auth"));
  plans = await import("./plan-server");
  ({ consumeMcpCall } = await import("../mcp/usage"));
  service = await import("../design/service");
  documents = await import("../design/document-service");
  billing = await import("./server");
  ({ processBillingEvent } = await import("./webhooks"));
});
beforeEach(async () => {
  if (!enabled) return;
  await db.query('truncate "user", "organization", "designObject" cascade');
  await db.query(`update "billingDeployment" set "selfHosted"=false;
    update "billingPlan" set "fileLimit"=3,"editorLimit"=1,"storageLimit"=500000000,"mcpCallLimit"=5000 where "id"='free';
    update "billingPlan" set "fileLimit"=null,"editorLimit"=null,"storageLimit"=10000000000,"mcpCallLimit"=100000 where "id"='pro'`);
  owner = await account("owner@example.com");
  other = await account("member@example.com");
  third = await account("outsider@example.com");
  org = (await createOrganizationForUser(owner.id, "Design")).id;
  await db.query('insert into "billingPlanPrice" ("priceId") values ($1) on conflict do nothing', [
    "price_pro",
  ]);
});
afterAll(async () => {
  if (!enabled) return;
  mailMock.mockRestore();
  if (originalPrice === undefined) delete env.STRIPE_PRO_PRICE_ID;
  else env.STRIPE_PRO_PRICE_ID = originalPrice;
  if (originalKey === undefined) delete env.STRIPE_SECRET_KEY;
  else env.STRIPE_SECRET_KEY = originalKey;
  await db.end();
});

integration("Free limits are configurable and archive doesn't create free file slots", async () => {
  expect(await usage()).toEqual({
    tier: "free",
    limits: { files: 3, editors: 1, storageBytes: 500000000, mcpCalls: 5000 },
    usage: { files: 0, editors: 1, storageBytes: 0, mcpCalls: 0 },
    mcpResetAt: new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() + 1, 1))
      .toISOString()
      .replace(".000Z", "Z"),
  });
  const first = await file();
  await file();
  await file();
  await db.query('update "designFile" set "archivedAt"=now() where "id"=$1', [first.id]);
  await expect(file()).rejects.toThrow("including archived files");
  await db.query(`update "billingPlan" set "fileLimit"=4 where "id"='free'`);
  await file();
  expect((await usage()).usage.files).toBe(4);
});

integration("only one concurrent writer can take the last file slot", async () => {
  await file();
  await file();
  const outcomes = await Promise.allSettled([file(), file(), file()]);
  expect(outcomes.filter((v) => v.status === "fulfilled")).toHaveLength(1);
  expect((await usage()).usage.files).toBe(3);
  for (const outcome of outcomes)
    if (outcome.status === "rejected")
      expect(planLimitMessage(outcome.reason)).toContain("allows 3 files");
});

integration(
  "a multi-file transaction rolls back completely when it exceeds the allowance",
  async () => {
    await file();
    await file();
    const connection = await db.connect();
    try {
      await connection.query("begin");
      await expect(
        connection.query(
          `insert into "designFile" ("id","organizationId","name","createdBy")
      values ($1,$3,'Copy',$4),($2,$3,'Copy',$4)`,
          [randomUUID(), randomUUID(), org, owner.id],
        ),
      ).rejects.toThrow("allows 3 files");
      await connection.query("rollback");
    } finally {
      connection.release();
    }
    expect((await usage()).usage.files).toBe(2);
  },
);

integration(
  "Free allows viewers and blocks invitations and role promotions that grant editing",
  async () => {
    await expect(invitation("member@example.com")).rejects.toThrow("allows 1 editor");
    const invite = await invitation("member@example.com", "viewer");
    await auth.api.acceptInvitation({ headers: other.headers, body: { invitationId: invite.id } });
    await expect(
      db.query('update "member" set "role"=\'admin\' where "organizationId"=$1 and "userId"=$2', [
        org,
        other.id,
      ]),
    ).rejects.toThrow("allows 1 editor");
    await expect(
      db.query('update "invitation" set "status"=\'pending\',"role"=\'editor\' where "id"=$1', [
        invite.id,
      ]),
    ).rejects.toThrow("allows 1 editor");
    expect((await usage()).usage.editors).toBe(1);
  },
);

integration(
  "editor invitations reserve seats through acceptance, and removal releases them",
  async () => {
    await db.query(`update "billingPlan" set "editorLimit"=2 where "id"='free'`);
    const invite = await invitation("member@example.com");
    expect((await usage()).usage.editors).toBe(2);
    await expect(invitation("outsider@example.com")).rejects.toThrow("allows 2 editor");
    await auth.api.acceptInvitation({ headers: other.headers, body: { invitationId: invite.id } });
    expect((await usage()).usage.editors).toBe(2);
    await db.query('delete from "member" where "organizationId"=$1 and "userId"=$2', [
      org,
      other.id,
    ]);
    expect((await usage()).usage.editors).toBe(1);
    await invitation("outsider@example.com");
  },
);

integration(
  "accepted invitation keeps its reservation before the membership transaction starts",
  async () => {
    await db.query(`update "billingPlan" set "editorLimit"=2 where "id"='free'`);
    const invite = await invitation("member@example.com");
    await db.query('update "invitation" set "status"=\'accepted\' where "id"=$1', [invite.id]);
    await expect(member(third.id, "editor")).rejects.toThrow("allows 2 editor");
    await member(other.id, "editor");
    expect((await usage()).usage.editors).toBe(2);
    expect(
      (await db.query('select "editorReservation" from "invitation" where "id"=$1', [invite.id]))
        .rows[0].editorReservation,
    ).toBe(false);
  },
);

integration(
  "concurrent editor invitations cannot oversubscribe a configurable allowance",
  async () => {
    await db.query(`update "billingPlan" set "editorLimit"=2 where "id"='free'`);
    const outcomes = await Promise.allSettled([
      invitation("member@example.com"),
      invitation("outsider@example.com"),
    ]);
    expect(outcomes.filter((v) => v.status === "fulfilled")).toHaveLength(1);
    expect((await usage()).usage.editors).toBe(2);
  },
);

integration(
  "Better Auth exposes authoritative database quota rejections as public plan errors",
  async () => {
    const context = await auth.$context;
    await expect(
      context.adapter.create({
        model: "member",
        data: {
          organizationId: org,
          userId: other.id,
          role: "editor",
          createdAt: new Date(),
        },
      }),
    ).rejects.toMatchObject({ status: "FORBIDDEN", body: { code: "PLAN_LIMIT" } });
  },
);

integration("expired and canceled invitations release seats", async () => {
  await db.query(`update "billingPlan" set "editorLimit"=2 where "id"='free'`);
  const invite = await invitation("member@example.com");
  await db.query('update "invitation" set "expiresAt"=now()-interval \'1 second\' where "id"=$1', [
    invite.id,
  ]);
  const replacement = await invitation("outsider@example.com");
  await auth.api.cancelInvitation({
    headers: owner.headers,
    body: { invitationId: replacement.id },
  });
  expect((await usage()).usage.editors).toBe(1);
});

integration("Pro covers all editors and files while storage remains bounded", async () => {
  await subscription();
  for (let index = 0; index < 5; index++) await file();
  await member(other.id, "admin");
  await member(third.id, "editor");
  expect((await usage()).limits).toEqual({
    files: null,
    editors: null,
    storageBytes: 10000000000,
    mcpCalls: 100000,
  });
  await object("a".repeat(64), 10000000000);
  await expect(object("b".repeat(64), 1)).rejects.toThrow("storage is full");
});

integration(
  "storage reservations, local blobs, duplicates and thumbnails use the same accounting",
  async () => {
    await db.query(`update "billingPlan" set "storageLimit"=10 where "id"='free'`);
    const body = Buffer.from("1234567890"),
      digest = createHash("sha256").update(body).digest("hex");
    await object(digest, 10);
    await db.query(
      'insert into "designAsset" ("id","organizationId","mimeType","sha256","body","byteSize") values ($1,$2,\'image/png\',$3,$4,10)',
      [randomUUID(), org, digest, body],
    );
    await expect(object("t".repeat(64), 1000, "thumbnail")).rejects.toThrow("storage is full");
    expect((await usage()).usage.storageBytes).toBe(10);
    await expect(object("b".repeat(64), 1)).rejects.toThrow("storage is full");
    await expect(
      db.query(
        'insert into "designAsset" ("id","organizationId","mimeType","sha256","body") values ($1,$2,\'image/png\',$3,$4)',
        [randomUUID(), org, "c".repeat(64), Buffer.from("x")],
      ),
    ).rejects.toThrow("storage is full");
    await db.query(
      'update "designObject" set "usageKind"=\'thumbnail\' where "organizationId"=$1',
      [org],
    );
    expect((await usage()).usage.storageBytes).toBe(10);
  },
);

integration("concurrent uploads reserve only the available storage", async () => {
  await db.query(`update "billingPlan" set "storageLimit"=10 where "id"='free'`);
  const outcomes = await Promise.allSettled([object("a".repeat(64), 6), object("b".repeat(64), 6)]);
  expect(outcomes.filter((v) => v.status === "fulfilled")).toHaveLength(1);
  expect((await usage()).usage.storageBytes).toBe(6);
});

integration(
  "review-only originals still count, shared snapshots deduplicate, and captures are gated",
  async () => {
    await db.query(`update "billingPlan" set "storageLimit"=10 where "id"='free'`);
    const design = await file(),
      review = randomUUID(),
      asset = randomUUID();
    const body = Buffer.from("12345"),
      digest = createHash("sha256").update(body).digest("hex");
    await db.query(
      `insert into "githubConnection" ("organizationId","installationId","account") values ($1,1,'test')`,
      [org],
    );
    await db.query(
      `insert into "githubReview" ("id","fileId","organizationId","installationId","repositoryId","repository","number","title","url","state","branch","baseSha","headSha","linkedSha","revision","frameIds","frameKey","content","createdBy")
    values ($1,$2,$3,1,1,'test/test',1,'Review','https://example.test','open','test','base','head','head',1,'[]','test','{}',$4)`,
      [review, design.id, org, owner.id],
    );
    await db.query(
      `insert into "designAsset" ("id","organizationId","mimeType","sha256","body") values ($1,$2,'image/png',$3,$4)`,
      [asset, org, digest, body],
    );
    // Older snapshots have no SHA field; compute it from their actual bytes.
    await db.query(
      `insert into "githubReviewAsset" ("reviewId","assetId","mimeType","body") values ($1,$2,'image/png',$3)`,
      [review, asset, body],
    );
    expect((await usage()).usage.storageBytes).toBe(5);
    await db.query('delete from "designAsset" where "id"=$1', [asset]);
    expect((await usage()).usage.storageBytes).toBe(5);
    await expect(
      db.query(
        `insert into "githubCapture" ("id","reviewId","frameId","sha","route","width","height","mimeType","sha256","body")
    values ($1,$2,'frame','head','/',1,1,'image/png',$3,$4)`,
        [randomUUID(), review, "b".repeat(64), Buffer.from("123456")],
      ),
    ).rejects.toThrow("storage is full");
  },
);

integration("unrecognized prices and unpaid subscriptions receive Free allowances", async () => {
  for (const status of ["past_due", "unpaid", "incomplete", "paused", "canceled"]) {
    await subscription(status);
    expect((await usage()).tier).toBe("free");
  }
  await subscription("active", "price_wrong");
  expect((await usage()).tier).toBe("free");
  await subscription("trialing");
  expect((await usage()).tier).toBe("pro");
});

integration(
  "downgrade preserves existing files and editing; only further growth is gated",
  async () => {
    await subscription();
    await member(other.id, "editor");
    const first = await file();
    for (let index = 0; index < 3; index++) await file();
    await subscription("canceled");
    await service.renameDesignFileForUser(other.id, first.id, "Still editable");
    await expect(file()).rejects.toThrow("allows 3 files");
    await expect(member(third.id, "editor")).rejects.toThrow("allows 1 editor");
    expect((await usage()).usage.files).toBe(4);
  },
);

integration(
  "a file writer waits for subscription changes and uses the committed allowance",
  async () => {
    await subscription();
    await file();
    await file();
    await file();
    const connection = await db.connect();
    let settled = false;
    try {
      await connection.query("begin");
      await connection.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [org]);
      await connection.query(
        'update "organization_billing" set "stripeStatus"=\'canceled\' where "organizationId"=$1',
        [org],
      );
      const outcome = file().then(
        () => {
          settled = true;
          return null;
        },
        (error: unknown) => {
          settled = true;
          return error;
        },
      );
      await Bun.sleep(20);
      expect(settled).toBe(false);
      await connection.query("commit");
      expect(planLimitMessage(await outcome)).toContain("allows 3 files");
    } finally {
      await connection.query("rollback");
      connection.release();
    }
  },
);

integration(
  "missing deployment configuration fails closed instead of granting unlimited usage",
  async () => {
    const connection = await db.connect();
    try {
      await connection.query("begin");
      await connection.query('delete from "billingDeployment"');
      await expect(
        connection.query(
          `insert into "designFile" ("id","organizationId","name","createdBy") values ($1,$2,'Design',$3)`,
          [randomUUID(), org, owner.id],
        ),
      ).rejects.toThrow("Plan deployment is not configured");
    } finally {
      await connection.query("rollback");
      connection.release();
    }
  },
);

integration(
  "deleting an archived file releases a file slot and enforces authorization",
  async () => {
    const first = await file();
    await file();
    await file();
    await expect(service.deleteArchivedDesignFileForUser(owner.id, first.id)).rejects.toThrow(
      "Archived file not found",
    );
    await member(other.id, "viewer");
    await db.query('update "designFile" set "archivedAt"=now() where "id"=$1', [first.id]);
    await expect(service.deleteArchivedDesignFileForUser(other.id, first.id)).rejects.toThrow(
      "access denied",
    );
    await service.deleteArchivedDesignFileForUser(owner.id, first.id);
    await file();
    expect((await usage()).usage.files).toBe(3);
  },
);

integration("new-file imports are gated and existing-file imports remain available", async () => {
  const first = await file();
  await file();
  await file();
  const pending = await documents.createImport(owner.id, org, "Imported");
  await documents.putImportChunk(owner.id, pending.importId, "1", []);
  await expect(documents.commitImport(owner.id, pending.importId)).rejects.toThrow(
    "allows 3 files",
  );
  const update = await documents.createImport(owner.id, org, "Updated", first.id);
  await documents.putImportChunk(owner.id, update.importId, "1", []);
  await documents.commitImport(owner.id, update.importId);
  expect((await usage()).usage.files).toBe(3);
});

integration(
  "complimentary subscriptions grant, revoke and regrant Pro without losing files",
  async () => {
    const client = billing.stripe();
    const subscriptions = new Map<string, Stripe.Subscription>();
    function state(
      id: string,
      created: number,
      status: Stripe.Subscription.Status,
      accessSource = "tidy-complimentary-pro-v1",
    ) {
      const result = {
        id,
        created,
        status,
        customer: "cus_comp",
        metadata: { organizationId: org, accessSource },
        cancel_at_period_end: false,
        items: {
          data: [
            {
              price: { id: "price_pro" },
              current_period_end: Math.floor(Date.now() / 1000) + 86400,
            },
          ],
        },
      } as unknown as Stripe.Subscription;
      subscriptions.set(id, result);
      return result;
    }
    const previous = state("sub_paid_ended", 1, "canceled", "paid");
    const first = state("sub_comp", 2, "active");
    const retrieve = spyOn(client.subscriptions, "retrieve").mockImplementation(
      async (id) => subscriptions.get(id)! as Stripe.Response<Stripe.Subscription>,
    );
    try {
      await db.query(
        `insert into "organization_billing" ("organizationId","stripeCustomerId","stripeSubscriptionId","stripeStatus","stripePriceId") values ($1,'cus_comp',$2,'canceled','price_pro')`,
        [org, previous.id],
      );
      const event = (id: string, type = "customer.subscription.created") =>
        processBillingEvent({ type, data: { object: { id } } } as Stripe.Event);
      await event(first.id);
      expect((await usage()).tier).toBe("pro");
      await file();
      await file();
      await file();
      await file();
      await event(previous.id, "customer.subscription.deleted");
      expect((await usage()).tier).toBe("pro");
      first.status = "canceled";
      await event(first.id, "customer.subscription.deleted");
      expect((await usage()).tier).toBe("free");
      expect((await usage()).usage.files).toBe(4);
      await expect(file()).rejects.toThrow("allows 3 files");
      const second = state("sub_comp_again", 3, "active");
      await event(second.id);
      expect((await usage()).tier).toBe("pro");
      await file();
      await event(first.id, "customer.subscription.deleted");
      expect((await usage()).tier).toBe("pro");
    } finally {
      retrieve.mockRestore();
    }
  },
);

integration(
  "Checkout cannot create a paid subscription while a complimentary grant's webhook is pending",
  async () => {
    const client = billing.stripe();
    const originalCoupon = env.STRIPE_FIRST_MONTH_COUPON_ID,
      originalWebhook = env.STRIPE_WEBHOOK_SECRET;
    env.STRIPE_FIRST_MONTH_COUPON_ID = "coupon_intro";
    env.STRIPE_WEBHOOK_SECRET = "whsec_disposable";
    const price = spyOn(client.prices, "retrieve").mockResolvedValue({
      active: true,
      currency: "usd",
      unit_amount: 1000,
      product: "prod_pro",
      recurring: { interval: "month", interval_count: 1 },
    } as Stripe.Response<Stripe.Price>);
    const coupon = spyOn(client.coupons, "retrieve").mockResolvedValue({
      valid: true,
      percent_off: 50,
      amount_off: null,
      duration: "once",
    } as Stripe.Response<Stripe.Coupon>);
    const list = spyOn(client.subscriptions, "list").mockImplementation(
      () =>
        (async function* () {
          yield { id: "sub_comp", status: "active" } as Stripe.Subscription;
        })() as unknown as ReturnType<typeof client.subscriptions.list>,
    );
    const checkout = spyOn(client.checkout.sessions, "create");
    try {
      await db.query(
        `insert into "organization_billing" ("organizationId","stripeCustomerId") values ($1,'cus_comp')`,
        [org],
      );
      await expect(billing.checkoutUrl(owner.id, org, "owner@example.com")).rejects.toThrow(
        "existing subscription is processing",
      );
      expect(checkout).not.toHaveBeenCalled();
    } finally {
      price.mockRestore();
      coupon.mockRestore();
      list.mockRestore();
      checkout.mockRestore();
      if (originalCoupon === undefined) delete env.STRIPE_FIRST_MONTH_COUPON_ID;
      else env.STRIPE_FIRST_MONTH_COUPON_ID = originalCoupon;
      if (originalWebhook === undefined) delete env.STRIPE_WEBHOOK_SECRET;
      else env.STRIPE_WEBHOOK_SECRET = originalWebhook;
    }
  },
);

integration("a complimentary subscription cannot replace a current paid subscription", async () => {
  const client = billing.stripe();
  const previous = {
    id: "sub_paid",
    created: 1,
    status: "active",
    customer: "cus_paid",
    metadata: { organizationId: org },
    items: { data: [{ price: { id: "price_pro" } }] },
  } as unknown as Stripe.Subscription;
  const incoming = {
    ...previous,
    id: "sub_comp",
    created: 2,
    metadata: { organizationId: org, accessSource: "tidy-complimentary-pro-v1" },
  } as Stripe.Subscription;
  const retrieve = spyOn(client.subscriptions, "retrieve").mockImplementation(
    async (id) =>
      (id === previous.id ? previous : incoming) as Stripe.Response<Stripe.Subscription>,
  );
  try {
    await db.query(
      `insert into "organization_billing" ("organizationId","stripeCustomerId","stripeSubscriptionId","stripeStatus","stripePriceId") values ($1,'cus_paid','sub_paid','active','price_pro')`,
      [org],
    );
    await processBillingEvent({
      type: "customer.subscription.created",
      data: { object: { id: incoming.id } },
    } as Stripe.Event);
    expect(
      (
        await db.query(
          'select "stripeSubscriptionId" from "organization_billing" where "organizationId"=$1',
          [org],
        )
      ).rows[0].stripeSubscriptionId,
    ).toBe(previous.id);
    expect((await usage()).tier).toBe("pro");
  } finally {
    retrieve.mockRestore();
  }
});

integration(
  "verified subscription synchronization bumps limits and handles cancellation",
  async () => {
    const client = billing.stripe();
    const state = {
      id: "sub_test",
      metadata: { organizationId: org },
      customer: "cus_test",
      status: "active",
      cancel_at_period_end: false,
      items: {
        data: [
          { price: { id: "price_pro" }, current_period_end: Math.floor(Date.now() / 1000) + 86400 },
        ],
      },
    } as unknown as Stripe.Subscription;
    const retrieve = spyOn(client.subscriptions, "retrieve").mockResolvedValue(
      state as Stripe.Response<Stripe.Subscription>,
    );
    try {
      await db.query(
        'insert into "organization_billing" ("organizationId","stripeCustomerId","stripeCheckoutSessionId") values ($1,\'cus_test\',\'cs_test\')',
        [org],
      );
      await processBillingEvent({
        type: "checkout.session.completed",
        data: {
          object: {
            id: "cs_test",
            mode: "subscription",
            subscription: "sub_test",
            customer: "cus_test",
            client_reference_id: org,
          },
        },
      } as Stripe.Event);
      expect((await usage()).tier).toBe("pro");
      expect((await billing.billingStatus(owner.id, org)).firstMonthUsed).toBe(true);
      state.cancel_at_period_end = true;
      await processBillingEvent({
        type: "customer.subscription.updated",
        data: { object: { id: "sub_test" } },
      } as Stripe.Event);
      expect((await usage()).tier).toBe("pro");
      state.status = "canceled";
      await processBillingEvent({
        type: "customer.subscription.deleted",
        data: { object: { id: "sub_test" } },
      } as Stripe.Event);
      expect((await usage()).tier).toBe("free");
    } finally {
      retrieve.mockRestore();
    }
  },
);

integration("self-hosted deployment has no hosted allowances or checkout", async () => {
  await db.query('update "billingDeployment" set "selfHosted"=true');
  for (let index = 0; index < 4; index++) await file();
  await member(other.id, "editor");
  await object("a".repeat(64), 20000000000);
  expect((await usage()).limits).toEqual({
    files: null,
    editors: null,
    storageBytes: null,
    mcpCalls: null,
  });
  expect((await billing.billingStatus(owner.id, org)).ready).toBe(false);
  await expect(billing.checkoutUrl(owner.id, org, "owner@example.com")).rejects.toThrow(
    "Billing is disabled for self-hosted workspaces.",
  );
});

async function mcpCalls(calls: number) {
  await db.query(
    `insert into "organizationMcpUsage" ("organizationId", "periodStart", "calls")
    values ($1, date_trunc('month', current_timestamp at time zone 'UTC')::date, $2)
    on conflict ("organizationId", "periodStart") do update set "calls" = excluded."calls"`,
    [org, calls],
  );
}

integration("the last Free MCP call is atomic across concurrent requests", async () => {
  await mcpCalls(4999);
  const outcomes = await Promise.allSettled(
    Array.from({ length: 4 }, () => consumeMcpCall(owner.id, { organization_id: org })),
  );
  expect(outcomes.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  expect((await usage()).usage.mcpCalls).toBe(5000);
  for (const result of outcomes)
    if (result.status === "rejected") {
      expect(planLimitMessage(result.reason)).toContain("Free allows 5000 MCP calls per month");
      expect(planLimitMessage(result.reason)).toContain("resets on");
    }
});

integration(
  "Pro grants 100k calls, while downgrading preserves usage and blocks more calls",
  async () => {
    await subscription();
    expect((await plans.proPlanLimits()).mcpCalls).toBe(100000);
    await mcpCalls(99999);
    await consumeMcpCall(owner.id, { organizationId: org });
    await expect(consumeMcpCall(owner.id, { organizationId: org })).rejects.toThrow(
      "Pro allows 100000 MCP calls",
    );
    await subscription("canceled");
    expect((await usage()).usage.mcpCalls).toBe(100000);
    await expect(consumeMcpCall(owner.id, { organization_id: org })).rejects.toThrow(
      "Free allows 5000 MCP calls",
    );
    // Increasing the catalog allowance grants capacity without losing usage.
    await db.query(`update "billingPlan" set "mcpCallLimit" = 100001 where "id" = 'pro'`);
    await subscription();
    await consumeMcpCall(owner.id, { organization_id: org });
    expect((await usage()).usage.mcpCalls).toBe(100001);
  },
);

integration(
  "previous-month MCP calls do not reduce this month's allowance, regardless of session timezone",
  async () => {
    await db.query(
      `insert into "organizationMcpUsage" ("organizationId", "periodStart", "calls")
    values ($1, (date_trunc('month', current_timestamp at time zone 'UTC') - interval '1 month')::date, 5000)`,
      [org],
    );
    expect((await usage()).usage.mcpCalls).toBe(0);
    const client = await db.connect();
    try {
      await client.query("begin");
      await client.query("set local time zone 'Pacific/Kiritimati'");
      await client.query('select "consumeOrganizationMcpCall"($1, $2)', [owner.id, org]);
      const plan = (
        await client.query<{ plan: Awaited<ReturnType<typeof usage>> }>(
          'select "organizationPlanUsage"($1) as plan',
          [org],
        )
      ).rows[0].plan;
      expect(plan.usage.mcpCalls).toBe(1);
      expect(plan.mcpResetAt).toBe(
        new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() + 1, 1))
          .toISOString()
          .replace(".000Z", "Z"),
      );
      await client.query("commit");
    } finally {
      await client.query("rollback");
      client.release();
    }
    expect((await usage()).usage.mcpCalls).toBe(1);
  },
);

integration(
  "MCP calls are shared by members; inaccessible targets never consume another workspace's allowance",
  async () => {
    const target = await file();
    await member(other.id, "viewer");
    await consumeMcpCall(owner.id, { file_id: target.id });
    await consumeMcpCall(other.id, { file_id: target.id });
    await consumeMcpCall(owner.id, {});
    await expect(consumeMcpCall(third.id, { file_id: target.id })).rejects.toThrow("access denied");
    await expect(consumeMcpCall(owner.id, { file_id: "missing" })).rejects.toThrow("access denied");
    await expect(
      consumeMcpCall(owner.id, { file_id: target.id, organization_id: "different" }),
    ).rejects.toThrow("access denied");
    await expect(consumeMcpCall(third.id, {})).rejects.toThrow("Join or create a workspace");
    expect((await usage()).usage.mcpCalls).toBe(3);
  },
);

integration(
  "folder and staged-import calls use the target workspace and reject other users' imports",
  async () => {
    const folderId = randomUUID();
    await db.query(
      'insert into "designFolder" ("id", "organizationId", "name", "createdBy") values ($1,$2,\'Folder\',$3)',
      [folderId, org, owner.id],
    );
    await consumeMcpCall(owner.id, { folder_id: folderId });
    const staged = await documents.createImport(owner.id, org, "Import");
    await consumeMcpCall(owner.id, { import_id: staged.importId });
    await member(other.id, "viewer");
    await expect(consumeMcpCall(other.id, { import_id: staged.importId })).rejects.toThrow(
      "access denied",
    );
    expect((await usage()).usage.mcpCalls).toBe(2);
  },
);

integration(
  "self-hosted MCP calls remain unlimited and upgrades keep the current counter",
  async () => {
    await mcpCalls(5000);
    await expect(consumeMcpCall(owner.id, {})).rejects.toThrow("Free allows 5000 MCP calls");
    await subscription();
    await consumeMcpCall(owner.id, {});
    expect((await usage()).usage.mcpCalls).toBe(5001);
    await db.query('update "billingDeployment" set "selfHosted"=true');
    await mcpCalls(100000);
    await consumeMcpCall(owner.id, {});
    expect((await usage()).limits.mcpCalls).toBeNull();
    expect((await usage()).usage.mcpCalls).toBe(100001);
  },
);

integration(
  "thumbnail claims and legacy bytes cannot exceed the allowance under concurrency",
  async () => {
    const created = await file();
    await db.query(`update "billingPlan" set "storageLimit"=10 where "id"='free'`);
    const outcomes = await Promise.allSettled([
      object("d".repeat(64), 6, "thumbnail"),
      object("e".repeat(64), 6, "thumbnail"),
    ]);
    expect(outcomes.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect((await usage()).usage.storageBytes).toBe(6);
    await expect(
      db.query(
        `insert into "designFileThumbnail" ("fileId","version","sha256","byteSize","body") values ($1,'test',$2,5,$3)`,
        [created.id, "f".repeat(64), Buffer.from("12345")],
      ),
    ).rejects.toThrow("storage is full");
    await db.query(
      `insert into "designFileThumbnail" ("fileId","version","sha256","byteSize","body") values ($1,'test',$2,4,$3)`,
      [created.id, "f".repeat(64), Buffer.from("1234")],
    );
    expect((await usage()).usage.storageBytes).toBe(10);
  },
);

integration(
  "concurrent draft admission is bounded per actor and expired drafts release capacity",
  async () => {
    const outcomes = await Promise.allSettled(
      Array.from({ length: 16 }, (_, index) =>
        documents.createImport(owner.id, org, `Draft ${index}`),
      ),
    );
    expect(outcomes.filter((result) => result.status === "fulfilled")).toHaveLength(10);
    expect(
      (
        await db.query(
          'select count(*)::int as count from "designImport" where "organizationId"=$1',
          [org],
        )
      ).rows[0].count,
    ).toBe(10);
    await db.query(
      'update "designImport" set "expiresAt"=now()-interval \'1 second\' where "organizationId"=$1',
      [org],
    );
    await documents.createImport(owner.id, org, "Replacement draft");
    expect(
      (
        await db.query(
          'select count(*)::int as count from "designImport" where "organizationId"=$1',
          [org],
        )
      ).rows[0].count,
    ).toBe(1);
  },
);

integration(
  "staged chunk count, aggregate bytes and retry behavior are bounded atomically",
  async () => {
    const small = await documents.createImport(owner.id, org, "Small chunks");
    await Promise.all(
      Array.from({ length: 32 }, (_, index) =>
        documents.putImportChunk(owner.id, small.importId, `chunk-${index}`, []),
      ),
    );
    await expect(documents.putImportChunk(owner.id, small.importId, "extra", [])).rejects.toThrow(
      "allowance exceeded",
    );
    await expect(
      documents.putImportChunk(owner.id, small.importId, "chunk-0", []),
    ).resolves.toMatchObject({ chunkCount: 32 });
    const large = await documents.createImport(owner.id, org, "Large chunks");
    const outcomes = await Promise.allSettled(
      Array.from({ length: 15 }, (_, index) =>
        documents.putImportChunk(owner.id, large.importId, `chunk-${index}`, [], undefined, [
          "x".repeat(490_000),
        ]),
      ),
    );
    expect(outcomes.filter((result) => result.status === "fulfilled")).toHaveLength(10);
    const row = (
      await db.query(
        'select octet_length("chunks"::text) as bytes from "designImport" where "id"=$1',
        [large.importId],
      )
    ).rows[0];
    expect(row.bytes).toBeLessThanOrEqual(5_000_000);
    await documents.abortImport(owner.id, large.importId);
    expect(
      (await db.query('select "chunks" from "designImport" where "id"=$1', [large.importId]))
        .rows[0].chunks,
    ).toEqual({});
  },
);
