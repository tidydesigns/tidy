import { afterAll, beforeAll, beforeEach, expect, mock, spyOn, test } from "bun:test";
// Tests intentionally substitute deployment variables.
const testEnvironment: Record<string, string | undefined> = process.env;
import { readFile } from "node:fs/promises";
import { createHash, createHmac } from "node:crypto";
import { resolve } from "node:path";
import { db } from "../db";
import { organizationConfirmationHeader } from "./constants";

// Only run destructive fixtures against an explicitly selected disposable database.
const testUrl = testEnvironment.ORGANIZATIONS_TEST_DATABASE_URL;
const enabled = Boolean(
  testUrl &&
  testEnvironment.DATABASE_URL === testUrl &&
  new URL(testUrl).hostname === "127.0.0.1" &&
  new URL(testUrl).pathname === "/tidy_organizations_test",
);
mock.module("server-only", () => ({}));
const integration = enabled ? test : test.skip;
let auth: (typeof import("../auth"))["auth"];
let createOrganizationForUser: (typeof import("./creation"))["createOrganizationForUser"];
let organizationCreationStatus: (typeof import("./creation"))["organizationCreationStatus"];
let migratedCreators: { id: string; createdByUserId: string | null }[];
let migratedDeveloperPermission: boolean;
let owner: Headers, invited: Headers, outsider: Headers;
let ownerId: string, invitedId: string, outsiderId: string, orgId: string, otherId: string;
let deliveries: { to: string[]; subject: string; text: string }[] = [];
let mailStatus = 200;
const originalFetch = globalThis.fetch;
const originalMailKey = testEnvironment.CLOUDFLARE_EMAIL_API_TOKEN;
const originalAccountId = testEnvironment.CLOUDFLARE_ACCOUNT_ID;
const originalSender = testEnvironment.AUTH_EMAIL_FROM;
const originalVaultKey = testEnvironment.VAULT_ENCRYPTION_KEY;
let fetchMock: ReturnType<typeof spyOn<typeof globalThis, "fetch">>;
const orgName = "Design équipe";

async function create(headers: Headers, name: string) {
  const session = (await auth.api.getSession({ headers }))!;
  return createOrganizationForUser(session.user.id, name, session.session.id);
}
async function account(name: string, email: string) {
  const result = await auth.api.signUpEmail({
    body: { name, email, password: "test-only-password-123" },
    returnHeaders: true,
  });
  const verified = await auth.api.verifyEmail({
    query: { token: emailedToken() },
    returnHeaders: true,
  });
  const cookie = verified.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
  return { id: result.response.user.id, headers: new Headers({ cookie }) };
}
function confirmation(headers: Headers, name = orgName) {
  const result = new Headers(headers);
  result.set(organizationConfirmationHeader, encodeURIComponent(name));
  return result;
}

beforeAll(async () => {
  if (!enabled) return;
  testEnvironment.CLOUDFLARE_EMAIL_API_TOKEN = "cloudflare-disposable-test";
  testEnvironment.CLOUDFLARE_ACCOUNT_ID = "test-account";
  testEnvironment.AUTH_EMAIL_FROM = "Bella <accounts@example.test>";
  testEnvironment.VAULT_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
  fetchMock = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        const url = input instanceof Request ? input.url : String(input);
        if (
          url === "https://api.cloudflare.com/client/v4/accounts/test-account/email/sending/send"
        ) {
          const delivery = JSON.parse(String(init?.body));
          deliveries.push(delivery);
          return Response.json(
            mailStatus === 200
              ? {
                  success: true,
                  result: {
                    delivered: delivery.to,
                    queued: [],
                    permanent_bounces: [],
                    suppressed_recipients: [],
                  },
                }
              : { success: false, errors: [{ message: "fake provider rejection" }] },
            { status: mailStatus },
          );
        }
        if (url === "http://localhost:3000/api/auth/jwks") return auth.handler(new Request(url));
        return originalFetch(input, init);
      },
      { preconnect: originalFetch.preconnect },
    ),
  );
  await db.query("drop schema public cascade; create schema public");
  for (const file of [
    "schema.sql",
    "schema-organization.sql",
    "schema-vault.sql",
    "schema-mcp.sql",
    "schema-design-files.sql",
    "schema-design-folders.sql",
    "schema-design-rectangles.sql",
    "schema-design-document.sql",
    "schema-github.sql",
    "schema-design-comments.sql",
    "schema-design-comment-coordinates.sql",
    "schema-design-comment-reactions.sql",
    "20260928-file-multiplayer.sql",
    "20261002-comment-thread-resolution.sql",
    "20261003-editor-change-deltas.sql",
    "20260929-organization-billing.sql",
    "20261003-design-object-storage.sql",
    "20261003-file-thumbnails.sql",
    "20261003-plan-limits.sql",
    "20261006-mcp-call-limits.sql",
    "20261004-organization-creation-limit.sql",
    "20261006-thumbnail-storage-limits.sql",
    "20261006-document-history-bounds.sql",
    "20261007-github-history-limits.sql",
    "20261005-connectors.sql",
    "20261002-feedback-images.sql",
    "20261005-agent-threads.sql",
    "20261007-file-version-history.sql",
  ]) {
    if (file === "20261004-organization-creation-limit.sql") {
      await db.query(`update "billingDeployment" set "selfHosted"=true;
        insert into "user" ("id","name","email","emailVerified") values
        ('legacy-first','First','first@example.test',true),('legacy-second','Second','second@example.test',true),
        ('zqMKiWaydNsof6qrNOZxMVCyfmubFEkt','Developer','bootstrap@example.test',true);
        insert into "organization" ("id","name","slug","createdAt") values
        ('legacy-one','One','legacy-one',now()),('legacy-two','Two','legacy-two',now()),('legacy-ownerless','Ownerless','legacy-ownerless',now());
        insert into "member" ("id","organizationId","userId","role","createdAt") values
        ('legacy-m1','legacy-one','legacy-first','owner','2026-01-01'),('legacy-m2','legacy-one','legacy-second','owner','2026-02-01'),
        ('legacy-m3','legacy-two','legacy-first','owner','2026-01-01');`);
    }
    await db.query(
      await readFile(resolve(import.meta.dir, "../../../..", "migrations", file), "utf8"),
    );
  }
  migratedCreators = (
    await db.query('select "id","createdByUserId" from "organization" order by "id"')
  ).rows;
  migratedDeveloperPermission = (
    await db.query(
      'select "allowMultiple" from "organizationCreationPermission" where "userId"=$1',
      ["zqMKiWaydNsof6qrNOZxMVCyfmubFEkt"],
    )
  ).rows[0].allowMultiple;
  // General account fixtures intentionally exercise the unrestricted self-hosted deployment.
  await db.query('update "billingDeployment" set "selfHosted" = true');
  // Auth checks the schema on initialization, so load it only after fixtures exist.
  ({ createOrganizationForUser, organizationCreationStatus } = await import("./creation"));
  ({ auth } = await import("../auth"));
  const context = await auth.$context;
  if (!context.explicitSchemaCheck)
    throw new Error("The auth adapter must support explicit schema validation.");
  await context.explicitSchemaCheck();
});
beforeEach(async () => {
  if (!enabled) return;
  deliveries = [];
  mailStatus = 200;
  await db.query('update "billingDeployment" set "selfHosted"=true');
  await db.query('truncate "user", "organization" cascade');
  const a = await account("Owner", "owner@example.com");
  owner = a.headers;
  ownerId = a.id;
  const b = await account("Invited", "member@example.com");
  invited = b.headers;
  invitedId = b.id;
  const c = await account("Outsider", "outsider@example.com");
  outsider = c.headers;
  outsiderId = c.id;
  deliveries = [];
  const org = await create(owner, orgName);
  orgId = org!.id;
  const invitation = await auth.api.createInvitation({
    headers: owner,
    body: { email: "member@example.com", role: "member", organizationId: orgId },
  });
  await auth.api.acceptInvitation({ headers: invited, body: { invitationId: invitation.id } });
  await auth.api.setActiveOrganization({ headers: invited, body: { organizationId: orgId } });
  const other = await create(outsider, "Other team");
  otherId = other!.id;
});
afterAll(async () => {
  if (!enabled) return;
  fetchMock.mockRestore();
  if (originalMailKey === undefined) delete testEnvironment.CLOUDFLARE_EMAIL_API_TOKEN;
  else testEnvironment.CLOUDFLARE_EMAIL_API_TOKEN = originalMailKey;
  if (originalAccountId === undefined) delete testEnvironment.CLOUDFLARE_ACCOUNT_ID;
  else testEnvironment.CLOUDFLARE_ACCOUNT_ID = originalAccountId;
  if (originalSender === undefined) delete testEnvironment.AUTH_EMAIL_FROM;
  else testEnvironment.AUTH_EMAIL_FROM = originalSender;
  if (originalVaultKey === undefined) delete testEnvironment.VAULT_ENCRYPTION_KEY;
  else testEnvironment.VAULT_ENCRYPTION_KEY = originalVaultKey;
  await db.end();
});

integration(
  "migration retains legacy organisations, infers their earliest owner and seeds the developer ID",
  () => {
    expect(migratedCreators).toEqual([
      { id: "legacy-one", createdByUserId: "legacy-first" },
      { id: "legacy-ownerless", createdByUserId: null },
      { id: "legacy-two", createdByUserId: "legacy-first" },
    ]);
    expect(migratedDeveloperPermission).toBe(true);
  },
);

integration(
  "an invited member can create an org, own it, and switch back to the invited org",
  async () => {
    const created = await create(invited, "My team");
    expect((await auth.api.getSession({ headers: invited }))?.session.activeOrganizationId).toBe(
      created!.id,
    );
    expect(
      (
        await auth.api.getActiveMemberRole({
          headers: invited,
          query: { organizationId: created!.id },
        })
      ).role,
    ).toBe("owner");
    expect(
      (await auth.api.listOrganizations({ headers: invited })).map(({ id }) => id).sort(),
    ).toEqual([created!.id, orgId].sort());
    await auth.api.setActiveOrganization({ headers: invited, body: { organizationId: orgId } });
    expect((await auth.api.getSession({ headers: invited }))?.session.activeOrganizationId).toBe(
      orgId,
    );
  },
);

integration(
  "hosted users can create once regardless of invitations, ownership or Pro",
  async () => {
    await (
      await import("./membership")
    ).transferOwnership(ownerId, orgId, await memberId(invitedId));
    await db.query('update "billingDeployment" set "selfHosted"=false');
    expect(await organizationCreationStatus(invitedId)).toMatchObject({
      ready: true,
      canCreateOrganization: true,
    });
    const created = await create(invited, "My own organisation");
    expect(await organizationCreationStatus(invitedId)).toMatchObject({
      canCreateOrganization: false,
    });
    await db.query(`insert into "billingPlanPrice" values ('price_pro') on conflict do nothing`);
    await db.query(
      `insert into "organization_billing" ("organizationId","stripeStatus","stripePriceId") values ($1,'active','price_pro')`,
      [created.id],
    );
    await expect(create(invited, "Second organisation")).rejects.toThrow(
      "You can create one organization",
    );
    expect(
      (await auth.api.listOrganizations({ headers: invited })).map((o) => o.id).sort(),
    ).toEqual([orgId, created.id].sort());
    expect(
      (await db.query('select "createdByUserId" from "organization" where "id"=$1', [created.id]))
        .rows[0].createdByUserId,
    ).toBe(invitedId);
  },
);

integration(
  "concurrent first-organisation requests commit exactly one complete organisation",
  async () => {
    await db.query('update "billingDeployment" set "selfHosted"=false');
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, (_, i) => create(invited, `Attempt ${i}`)),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    for (const result of results)
      if (result.status === "rejected")
        expect(result.reason.message).toContain("You can create one organization");
    const created = (
      await db.query('select "id" from "organization" where "createdByUserId"=$1', [invitedId])
    ).rows;
    expect(created).toHaveLength(1);
    expect(
      (await db.query('select "role" from "member" where "organizationId"=$1', [created[0].id]))
        .rows,
    ).toEqual([{ role: "owner" }]);
  },
);

integration("failed creation rolls back its organisation, membership and allowance", async () => {
  await db.query('update "billingDeployment" set "selfHosted"=false');
  await expect(
    createOrganizationForUser(invitedId, "Rolled back", "missing-session"),
  ).rejects.toThrow("Your session has ended");
  expect(
    (await db.query('select "id" from "organization" where "createdByUserId"=$1', [invitedId]))
      .rowCount,
  ).toBe(0);
  expect(await organizationCreationStatus(invitedId)).toMatchObject({
    canCreateOrganization: true,
  });
  await create(invited, "Retry");
});

integration(
  "the creation action uses the authenticated actor and rejects anonymous or forged input",
  async () => {
    await db.query('update "billingDeployment" set "selfHosted"=false');
    const nextHeaders = await import("next/headers");
    const requestHeaders = spyOn(nextHeaders, "headers").mockResolvedValue(invited);
    try {
      const { createOrganization } = await import("../../app/onboarding/organization/actions");
      const forged = await createOrganization({
        name: "Forged",
        userId: ownerId,
        allowMultiple: true,
      } as unknown as string);
      expect(forged.data).toBeNull();
      const result = await createOrganization("Action organisation");
      expect(result.error).toBeNull();
      expect(
        (
          await db.query('select "createdByUserId" from "organization" where "id"=$1', [
            result.data!.id,
          ])
        ).rows[0].createdByUserId,
      ).toBe(invitedId);
      expect((await createOrganization("Second")).error?.message).toContain(
        "You can create one organization",
      );
      requestHeaders.mockResolvedValue(new Headers());
      expect((await createOrganization("Anonymous")).error?.message).toBe(
        "Sign in to create an organization.",
      );
    } finally {
      requestHeaders.mockRestore();
    }
  },
);

integration(
  "developer permission is operator-owned and independent of email or profile changes",
  async () => {
    await db.query('update "billingDeployment" set "selfHosted"=false');
    await db.query(
      'insert into "organizationCreationPermission" ("userId","allowMultiple") values ($1,true)',
      [invitedId],
    );
    await create(invited, "Developer one");
    await create(invited, "Developer two");
    await db.query('update "user" set "email"=$1 where "id"=$2', [
      "changed@example.test",
      invitedId,
    ]);
    expect(await organizationCreationStatus(invitedId)).toMatchObject({
      canCreateOrganization: true,
    });
    expect(await organizationCreationStatus(ownerId)).toMatchObject({
      canCreateOrganization: false,
    });
    await db.query(
      'update "organizationCreationPermission" set "allowMultiple"=false where "userId"=$1',
      [invitedId],
    );
    await expect(createOrganizationForUser(invitedId, "Denied")).rejects.toThrow(
      "You can create one organization",
    );
    expect(
      (
        await db.query(
          'select count(*)::int as count from "organization" where "createdByUserId"=$1',
          [invitedId],
        )
      ).rows[0].count,
    ).toBe(2);
  },
);

integration(
  "the workspace menu hides additional creation while keeping switching, and permits developers",
  async () => {
    await db.query('update "billingDeployment" set "selfHosted"=false');
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { WorkspaceShell } = await import("../../components/workspace/workspace-shell");
    const render = async () =>
      renderToStaticMarkup(
        await WorkspaceShell({
          organizationId: orgId,
          owner: true,
          organizations: [{ id: orgId, name: orgName }],
          user: { id: ownerId, name: "Owner" },
          children: "Files",
        }),
      );
    const restricted = await render();
    expect(restricted).not.toContain('aria-label="Create organization"');
    expect(restricted).toContain("Switch organization");
    await db.query(
      'insert into "organizationCreationPermission" ("userId","allowMultiple") values ($1,true)',
      [ownerId],
    );
    expect(await render()).toContain('aria-label="Create organization"');
  },
);

integration(
  "onboarding redirects existing creators but doesn't loop after a creator leaves",
  async () => {
    await db.query('update "billingDeployment" set "selfHosted"=false');
    const nextHeaders = await import("next/headers");
    const requestHeaders = spyOn(nextHeaders, "headers").mockResolvedValue(owner);
    try {
      const { default: OrganizationPage } = await import("../../app/onboarding/organization/page");
      await expect(OrganizationPage()).rejects.toThrow("NEXT_REDIRECT");
      await db.query('update "billingDeployment" set "selfHosted"=true');
      const membership = await import("./membership");
      await membership.transferOwnership(ownerId, orgId, await memberId(invitedId));
      await membership.leaveOrganization(ownerId, orgId);
      await db.query('update "billingDeployment" set "selfHosted"=false');
      const { renderToStaticMarkup } = await import("react-dom/server");
      expect(renderToStaticMarkup(await OrganizationPage())).toContain(
        "You already created an organisation.",
      );
    } finally {
      requestHeaders.mockRestore();
    }
  },
);

integration("confirmed deletion frees the created-organisation allowance", async () => {
  await db.query('update "billingDeployment" set "selfHosted"=false');
  const created = await create(invited, "Temporary");
  await auth.api.deleteOrganization({
    headers: confirmation(invited, "Temporary"),
    body: { organizationId: created.id },
  });
  expect(await organizationCreationStatus(invitedId)).toMatchObject({
    canCreateOrganization: true,
  });
  await create(invited, "Replacement");
});

integration(
  "creation cannot bypass its limit through Better Auth, null attribution or creator reassignment",
  async () => {
    await db.query('update "billingDeployment" set "selfHosted"=false');
    await expect(
      auth.api.createOrganization({ headers: invited, body: { name: "Legacy", slug: "legacy" } }),
    ).rejects.toMatchObject({ status: "FORBIDDEN" });
    const requestHeaders = new Headers(invited);
    requestHeaders.set("Content-Type", "application/json");
    requestHeaders.set("Origin", "http://localhost:3000");
    const response = await auth.handler(
      new Request("http://localhost:3000/api/auth/organization/create", {
        method: "POST",
        headers: requestHeaders,
        body: JSON.stringify({
          name: "Spoofed",
          slug: "spoofed",
          userId: ownerId,
          createdByUserId: ownerId,
          metadata: { allowMultiple: true },
        }),
      }),
    );
    expect(response.status).toBe(403);
    await expect(
      db.query(
        `insert into "organization" ("id","name","slug","createdAt") values ('missing-creator','Missing','missing-creator',now())`,
      ),
    ).rejects.toThrow("creator is required");
    await expect(
      db.query('update "organization" set "createdByUserId"=null where "id"=$1', [orgId]),
    ).rejects.toThrow("creator cannot be changed");
    await expect(
      db.query('update "organization" set "createdByUserId"=$1 where "id"=$2', [invitedId, orgId]),
    ).rejects.toThrow("creator cannot be changed");
    await create(invited, "Legitimate");
  },
);

integration(
  "a direct multi-row insert cannot multiply the created-organisation allowance",
  async () => {
    await db.query('update "billingDeployment" set "selfHosted"=false');
    await expect(
      db.query(
        `insert into "organization" ("id","name","slug","createdAt","createdByUserId")
    values ('multi-1','One','multi-1',now(),$1),('multi-2','Two','multi-2',now(),$1)`,
        [invitedId],
      ),
    ).rejects.toThrow("You can create one organization");
    expect(
      (await db.query('select "id" from "organization" where "createdByUserId"=$1', [invitedId]))
        .rowCount,
    ).toBe(0);
  },
);

integration("self-hosted users can create multiple organisations", async () => {
  await create(invited, "First");
  await create(invited, "Second");
  expect(await organizationCreationStatus(invitedId)).toMatchObject({
    canCreateOrganization: true,
  });
});

integration(
  "transferring ownership and leaving doesn't release the original creator's allowance",
  async () => {
    const membership = await import("./membership");
    await membership.transferOwnership(ownerId, orgId, await memberId(invitedId));
    await membership.leaveOrganization(ownerId, orgId);
    await db.query('update "billingDeployment" set "selfHosted"=false');
    expect(await organizationCreationStatus(ownerId)).toMatchObject({
      canCreateOrganization: false,
    });
    expect(await organizationCreationStatus(invitedId)).toMatchObject({
      canCreateOrganization: true,
    });
    await expect(createOrganizationForUser(ownerId, "Bypass")).rejects.toThrow(
      "You can create one organization",
    );
  },
);

integration(
  "deleting a creator account preserves its organisation and clears attribution",
  async () => {
    await db.query('delete from "user" where "id"=$1', [ownerId]);
    expect(
      (await db.query('select "createdByUserId" from "organization" where "id"=$1', [orgId])).rows,
    ).toEqual([{ createdByUserId: null }]);
  },
);

integration("switching rejects organizations the user does not belong to", async () => {
  await expect(
    auth.api.setActiveOrganization({ headers: invited, body: { organizationId: otherId } }),
  ).rejects.toBeDefined();
  expect((await auth.api.getSession({ headers: invited }))?.session.activeOrganizationId).not.toBe(
    otherId,
  );
  expect((await auth.api.listOrganizations({ headers: invited })).map(({ id }) => id)).toEqual([
    orgId,
  ]);
});

integration(
  "owners can rename an organization without changing its identity or active session",
  async () => {
    const before = await auth.api.getFullOrganization({
      headers: owner,
      query: { organizationId: orgId },
    });
    await auth.api.updateOrganization({
      headers: owner,
      body: { organizationId: orgId, data: { name: "  Renamed équipe  " } },
    });
    const renamed = await auth.api.getFullOrganization({
      headers: owner,
      query: { organizationId: orgId },
    });
    expect(renamed).toMatchObject({ id: orgId, name: "Renamed équipe", slug: before!.slug });
    expect((await auth.api.getSession({ headers: owner }))?.session.activeOrganizationId).toBe(
      orgId,
    );
    expect(
      (await auth.api.listOrganizations({ headers: invited })).find(({ id }) => id === orgId)?.name,
    ).toBe("Renamed équipe");
  },
);

integration("members and outsiders cannot rename an organization, while admins can", async () => {
  for (const headers of [invited, outsider]) {
    await expect(
      auth.api.updateOrganization({
        headers,
        body: { organizationId: orgId, data: { name: "Denied" } },
      }),
    ).rejects.toBeDefined();
  }
  expect(
    (await auth.api.listOrganizations({ headers: owner })).find(({ id }) => id === orgId)?.name,
  ).toBe(orgName);
  const member = (
    await db.query<{ id: string }>(
      'select "id" from "member" where "organizationId" = $1 and "userId" = $2',
      [orgId, invitedId],
    )
  ).rows[0];
  await (await import("./membership")).changeMemberRole(ownerId, orgId, member.id, "admin");
  await auth.api.updateOrganization({
    headers: invited,
    body: { organizationId: orgId, data: { name: "Admin rename" } },
  });
  expect(
    (await auth.api.listOrganizations({ headers: owner })).find(({ id }) => id === orgId)?.name,
  ).toBe("Admin rename");
});

integration(
  "invalid organization names are rejected without changing the organization",
  async () => {
    const requestHeaders = new Headers(owner);
    requestHeaders.set("Content-Type", "application/json");
    requestHeaders.set("Origin", "http://localhost:3000");
    for (const name of ["", "   ", "x".repeat(101), "Name\u0000", "Name\nTeam"]) {
      const response = await auth.handler(
        new Request("http://localhost:3000/api/auth/organization/update", {
          method: "POST",
          headers: requestHeaders,
          body: JSON.stringify({ organizationId: orgId, data: { name } }),
        }),
      );
      expect(response.status).toBe(400);
      expect(
        (await auth.api.listOrganizations({ headers: owner })).find(({ id }) => id === orgId)?.name,
      ).toBe(orgName);
    }
  },
);

integration(
  "deletion rejects missing, incorrect and malformed names before changing the active org",
  async () => {
    for (const value of [null, "design équipe", "Design équipe ", "%broken"]) {
      const headers = new Headers(owner);
      if (value !== null)
        headers.set(
          organizationConfirmationHeader,
          value === "%broken" ? value : encodeURIComponent(value),
        );
      await expect(
        auth.api.deleteOrganization({ headers, body: { organizationId: orgId } }),
      ).rejects.toMatchObject({ status: "BAD_REQUEST" });
      expect((await auth.api.getSession({ headers: owner }))?.session.activeOrganizationId).toBe(
        orgId,
      );
      expect((await auth.api.listOrganizations({ headers: owner })).map(({ id }) => id)).toContain(
        orgId,
      );
    }
  },
);

integration(
  "members, admins and outsiders cannot delete an org even with its exact name",
  async () => {
    for (const role of ["member", "admin"]) {
      await db.query(
        'update "member" set "role" = $1 where "userId" = $2 and "organizationId" = $3',
        [role, invitedId, orgId],
      );
      await expect(
        auth.api.deleteOrganization({
          headers: confirmation(invited),
          body: { organizationId: orgId },
        }),
      ).rejects.toMatchObject({ status: "FORBIDDEN" });
    }
    await expect(
      auth.api.deleteOrganization({
        headers: confirmation(outsider),
        body: { organizationId: orgId },
      }),
    ).rejects.toBeDefined();
    expect((await auth.api.listOrganizations({ headers: owner })).map(({ id }) => id)).toContain(
      orgId,
    );
  },
);

integration(
  "confirmed owner deletion cascades org data, clears all active sessions and preserves other orgs and accounts",
  async () => {
    await db.query(
      'insert into "member" ("id", "organizationId", "userId", "role", "createdAt") values (\'second-membership\', $1, $2, \'member\', now())',
      [otherId, ownerId],
    );
    await db.query(
      'insert into "designFolder" ("id", "organizationId", "name", "createdBy") values (\'folder\', $1, \'Folder\', $2)',
      [orgId, ownerId],
    );
    await db.query(
      'insert into "designFile" ("id", "organizationId", "name", "createdBy", "folderId") values (\'file\', $1, \'File\', $2, \'folder\')',
      [orgId, ownerId],
    );
    await db.query(
      'insert into "designAsset" ("id", "organizationId", "mimeType", "sha256", "body") values (\'asset\', $1, \'image/png\', \'fixture\', $2)',
      [orgId, Buffer.from("fixture")],
    );
    await db.query(
      'insert into "githubConnection" ("organizationId", "installationId", "account") values ($1, 123, \'test\')',
      [orgId],
    );
    await auth.api.deleteOrganization({
      headers: confirmation(owner),
      body: { organizationId: orgId },
    });
    for (const table of [
      "designFolder",
      "designFile",
      "designAsset",
      "githubConnection",
      "member",
      "invitation",
    ]) {
      expect(
        (await db.query(`select 1 from "${table}" where "organizationId" = $1`, [orgId])).rowCount,
      ).toBe(0);
    }
    expect(
      (await db.query('select 1 from "session" where "activeOrganizationId" = $1', [orgId]))
        .rowCount,
    ).toBe(0);
    expect(
      (await auth.api.getSession({ headers: invited }))?.session.activeOrganizationId,
    ).toBeNull();
    expect(await auth.api.listOrganizations({ headers: invited })).toEqual([]);
    expect((await auth.api.listOrganizations({ headers: owner })).map(({ id }) => id)).toEqual([
      otherId,
    ]);
    await auth.api.setActiveOrganization({ headers: owner, body: { organizationId: otherId } });
    expect((await auth.api.getSession({ headers: owner }))?.session.activeOrganizationId).toBe(
      otherId,
    );
    expect(
      (
        await db.query('select "id" from "user" where "id" = any($1::text[])', [
          [ownerId, invitedId, outsiderId],
        ])
      ).rowCount,
    ).toBe(3);
    const replacement = await create(invited, "Replacement");
    expect((await auth.api.getSession({ headers: invited }))?.session.activeOrganizationId).toBe(
      replacement!.id,
    );
  },
);

async function memberId(userId: string, organizationId = orgId) {
  return (
    await db.query<{ id: string }>(
      'select "id" from "member" where "userId" = $1 and "organizationId" = $2',
      [userId, organizationId],
    )
  ).rows[0].id;
}

integration("member management scopes targets and protects ownership", async () => {
  const { changeMemberRole, removeMember } = await import("./membership");
  const target = await memberId(invitedId),
    ownerMember = await memberId(ownerId);
  await expect(changeMemberRole(invitedId, orgId, ownerMember, "admin")).rejects.toThrow(
    "Only owners and admins",
  );
  await expect(removeMember(outsiderId, orgId, target)).rejects.toThrow("no longer belong");
  await expect(
    changeMemberRole(ownerId, orgId, await memberId(outsiderId, otherId), "admin"),
  ).rejects.toThrow("not found");
  await expect(changeMemberRole(ownerId, orgId, ownerMember, "admin")).rejects.toThrow(
    "last owner",
  );
  await changeMemberRole(ownerId, orgId, target, "admin");
  expect(
    (await auth.api.getActiveMemberRole({ headers: invited, query: { organizationId: orgId } }))
      .role,
  ).toBe("admin");
  await expect(removeMember(invitedId, orgId, ownerMember)).rejects.toThrow("Only owners");
  await removeMember(ownerId, orgId, target);
  expect(await auth.api.listOrganizations({ headers: invited })).toEqual([]);
  expect(
    (await auth.api.getSession({ headers: invited }))?.session.activeOrganizationId,
  ).toBeNull();
  expect((await auth.api.listOrganizations({ headers: outsider }))[0].id).toBe(otherId);
});

integration("ownership handoff is atomic and a former owner can leave", async () => {
  const { transferOwnership, leaveOrganization } = await import("./membership");
  await expect(leaveOrganization(ownerId, orgId)).rejects.toThrow("last owner");
  await expect(transferOwnership(invitedId, orgId, await memberId(ownerId))).rejects.toThrow(
    "Only owners",
  );
  await expect(
    transferOwnership(ownerId, orgId, await memberId(outsiderId, otherId)),
  ).rejects.toThrow("another member");
  await transferOwnership(ownerId, orgId, await memberId(invitedId));
  expect(
    (await auth.api.getActiveMemberRole({ headers: owner, query: { organizationId: orgId } })).role,
  ).toBe("admin");
  expect(
    (await auth.api.getActiveMemberRole({ headers: invited, query: { organizationId: orgId } }))
      .role,
  ).toBe("owner");
  await leaveOrganization(ownerId, orgId);
  expect(await auth.api.listOrganizations({ headers: owner })).toEqual([]);
});

integration(
  "concurrent owner departures cannot leave an organization without an owner",
  async () => {
    const { leaveOrganization } = await import("./membership");
    await db.query('update "member" set "role" = $1 where "id" = $2', [
      "owner",
      await memberId(invitedId),
    ]);
    const results = await Promise.allSettled([
      leaveOrganization(ownerId, orgId),
      leaveOrganization(invitedId, orgId),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(
      (
        await db.query(
          'select 1 from "member" where "organizationId" = $1 and "role" = \'owner\'',
          [orgId],
        )
      ).rowCount,
    ).toBe(1);
  },
);

integration(
  "cancelled invitations cannot be accepted and outsiders cannot cancel them",
  async () => {
    const invitation = await auth.api.createInvitation({
      headers: owner,
      body: { email: "outsider@example.com", role: "member", organizationId: orgId },
    });
    await expect(
      auth.api.cancelInvitation({ headers: outsider, body: { invitationId: invitation.id } }),
    ).rejects.toBeDefined();
    await auth.api.cancelInvitation({ headers: owner, body: { invitationId: invitation.id } });
    await expect(
      auth.api.acceptInvitation({ headers: outsider, body: { invitationId: invitation.id } }),
    ).rejects.toBeDefined();
    expect(
      (
        await db.query('select 1 from "member" where "organizationId" = $1 and "userId" = $2', [
          orgId,
          outsiderId,
        ])
      ).rowCount,
    ).toBe(0);
  },
);

integration("profile names are normalized and invalid updates are rejected", async () => {
  await auth.api.updateUser({ headers: owner, body: { name: "  New Name  " } });
  expect((await auth.api.getSession({ headers: owner }))?.user.name).toBe("New Name");
  for (const name of ["", " ", "x".repeat(101), "New\nName"])
    await expect(auth.api.updateUser({ headers: owner, body: { name } })).rejects.toBeDefined();
  expect((await auth.api.getSession({ headers: owner }))?.user.name).toBe("New Name");
});

function emailedToken(index = deliveries.length - 1) {
  const match = deliveries[index].text.match(/http:\/\/localhost:3000\/\S+/);
  if (!match) throw new Error("Expected an auth email link.");
  const url = new URL(match[0]);
  return url.searchParams.get("token") ?? url.pathname.split("/").at(-1)!;
}

integration("email changes accept any address after old and new inbox verification", async () => {
  const newEmail = "new-designer@example.test";
  await auth.api.changeEmail({ headers: owner, body: { newEmail } });
  expect(deliveries.at(-1)?.to).toEqual(["owner@example.com"]);
  await auth.api.verifyEmail({ headers: owner, query: { token: emailedToken() } });
  expect(deliveries.at(-1)?.to).toEqual([newEmail]);
  expect((await auth.api.getSession({ headers: owner }))?.user.email).toBe("owner@example.com");
  await auth.api.verifyEmail({ headers: owner, query: { token: emailedToken() } });
  expect((await auth.api.getSession({ headers: owner }))?.user).toMatchObject({
    email: newEmail,
    emailVerified: true,
  });
  expect(
    (await auth.api.signInEmail({ body: { email: newEmail, password: "test-only-password-123" } }))
      .user.id,
  ).toBe(ownerId);
});

integration(
  "invitations accept new email addresses once the recipient verifies their account",
  async () => {
    const email = "invited-designer@example.test";
    const invitation = await auth.api.createInvitation({
      headers: owner,
      body: { email, role: "viewer", organizationId: orgId },
    });
    const recipient = await account("New designer", email);
    await auth.api.acceptInvitation({
      headers: recipient.headers,
      body: { invitationId: invitation.id },
    });
    expect(
      (
        await auth.api.getActiveMemberRole({
          headers: recipient.headers,
          query: { organizationId: orgId },
        })
      ).role,
    ).toBe("viewer");
  },
);

integration(
  "verified accounts must confirm in the old inbox before verifying the new inbox",
  async () => {
    await auth.api.changeEmail({ headers: owner, body: { newEmail: "changed-owner@example.com" } });
    expect(deliveries.at(-1)?.to).toEqual(["owner@example.com"]);
    await auth.api.verifyEmail({ headers: owner, query: { token: emailedToken() } });
    expect(deliveries.at(-1)?.to).toEqual(["changed-owner@example.com"]);
    expect((await auth.api.getSession({ headers: owner }))?.user.email).toBe("owner@example.com");
    await auth.api.verifyEmail({ headers: owner, query: { token: emailedToken() } });
    expect((await auth.api.getSession({ headers: owner }))?.user.email).toBe(
      "changed-owner@example.com",
    );
  },
);

integration(
  "password changes validate the old password and support signin with the new one",
  async () => {
    await expect(
      auth.api.changePassword({
        headers: owner,
        body: { currentPassword: "wrong", newPassword: "new-password-for-tests" },
      }),
    ).rejects.toBeDefined();
    await auth.api.changePassword({
      headers: owner,
      body: { currentPassword: "test-only-password-123", newPassword: "new-password-for-tests" },
    });
    await expect(
      auth.api.signInEmail({
        body: { email: "owner@example.com", password: "test-only-password-123" },
      }),
    ).rejects.toBeDefined();
    expect(
      (
        await auth.api.signInEmail({
          body: { email: "owner@example.com", password: "new-password-for-tests" },
        })
      ).user.id,
    ).toBe(ownerId);
  },
);

integration("reset links are single use, expire, and revoke account sessions", async () => {
  const unknown = await auth.api.requestPasswordReset({
    body: { email: "unknown@example.test", redirectTo: "/reset-password" },
  });
  expect(deliveries).toHaveLength(0);
  const known = await auth.api.requestPasswordReset({
    body: { email: "owner@example.com", redirectTo: "/reset-password" },
  });
  expect(known).toEqual(unknown);
  const token = emailedToken();
  await expect(
    auth.api.resetPassword({ body: { token, newPassword: "short" } }),
  ).rejects.toBeDefined();
  await auth.api.resetPassword({ body: { token, newPassword: "recovered-test-password" } });
  expect(await auth.api.getSession({ headers: owner })).toBeNull();
  await expect(
    auth.api.resetPassword({ body: { token, newPassword: "another-test-password" } }),
  ).rejects.toBeDefined();
  await expect(
    auth.api.signInEmail({
      body: { email: "owner@example.com", password: "test-only-password-123" },
    }),
  ).rejects.toBeDefined();
  expect(
    (
      await auth.api.signInEmail({
        body: { email: "owner@example.com", password: "recovered-test-password" },
      })
    ).user.id,
  ).toBe(ownerId);
  await auth.api.requestPasswordReset({
    body: { email: "owner@example.com", redirectTo: "/reset-password" },
  });
  const expired = emailedToken();
  await db.query(
    'update "verification" set "expiresAt" = now() - interval \'1 minute\' where "identifier" = $1',
    [`reset-password:${expired}`],
  );
  await expect(
    auth.api.resetPassword({ body: { token: expired, newPassword: "expired-test-password" } }),
  ).rejects.toBeDefined();
});

integration("failed mail delivery does not pretend a verification completed", async () => {
  mailStatus = 422;
  await expect(
    auth.api.changeEmail({ headers: owner, body: { newEmail: "cancelled-change@example.com" } }),
  ).rejects.toThrow("Could not send");
  expect((await auth.api.getSession({ headers: owner }))?.user).toMatchObject({
    email: "owner@example.com",
    emailVerified: true,
  });
});

integration(
  "session revocation is scoped to the account and preserves its current session",
  async () => {
    const { revokeOtherAccountSession } = await import("../account/sessions");
    const current = (await auth.api.getSession({ headers: owner }))!.session;
    const foreign = (await auth.api.getSession({ headers: invited }))!.session;
    const second = await auth.api.signInEmail({
      body: { email: "owner@example.com", password: "test-only-password-123" },
      returnHeaders: true,
    });
    const secondHeaders = new Headers({
      cookie: second.headers
        .getSetCookie()
        .map((value) => value.split(";")[0])
        .join("; "),
    });
    const secondSession = (await auth.api.getSession({ headers: secondHeaders }))!.session;
    await expect(revokeOtherAccountSession(ownerId, current.id, foreign.id, owner)).rejects.toThrow(
      "not found",
    );
    await expect(revokeOtherAccountSession(ownerId, current.id, current.id, owner)).rejects.toThrow(
      "Sign out",
    );
    await revokeOtherAccountSession(ownerId, current.id, secondSession.id, owner);
    expect(await auth.api.getSession({ headers: secondHeaders })).toBeNull();
    expect((await auth.api.getSession({ headers: owner }))?.user.id).toBe(ownerId);
    expect((await auth.api.getSession({ headers: invited }))?.user.id).toBe(invitedId);
  },
);

integration("Vault updates preserve untouched credentials and isolate accounts", async () => {
  const { createVaultLogin, updateVaultLogin, deleteVaultLogin } = await import("../vault/logins");
  const { decryptVaultLogin } = await import("../vault/server");
  const login = await createVaultLogin(ownerId, " Mail ", "first-user", "first-password");
  expect(Object.keys(login).sort()).toEqual(["id", "name"]);
  await expect(updateVaultLogin(invitedId, login.id, { name: "Stolen" })).rejects.toThrow(
    "not found",
  );
  await expect(deleteVaultLogin(invitedId, login.id)).rejects.toThrow("not found");
  await Promise.all([
    updateVaultLogin(ownerId, login.id, { username: "new-user" }),
    updateVaultLogin(ownerId, login.id, { password: "new-password" }),
  ]);
  expect(await updateVaultLogin(ownerId, login.id, { name: "Renamed" })).toEqual({
    id: login.id,
    name: "Renamed",
  });
  const encrypted = (
    await db.query<import("../vault/crypto").EncryptedVaultCredentials & { keyVersion: number }>(
      'select * from "vaultLogin" where "id" = $1',
      [login.id],
    )
  ).rows[0];
  expect(decryptVaultLogin(encrypted, ownerId, login.id)).toEqual({
    username: "new-user",
    password: "new-password",
  });
  expect(JSON.stringify(encrypted)).not.toContain("new-password");
  await expect(updateVaultLogin(ownerId, login.id, { password: "" })).rejects.toThrow(
    "Enter a password",
  );
  await deleteVaultLogin(ownerId, login.id);
  expect((await db.query('select 1 from "vaultLogin" where "id" = $1', [login.id])).rowCount).toBe(
    0,
  );
});

const mcpResource = "http://localhost:3000/api/mcp";
integration("MCP OAuth discovery and dynamic registration work for remote clients", async () => {
  const { GET: getProtectedMetadata } =
    await import("../../app/.well-known/oauth-protected-resource/api/mcp/route");
  const protectedMetadata = await getProtectedMetadata(
    new Request("http://localhost:3000/.well-known/oauth-protected-resource/api/mcp"),
  );
  expect(protectedMetadata.status).toBe(200);
  const protectedBody = (await protectedMetadata.json()) as {
    resource: string;
    authorization_servers: string[];
  };
  expect(protectedBody.resource).toBe(mcpResource);
  expect(protectedBody.authorization_servers).toContain("http://localhost:3000/api/auth");

  const { GET: getServerMetadata } =
    await import("../../app/.well-known/oauth-authorization-server/api/auth/route");
  const serverMetadata = await getServerMetadata(
    new Request("http://localhost:3000/.well-known/oauth-authorization-server/api/auth"),
  );
  expect(serverMetadata.status).toBe(200);
  const serverBody = (await serverMetadata.json()) as {
    issuer: string;
    registration_endpoint: string;
    authorization_endpoint: string;
    token_endpoint: string;
  };
  expect(serverBody.issuer).toBe("http://localhost:3000/api/auth");
  expect(serverBody.authorization_endpoint).toBe("http://localhost:3000/api/auth/oauth2/authorize");
  expect(serverBody.token_endpoint).toBe("http://localhost:3000/api/auth/oauth2/token");

  const registered = await auth.handler(
    new Request(serverBody.registration_endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: "Generic MCP client",
        redirect_uris: ["http://127.0.0.1:4319/callback"],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        scope: "mcp:read mcp:write offline_access",
      }),
    }),
  );
  if (registered.status !== 201)
    throw new Error(`Dynamic registration failed: ${registered.status} ${await registered.text()}`);
  const client = (await registered.json()) as { client_id: string; application_type: string };
  expect(client.client_id).toBeTruthy();
  expect(client.application_type).toBe("native");

  const invalid = await auth.handler(
    new Request(serverBody.registration_endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        redirect_uris: ["http://example.com/callback"],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code"],
        response_types: ["code"],
      }),
    }),
  );
  expect(invalid.status).toBe(400);
});
async function consent(clientId: string, userId: string, scopes = ["mcp:read", "mcp:write"]) {
  await db.query(
    `insert into "oauthConsent" ("id", "clientId", "userId", "resources", "scopes", "createdAt", "updatedAt")
    values ($1, $2, $3, $4, $5, now(), now())`,
    [crypto.randomUUID(), clientId, userId, JSON.stringify([mcpResource]), JSON.stringify(scopes)],
  );
}
async function oauthClient(clientId: string) {
  await db.query(
    `insert into "oauthClient" ("id", "clientId", "name", "redirectUris", "tokenEndpointAuthMethod", "grantTypes", "scopes", "skipConsent", "requirePKCE")
    values ($1, $1, $1, '["http://127.0.0.1:4319/callback"]', 'none', '["authorization_code", "refresh_token"]', '["mcp:read", "mcp:write", "offline_access"]', true, true)`,
    [clientId],
  );
  await db.query(
    'insert into "oauthClientResource" ("id", "clientId", "resourceId") values ($1, $2, $3)',
    [crypto.randomUUID(), clientId, mcpResource],
  );
}
async function issueOAuthToken(
  clientId: string,
  accountHeaders = owner,
  scope = "mcp:read mcp:write offline_access",
) {
  const verifier = "disposable-test-pkce-verifier-with-more-than-43-characters";
  const query = new URLSearchParams({
    client_id: clientId,
    redirect_uri: "http://127.0.0.1:4319/callback",
    response_type: "code",
    scope,
    resource: mcpResource,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
    state: "test-state",
  });
  const authorized = await auth.handler(
    new Request(`http://localhost:3000/api/auth/oauth2/authorize?${query}`, {
      headers: accountHeaders,
    }),
  );
  const code = new URL(authorized.headers.get("location")!).searchParams.get("code")!;
  expect(code).toBeTruthy();
  const response = await auth.handler(
    new Request("http://localhost:3000/api/auth/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: clientId,
        redirect_uri: "http://127.0.0.1:4319/callback",
        code,
        code_verifier: verifier,
        resource: mcpResource,
      }),
    }),
  );
  const tokens = (await response.json()) as { access_token: string; refresh_token: string };
  expect(response.status).toBe(200);
  expect(tokens.access_token).toBeTruthy();
  return tokens;
}

integration(
  "GPT plugin previews authorize real OAuth tokens, keep asset bytes private and reflect edits",
  async () => {
    const { POST } = await import("../../app/api/mcp/route");
    const { createDesignFileForUser } = await import("../design/service");
    const { ensureEditorDocument, appendBasicNodes, putAsset, patchDocumentNode } =
      await import("../design/document-service");
    await oauthClient("gpt-plugin");
    await consent("gpt-plugin", ownerId);
    const { access_token } = await issueOAuthToken("gpt-plugin");
    const file = await createDesignFileForUser(ownerId, orgId, "Plugin example");
    await ensureEditorDocument(ownerId, file.id);
    const nodes = await appendBasicNodes(ownerId, file.id, "frame", [
      { x: 0, y: 0, width: 360, height: 280 },
    ]);
    const asset = await putAsset(
      ownerId,
      orgId,
      "image/svg+xml",
      Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20" fill="#cf6846"/></svg>',
      ).toString("base64"),
    );
    const { getDocument } = await import("../design/document-service");
    const saved = (await getDocument(ownerId, file.id))!;
    const edited = await patchDocumentNode(ownerId, file.id, saved.revision, nodes[0].id, {
      style: {
        paints: [
          {
            id: "image-fill",
            type: "image",
            assetId: asset.assetId,
            fit: "cover",
            positionX: 50,
            positionY: 50,
            opacity: 1,
            visible: true,
          },
        ],
      },
    });
    const request = (fileId: string, token = access_token) =>
      POST(
        new Request(mcpResource, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
            "MCP-Protocol-Version": "2025-06-18",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: { name: "preview_design", arguments: { file_id: fileId } },
          }),
        }),
      );
    const response = await request(file.id);
    expect(response.status).toBe(200);
    const body = await response.text();
    const result = JSON.parse(
      body.startsWith("event:") || body.startsWith("data:")
        ? body
            .split("\n")
            .find((line) => line.startsWith("data: "))!
            .slice(6)
        : body,
    ).result;
    expect(result.structuredContent.revision).toBe(edited.revision);
    expect(result.structuredContent.document).toBeUndefined();
    expect(result._meta.tidyPreview.assets[asset.assetId]).toStartWith(
      "data:image/svg+xml;base64,",
    );
    const otherFile = await createDesignFileForUser(outsiderId, otherId, "Private to another team");
    await ensureEditorDocument(outsiderId, otherFile.id);
    const deniedResponse = await request(otherFile.id);
    const deniedBody = await deniedResponse.text();
    const denied = JSON.parse(
      deniedBody.startsWith("event:") || deniedBody.startsWith("data:")
        ? deniedBody
            .split("\n")
            .find((line) => line.startsWith("data: "))!
            .slice(6)
        : deniedBody,
    ).result;
    expect(denied.isError).toBe(true);
    expect(denied._meta).toBeUndefined();
    const { revokeMcpAuthorization } = await import("../mcp/authorizations");
    await revokeMcpAuthorization(ownerId, "gpt-plugin");
    expect((await request(file.id)).status).toBe(401);
  },
);

integration(
  "agent revocation invalidates issued JWTs and refresh tokens without affecting other grants",
  async () => {
    const { revokeMcpAuthorization, hasMcpAuthorization, authorizationVersion, authorizedClients } =
      await import("../mcp/authorizations");
    await oauthClient("agent-a");
    await oauthClient("agent-b");
    await consent("agent-a", ownerId);
    await consent("agent-a", invitedId);
    await consent("agent-b", ownerId);
    expect(
      (await authorizedClients(ownerId, mcpResource)).map((client) => client.clientId),
    ).toEqual(["agent-a", "agent-b"]);
    const old = await issueOAuthToken("agent-a");
    const claims = JSON.parse(
      Buffer.from(old.access_token.split(".")[1], "base64url").toString(),
    ) as Record<string, unknown>;
    expect(claims.bella_grant_version).toBe("0");
    expect(await hasMcpAuthorization(claims, mcpResource)).toBe(true);
    const { POST } = await import("../../app/api/mcp/route");
    function initialize(token: string) {
      return POST(
        new Request(mcpResource, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: {
              protocolVersion: "2025-06-18",
              capabilities: {},
              clientInfo: { name: "test", version: "1" },
            },
          }),
        }),
      );
    }
    expect((await initialize(old.access_token)).status).toBe(200);
    await revokeMcpAuthorization(ownerId, "agent-a");
    expect(
      (await authorizedClients(ownerId, mcpResource)).map((client) => client.clientId),
    ).toEqual(["agent-b"]);
    const denied = await initialize(old.access_token);
    expect(denied.status).toBe(401);
    expect(denied.headers.get("WWW-Authenticate")).toContain(
      'resource_metadata="http://localhost:3000/.well-known/oauth-protected-resource/api/mcp"',
    );
    const refresh = await auth.handler(
      new Request("http://localhost:3000/api/auth/oauth2/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          client_id: "agent-a",
          refresh_token: old.refresh_token,
          resource: mcpResource,
        }),
      }),
    );
    expect(refresh.status).toBe(400);
    expect(
      (
        await db.query('select 1 from "oauthConsent" where "userId" = $1 and "clientId" = $2', [
          invitedId,
          "agent-a",
        ])
      ).rowCount,
    ).toBe(1);
    expect(await hasMcpAuthorization({ ...claims, client_id: "agent-b" }, mcpResource)).toBe(true);
    expect(
      (await db.query('select 1 from "oauthClient" where "clientId" = $1', ["agent-a"])).rowCount,
    ).toBe(1);
    await consent("agent-a", ownerId);
    const fresh = await issueOAuthToken("agent-a");
    const freshClaims = JSON.parse(
      Buffer.from(fresh.access_token.split(".")[1], "base64url").toString(),
    );
    expect(freshClaims.bella_grant_version).toBe(await authorizationVersion(ownerId, "agent-a"));
    expect((await initialize(fresh.access_token)).status).toBe(200);
    expect((await initialize(old.access_token)).status).toBe(401);
    const sessionId = (await auth.api.getSession({ headers: owner }))!.session.id;
    await db.query('delete from "session" where "id" = $1', [sessionId]);
    expect((await initialize(fresh.access_token)).status).toBe(401);
  },
);

integration("invites preserve viewer, editor and admin roles on acceptance", async () => {
  const { removeMember } = await import("./membership");
  for (const role of ["viewer", "editor", "admin"] as const) {
    const invitation = await auth.api.createInvitation({
      headers: owner,
      body: { email: "outsider@example.com", role, organizationId: orgId },
    });
    expect(invitation.role).toBe(role);
    const accepted = await auth.api.acceptInvitation({
      headers: outsider,
      body: { invitationId: invitation.id },
    });
    expect(accepted.member.role).toBe(role);
    await removeMember(ownerId, orgId, accepted.member.id);
  }
});

integration("invite roles cannot escalate access through direct auth requests", async () => {
  const { changeMemberRole } = await import("./membership");
  for (const actorRole of ["viewer", "editor", "admin"] as const) {
    await changeMemberRole(ownerId, orgId, await memberId(invitedId), actorRole);
    for (const role of ["admin", "owner", "viewer,admin", "unknown"] as const) {
      await expect(
        auth.api.createInvitation({
          headers: invited,
          body: { email: "outsider@example.com", role: role as "admin", organizationId: orgId },
        }),
      ).rejects.toBeDefined();
    }
    if (actorRole !== "admin")
      await expect(
        auth.api.createInvitation({
          headers: invited,
          body: { email: "outsider@example.com", role: "viewer", organizationId: orgId },
        }),
      ).rejects.toBeDefined();
  }
  const invitation = await auth.api.createInvitation({
    headers: invited,
    body: { email: "outsider@example.com", role: "editor", organizationId: orgId },
  });
  expect(invitation.role).toBe("editor");
  await expect(
    auth.api.createInvitation({
      headers: owner,
      body: { email: "outsider@example.com", role: "owner", organizationId: otherId },
    }),
  ).rejects.toBeDefined();
  await expect(
    auth.api.createInvitation({
      headers: invited,
      body: {
        email: "outsider@example.com",
        role: "editor",
        organizationId: orgId,
        resend: true,
      },
    }),
  ).rejects.toBeDefined();
  await changeMemberRole(ownerId, orgId, await memberId(invitedId), "viewer");
  await expect(
    auth.api.acceptInvitation({ headers: outsider, body: { invitationId: invitation.id } }),
  ).rejects.toBeDefined();
});

integration(
  "settings enforce role management boundaries and edit pending invitations",
  async () => {
    const { changeMemberRole, changeInvitationRole, removeMember } = await import("./membership");
    const target = await memberId(invitedId);
    await changeMemberRole(ownerId, orgId, target, "admin");
    await expect(changeMemberRole(invitedId, orgId, target, "owner")).rejects.toThrow();
    const invitation = await auth.api.createInvitation({
      headers: owner,
      body: { email: "outsider@example.com", role: "viewer", organizationId: orgId },
    });
    await changeInvitationRole(invitedId, orgId, invitation.id, "editor");
    await expect(changeInvitationRole(invitedId, orgId, invitation.id, "admin")).rejects.toThrow();
    await expect(changeInvitationRole(ownerId, otherId, invitation.id, "viewer")).rejects.toThrow();
    await changeInvitationRole(ownerId, orgId, invitation.id, "admin");
    await expect(
      auth.api.cancelInvitation({ headers: invited, body: { invitationId: invitation.id } }),
    ).rejects.toBeDefined();
    const accepted = await auth.api.acceptInvitation({
      headers: outsider,
      body: { invitationId: invitation.id },
    });
    expect(accepted.member.role).toBe("admin");
    await expect(changeMemberRole(invitedId, orgId, accepted.member.id, "viewer")).rejects.toThrow(
      "Only owners",
    );
    await expect(removeMember(invitedId, orgId, accepted.member.id)).rejects.toThrow("Only owners");
    await changeMemberRole(ownerId, orgId, accepted.member.id, "editor");
    await changeMemberRole(invitedId, orgId, accepted.member.id, "viewer");
    await removeMember(invitedId, orgId, accepted.member.id);
    await expect(changeInvitationRole(ownerId, orgId, invitation.id, "viewer")).rejects.toThrow();
    await expect(
      auth.api.updateMemberRole({
        headers: owner,
        body: { organizationId: orgId, memberId: target, role: "owner" },
      }),
    ).rejects.toBeDefined();
    await expect(
      auth.api.removeMember({
        headers: owner,
        body: { organizationId: orgId, memberIdOrEmail: target },
      }),
    ).rejects.toBeDefined();
    await expect(
      auth.api.leaveOrganization({ headers: owner, body: { organizationId: orgId } }),
    ).rejects.toBeDefined();
  },
);

integration(
  "viewer can read and comment but cannot mutate designs, assets or imports",
  async () => {
    const { changeMemberRole, removeMember } = await import("./membership");
    const files = await import("../design/service");
    const docs = await import("../design/document-service");
    const comments = await import("../design/comments");
    const { commitDocumentPatch } = await import("../design/commands");
    const { diffDocument } = await import("../design/document-patch");
    const file = await files.createDesignFileForUser(ownerId, orgId, "Review me");
    const initial = await docs.ensureEditorDocument(ownerId, file.id);
    const staged = await docs.createImport(invitedId, orgId, "Existing import");
    await changeMemberRole(ownerId, orgId, await memberId(invitedId), "viewer");
    expect((await files.getDesignFile(invitedId, file.id))?.role).toBe("viewer");
    expect(await docs.getDocument(invitedId, file.id)).not.toBeNull();
    const thread = await comments.createComment(file.id, invitedId, 10, 10, "Please adjust this");
    await comments.replyToComment(file.id, thread, invitedId, "Here is why");
    const messages = (await comments.listComments(file.id, invitedId))!.threads[0].messages;
    await comments.editComment(
      file.id,
      messages[0].id,
      invitedId,
      "Please adjust this",
      "Please adjust the spacing",
    );
    await comments.toggleCommentReaction(file.id, messages[0].id, invitedId, "👍");
    await expect(
      comments.editComment(
        file.id,
        messages[0].id,
        ownerId,
        "Please adjust the spacing",
        "Overwrite",
      ),
    ).rejects.toThrow();
    await expect(files.createDesignFileForUser(invitedId, orgId, "Denied")).rejects.toThrow();
    await expect(files.renameDesignFileForUser(invitedId, file.id, "Denied")).rejects.toThrow();
    await expect(docs.createImport(invitedId, orgId, "Denied")).rejects.toThrow();
    await expect(docs.putImportChunk(invitedId, staged.importId, "1", [])).rejects.toThrow();
    await expect(docs.validateImport(invitedId, staged.importId)).rejects.toThrow();
    await expect(docs.commitImport(invitedId, staged.importId)).rejects.toThrow();
    expect((await docs.abortImport(invitedId, staged.importId)).aborted).toBe(false);
    await expect(
      docs.putAsset(
        invitedId,
        orgId,
        "image/svg+xml",
        Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString("base64"),
      ),
    ).rejects.toThrow();
    await expect(
      docs.replaceDocumentForHistory(invitedId, file.id, initial.revision, initial.content),
    ).rejects.toThrow();
    await expect(
      docs.addDocumentNode(invitedId, file.id, initial.revision, null, "text"),
    ).rejects.toThrow();
    await expect(
      docs.drawDocumentNode(invitedId, file.id, initial.revision, "new", "text", null, {
        x: 1,
        y: 1,
        width: 100,
        height: 40,
      }),
    ).rejects.toThrow();
    await expect(
      docs.patchDocumentNode(invitedId, file.id, initial.revision, "missing", { name: "Denied" }),
    ).rejects.toThrow();
    await expect(
      docs.deleteDocumentNode(invitedId, file.id, initial.revision, "missing"),
    ).rejects.toThrow();
    await expect(
      docs.duplicateDocumentNode(invitedId, file.id, initial.revision, "missing"),
    ).rejects.toThrow();
    await expect(
      commitDocumentPatch(
        invitedId,
        file.id,
        crypto.randomUUID(),
        initial.revision,
        diffDocument(initial.content, {
          ...initial.content,
          pages: [{ id: "page-1", name: "Denied" }],
        }),
        false,
      ),
    ).rejects.toThrow();
    expect((await files.getDesignFile(ownerId, file.id))?.name).toBe("Review me");
    expect((await docs.getDocument(ownerId, file.id))?.revision).toBe(initial.revision);
    await removeMember(ownerId, orgId, await memberId(invitedId));
    expect(await docs.getDocument(invitedId, file.id)).toBeNull();
    expect(await comments.listComments(file.id, invitedId)).toBeNull();
    await expect(comments.replyToComment(file.id, thread, invitedId, "Denied")).rejects.toThrow();
  },
);

integration(
  "editors and admins retain editing through shared services and downgrade revokes it",
  async () => {
    const { changeMemberRole } = await import("./membership");
    const { createDesignFileForUser, renameDesignFileForUser } = await import("../design/service");
    const docs = await import("../design/document-service");
    const { commitDocumentPatch } = await import("../design/commands");
    const { diffDocument } = await import("../design/document-patch");
    for (const role of ["member", "editor", "admin"] as const) {
      await changeMemberRole(ownerId, orgId, await memberId(invitedId), role);
      const file = await createDesignFileForUser(invitedId, orgId, role);
      await renameDesignFileForUser(invitedId, file.id, "Renamed");
      const snapshot = await docs.ensureEditorDocument(invitedId, file.id);
      const patch = diffDocument(snapshot.content, {
        ...snapshot.content,
        pages: [{ id: "page-1", name: "Updated" }],
      });
      const operationId = crypto.randomUUID();
      await commitDocumentPatch(invitedId, file.id, operationId, snapshot.revision, patch, false);
      await changeMemberRole(ownerId, orgId, await memberId(invitedId), "viewer");
      await expect(
        commitDocumentPatch(invitedId, file.id, operationId, snapshot.revision, patch, false),
      ).rejects.toThrow();
      await expect(renameDesignFileForUser(invitedId, file.id, "Denied")).rejects.toThrow();
    }
  },
);

integration(
  "viewer requests cannot bypass permissions via file actions, HTTP or extension imports",
  async () => {
    const { changeMemberRole } = await import("./membership");
    const { createDesignFileForUser } = await import("../design/service");
    const { ensureEditorDocument } = await import("../design/document-service");
    const { blankDesignDocument } = await import("../design/document");
    const file = await createDesignFileForUser(ownerId, orgId, "Protected file");
    const folderId = crypto.randomUUID();
    await db.query(
      'insert into "designFolder" ("id", "organizationId", "name", "createdBy") values ($1,$2,$3,$4)',
      [folderId, orgId, "Protected folder", ownerId],
    );
    await ensureEditorDocument(ownerId, file.id);
    await changeMemberRole(ownerId, orgId, await memberId(invitedId), "viewer");
    mock.module("next/headers", () => ({ headers: async () => invited }));
    mock.module("next/cache", () => ({ revalidatePath: () => {} }));
    const actions = await import("../../app/files/actions");
    for (const attempt of [
      () => actions.createDesignFile(),
      () => actions.createDesignFolder("Denied"),
      () => actions.renameDesignFile(file.id, "Denied"),
      () => actions.renameDesignFolder(folderId, "Denied"),
      () => actions.duplicateDesignFile(file.id),
      () => actions.duplicateDesignFolder(folderId),
      () => actions.deleteDesignFolder(folderId),
      () => actions.moveDesignFile(file.id, folderId),
      () => actions.setDesignFileArchived(file.id, true),
    ])
      expect((await attempt()).error).toBeTruthy();
    const { POST: edit } = await import("../../app/api/files/[uid]/changes/route");
    const requestHeaders = new Headers(invited);
    requestHeaders.set("origin", "http://localhost:3000");
    requestHeaders.set("content-type", "application/json");
    const response = await edit(
      new Request(`http://localhost:3000/api/files/${file.id}/changes`, {
        method: "POST",
        headers: requestHeaders,
        body: JSON.stringify({ operationId: crypto.randomUUID(), patch: [], conditional: false }),
      }),
      { params: Promise.resolve({ uid: file.id }) },
    );
    expect(response.status).toBe(403);
    const { importWebCapture } = await import("../extension/import");
    await expect(
      importWebCapture(invitedId, {
        userId: invitedId,
        organizationId: orgId,
        fileId: file.id,
        capture: {
          title: "Denied",
          url: "https://example.com",
          mode: "page",
          assets: [],
          document: {
            ...blankDesignDocument(),
            nodes: [
              {
                id: "frame",
                parentId: null,
                name: "Page",
                type: "artboard",
                box: { x: 0, y: 0, width: 800, height: 600 },
                style: {},
                layout: "absolute",
                locked: false,
                visible: true,
              },
            ],
          },
        },
      }),
    ).rejects.toThrow("access denied");
    const { GET: destinations } = await import("../../app/api/extension/account/route");
    const extensionHeaders = new Headers(invited);
    extensionHeaders.set("x-bella-extension", "1");
    const account = await destinations(
      new Request("http://localhost:3000/api/extension/account", { headers: extensionHeaders }),
    );
    expect(account.status).toBe(200);
    expect(((await account.json()) as { organizations: unknown[] }).organizations).toEqual([]);
    expect(
      (
        await db.query(
          'select "name", "archivedAt", "folderId" from "designFile" where "id" = $1',
          [file.id],
        )
      ).rows[0],
    ).toMatchObject({ name: "Protected file", archivedAt: null, folderId: null });
    expect(
      (await db.query('select "name" from "designFolder" where "id" = $1', [folderId])).rows[0]
        .name,
    ).toBe("Protected folder");
  },
);

integration("comment authors and file editors can resolve, reopen and delete threads", async () => {
  const { changeMemberRole } = await import("./membership");
  const { createDesignFileForUser } = await import("../design/service");
  const { ensureEditorDocument } = await import("../design/document-service");
  const comments = await import("../design/comments");
  const file = await createDesignFileForUser(ownerId, orgId, "Comment review");
  await ensureEditorDocument(ownerId, file.id);
  await changeMemberRole(ownerId, orgId, await memberId(invitedId), "viewer");
  const threadId = await comments.createComment(file.id, invitedId, 30, 40, "Viewer feedback");
  await comments.replyToComment(file.id, threadId, ownerId, "Owner reply");
  const original = (await comments.listComments(file.id, invitedId))!;
  expect(original.canModerateThreads).toBe(false);
  expect(original.threads[0].resolved).toBe(false);
  expect((await comments.listComments(file.id, ownerId))!.canModerateThreads).toBe(true);
  const sequence = (
    await db.query(
      'select max("sequence") as sequence from "designRealtimeEvent" where "fileId"=$1',
      [file.id],
    )
  ).rows[0].sequence;
  await comments.setCommentThreadResolved(file.id, threadId, invitedId, true);
  const resolved = (await comments.listComments(file.id, ownerId))!.threads[0];
  expect(resolved.resolved).toBe(true);
  expect(resolved.messages).toEqual(original.threads[0].messages);
  expect(
    (
      await db.query(
        'select "kind" from "designRealtimeEvent" where "fileId"=$1 and "sequence">$2',
        [file.id, sequence],
      )
    ).rows,
  ).toContainEqual({ kind: "comments" });
  await comments.setCommentThreadResolved(file.id, threadId, ownerId, false);
  expect((await comments.listComments(file.id, invitedId))!.threads[0].resolved).toBe(false);
  for (const role of ["editor", "member", "admin", "owner"] as const) {
    await db.query('update "member" set "role"=$1 where "organizationId"=$2 and "userId"=$3', [
      role,
      orgId,
      ownerId,
    ]);
    await comments.setCommentThreadResolved(file.id, threadId, ownerId, true);
    await comments.setCommentThreadResolved(file.id, threadId, ownerId, false);
    const toDelete = await comments.createComment(
      file.id,
      invitedId,
      30,
      40,
      `Moderate as ${role}`,
    );
    await comments.replyToComment(file.id, toDelete, invitedId, "Reply to delete");
    const messageId = (await comments.listComments(file.id, ownerId))!.threads.find(
      (thread) => thread.id === toDelete,
    )!.messages[0].id;
    await comments.toggleCommentReaction(file.id, messageId, invitedId, "👍");
    await comments.deleteCommentThread(file.id, toDelete, ownerId);
    expect(
      (await db.query('select 1 from "designCommentMessage" where "threadId"=$1', [toDelete]))
        .rowCount,
    ).toBe(0);
    expect(
      (await db.query('select 1 from "designCommentReaction" where "messageId"=$1', [messageId]))
        .rowCount,
    ).toBe(0);
  }
  await comments.deleteCommentThread(file.id, threadId, invitedId);
  expect((await comments.listComments(file.id, ownerId))!.threads).toEqual([]);
});

integration(
  "comment HTTP mutations allow viewer participation and reject unauthorized requests",
  async () => {
    const { changeMemberRole, removeMember } = await import("./membership");
    const { createDesignFileForUser } = await import("../design/service");
    const { ensureEditorDocument } = await import("../design/document-service");
    const comments = await import("../design/comments");
    const { POST } = await import("../../app/api/files/[uid]/comments/route");
    const file = await createDesignFileForUser(ownerId, orgId, "Viewer HTTP comments");
    const other = await createDesignFileForUser(ownerId, orgId, "Other HTTP file");
    await ensureEditorDocument(ownerId, file.id);
    await changeMemberRole(ownerId, orgId, await memberId(invitedId), "viewer");
    async function send(
      input: unknown,
      options: { fileId?: string; origin?: string; anonymous?: boolean } = {},
    ) {
      const uid = options.fileId ?? file.id;
      const requestHeaders = new Headers(options.anonymous ? undefined : invited);
      requestHeaders.set("origin", options.origin ?? "http://localhost:3000");
      requestHeaders.set("Content-Type", "application/json");
      return POST(
        new Request(`http://localhost:3000/api/files/${uid}/comments`, {
          method: "POST",
          headers: requestHeaders,
          body: JSON.stringify(input),
        }),
        { params: Promise.resolve({ uid }) },
      );
    }
    expect((await send({}, { origin: "https://other.example" })).status).toBe(403);
    expect((await send({}, { anonymous: true })).status).toBe(401);
    for (const input of [
      null,
      { action: "unknown" },
      { action: "resolve", threadId: "id", resolved: "true" },
      { action: "create", x: 0, y: 0, body: " ", pageId: "page-1" },
    ]) {
      expect((await send(input)).status).toBe(400);
    }
    const created = await send({
      action: "create",
      x: 10,
      y: 20,
      body: "Viewer thread",
      pageId: "page-1",
      userId: ownerId,
    });
    expect(created.status).toBe(200);
    const { id: threadId } = (await created.json()) as { id: string };
    const own = (await comments.listComments(file.id, invitedId))!.threads[0];
    expect(own.createdBy).toBe(invitedId);
    const messageId = own.messages[0].id;
    expect(
      (await send({ action: "edit", messageId, previousBody: "Viewer thread", body: "Updated" }))
        .status,
    ).toBe(200);
    expect((await send({ action: "reply", threadId, body: "Reply" })).status).toBe(200);
    const ownerThread = await comments.createComment(file.id, ownerId, 0, 0, "Owner thread");
    const ownerMessage = (await comments.listComments(file.id, ownerId))!.threads.find(
      (t) => t.id === ownerThread,
    )!.messages[0].id;
    for (const count of [1, 0]) {
      expect((await send({ action: "react", messageId: ownerMessage, emoji: "👍" })).status).toBe(
        200,
      );
      const message = (await comments.listComments(file.id, invitedId))!.threads.find(
        (t) => t.id === ownerThread,
      )!.messages[0];
      expect(message.reactions.length).toBe(count);
    }
    expect(
      (
        await send({
          action: "edit",
          messageId: ownerMessage,
          previousBody: "Owner thread",
          body: "Unauthorized",
        })
      ).status,
    ).toBe(409);
    expect((await send({ action: "delete", threadId: ownerThread })).status).toBe(409);
    expect((await send({ action: "resolve", threadId: ownerThread, resolved: true })).status).toBe(
      409,
    );
    expect(
      (await send({ action: "react", messageId, emoji: "👍" }, { fileId: other.id })).status,
    ).toBe(409);
    for (const resolved of [true, false]) {
      expect((await send({ action: "resolve", threadId, resolved })).status).toBe(200);
      expect(
        (await comments.listComments(file.id, invitedId))!.threads.find((t) => t.id === threadId)!
          .resolved,
      ).toBe(resolved);
    }
    expect((await send({ action: "delete", threadId })).status).toBe(200);
    expect(
      (await comments.listComments(file.id, invitedId))!.threads.some((t) => t.id === threadId),
    ).toBe(false);
    await removeMember(ownerId, orgId, await memberId(invitedId));
    expect((await send({ action: "react", messageId: ownerMessage, emoji: "👍" })).status).toBe(
      409,
    );
  },
);

integration(
  "comment moderation rejects other viewers, cross-file requests and revoked access",
  async () => {
    const { changeMemberRole, removeMember } = await import("./membership");
    const { createDesignFileForUser } = await import("../design/service");
    const { ensureEditorDocument } = await import("../design/document-service");
    const comments = await import("../design/comments");
    const file = await createDesignFileForUser(ownerId, orgId, "Protected feedback");
    const other = await createDesignFileForUser(ownerId, orgId, "Other file");
    await ensureEditorDocument(ownerId, file.id);
    const threadId = await comments.createComment(file.id, ownerId, 10, 10, "Owner feedback");
    await changeMemberRole(ownerId, orgId, await memberId(invitedId), "viewer");
    for (const actor of [invitedId, outsiderId]) {
      await expect(
        comments.setCommentThreadResolved(file.id, threadId, actor, true),
      ).rejects.toThrow();
      await expect(
        comments.setCommentThreadResolved(file.id, threadId, actor, false),
      ).rejects.toThrow();
      await expect(comments.deleteCommentThread(file.id, threadId, actor)).rejects.toThrow();
    }
    await expect(
      comments.setCommentThreadResolved(other.id, threadId, ownerId, true),
    ).rejects.toThrow();
    await expect(comments.deleteCommentThread(other.id, threadId, ownerId)).rejects.toThrow();
    await expect(
      comments.setCommentThreadResolved(file.id, threadId, ownerId, "true" as unknown as boolean),
    ).rejects.toThrow();
    // A direct action call enforces the same policy as the visible controls.
    mock.module("next/headers", () => ({ headers: async () => invited }));
    const actions = await import("../../app/files/comment-actions");
    expect((await actions.changeCommentThreadStatus(file.id, threadId, true)).error).toBeTruthy();
    expect((await actions.removeCommentThread(file.id, threadId)).error).toBeTruthy();
    await changeMemberRole(ownerId, orgId, await memberId(invitedId), "editor");
    expect(
      (await actions.changeCommentThreadStatus(file.id, threadId, true)).error,
    ).toBeUndefined();
    await changeMemberRole(ownerId, orgId, await memberId(invitedId), "viewer");
    expect((await actions.changeCommentThreadStatus(file.id, threadId, false)).error).toBeTruthy();
    const authored = await comments.createComment(file.id, invitedId, 20, 20, "Keep attribution");
    await removeMember(ownerId, orgId, await memberId(invitedId));
    expect(await comments.listComments(file.id, invitedId)).toBeNull();
    await expect(
      comments.setCommentThreadResolved(file.id, authored, invitedId, true),
    ).rejects.toThrow();
    await expect(comments.deleteCommentThread(file.id, authored, invitedId)).rejects.toThrow();
    const retained = (await comments.listComments(file.id, ownerId))!.threads.find(
      (thread) => thread.id === authored,
    )!;
    expect(retained.messages[0].authorId).toBe(invitedId);
    expect(retained.messages[0].authorName).toBe("Invited");
    await comments.deleteCommentThread(file.id, authored, ownerId);
  },
);

integration("folder services enforce current roles and same-organization file moves", async () => {
  const folders = await import("../design/folder-service");
  const { createDesignFileForUser } = await import("../design/service");
  const { changeMemberRole, removeMember } = await import("./membership");
  const folder = await folders.createDesignFolderForUser(ownerId, orgId, "  Tidy Design System  ");
  const foreign = await folders.createDesignFolderForUser(outsiderId, otherId, "Other folder");
  const file = await createDesignFileForUser(ownerId, orgId, "Components");
  expect(folder.name).toBe("Tidy Design System");
  expect(await folders.listDesignFolders(outsiderId, orgId)).toEqual([]);
  const membership = await memberId(invitedId);
  for (const role of ["viewer", "editor", "admin", "member"] as const) {
    await changeMemberRole(ownerId, orgId, membership, role);
    expect(await folders.listDesignFolders(invitedId, orgId)).toMatchObject([
      { id: folder.id, canEdit: role !== "viewer" },
    ]);
    if (role === "viewer") {
      await expect(folders.createDesignFolderForUser(invitedId, orgId, "Denied")).rejects.toThrow();
      await expect(
        folders.renameDesignFolderForUser(invitedId, folder.id, "Denied"),
      ).rejects.toThrow();
      await expect(folders.moveDesignFileForUser(invitedId, file.id, folder.id)).rejects.toThrow();
      await expect(folders.deleteDesignFolderForUser(invitedId, folder.id)).rejects.toThrow();
    } else {
      const own = await folders.createDesignFolderForUser(invitedId, orgId, role);
      expect(
        (await folders.renameDesignFolderForUser(invitedId, own.id, `Renamed ${role}`)).name,
      ).toBe(`Renamed ${role}`);
      expect(await folders.moveDesignFileForUser(invitedId, file.id, own.id)).toMatchObject({
        id: file.id,
        folderId: own.id,
      });
      expect(await folders.moveDesignFileForUser(invitedId, file.id, null)).toMatchObject({
        id: file.id,
        folderId: null,
      });
      expect(await folders.deleteDesignFolderForUser(invitedId, own.id)).toEqual({
        id: own.id,
        unfiledFileCount: 0,
      });
    }
  }
  for (const name of ["", "  ", "x".repeat(121), "invalid\u0000name"]) {
    await expect(folders.createDesignFolderForUser(ownerId, orgId, name)).rejects.toThrow();
    await expect(folders.renameDesignFolderForUser(ownerId, folder.id, name)).rejects.toThrow();
  }
  // Even a member of both organizations cannot move files across that boundary.
  await db.query(
    'insert into "member" ("id", "organizationId", "userId", "role", "createdAt") values ($1,$2,$3,\'editor\',now())',
    [crypto.randomUUID(), otherId, ownerId],
  );
  await expect(folders.moveDesignFileForUser(ownerId, file.id, foreign.id)).rejects.toThrow();
  await expect(folders.moveDesignFileForUser(ownerId, file.id, "missing-folder")).rejects.toThrow();
  await expect(folders.moveDesignFileForUser(ownerId, "missing-file", folder.id)).rejects.toThrow();
  await expect(
    folders.renameDesignFolderForUser(outsiderId, folder.id, "Denied"),
  ).rejects.toThrow();
  await expect(folders.deleteDesignFolderForUser(outsiderId, folder.id)).rejects.toThrow();
  await expect(folders.createDesignFolderForUser(outsiderId, orgId, "Denied")).rejects.toThrow();
  await removeMember(ownerId, orgId, membership);
  expect(await folders.listDesignFolders(invitedId, orgId)).toEqual([]);
  await expect(folders.moveDesignFileForUser(invitedId, file.id, folder.id)).rejects.toThrow();
  expect(
    (await db.query('select "name" from "designFolder" where "id"=$1', [folder.id])).rows[0].name,
  ).toBe("Tidy Design System");
  expect(
    (await db.query('select "folderId" from "designFile" where "id"=$1', [file.id])).rows[0]
      .folderId,
  ).toBeNull();
});

integration(
  "deleting a folder preserves active and archived files and their documents",
  async () => {
    const folders = await import("../design/folder-service");
    const { createDesignFileForUser } = await import("../design/service");
    const { ensureEditorDocument, getDocument } = await import("../design/document-service");
    const folder = await folders.createDesignFolderForUser(
      ownerId,
      orgId,
      "Remove only the folder",
    );
    const files = await Promise.all(
      ["Active", "Archived"].map((name) => createDesignFileForUser(ownerId, orgId, name)),
    );
    const originals = [];
    for (const file of files) {
      originals.push(await ensureEditorDocument(ownerId, file.id));
      await folders.moveDesignFileForUser(ownerId, file.id, folder.id);
    }
    await db.query('update "designFile" set "archivedAt"=now() where "id"=$1', [files[1].id]);
    expect(await folders.deleteDesignFolderForUser(ownerId, folder.id)).toEqual({
      id: folder.id,
      unfiledFileCount: 2,
    });
    expect(
      (await db.query('select 1 from "designFolder" where "id"=$1', [folder.id])).rowCount,
    ).toBe(0);
    for (const [index, file] of files.entries()) {
      const stored = (
        await db.query('select "name", "folderId", "archivedAt" from "designFile" where "id"=$1', [
          file.id,
        ])
      ).rows[0];
      expect(stored).toMatchObject({ name: file.name, folderId: null });
      expect(Boolean(stored.archivedAt)).toBe(index === 1);
    }
    expect(await getDocument(ownerId, files[0].id)).toEqual(originals[0]);
    expect(
      (await db.query('select "content" from "designDocument" where "fileId"=$1', [files[1].id]))
        .rows[0].content,
    ).toEqual(originals[1].content);
    await expect(folders.deleteDesignFolderForUser(ownerId, folder.id)).rejects.toThrow();
  },
);

integration(
  "authenticated MCP discovers folder tools and organizes files with current permissions",
  async () => {
    mock.module("next/cache", () => ({ revalidatePath: () => {} }));
    const { POST } = await import("../../app/api/mcp/route");
    const { createDesignFileForUser } = await import("../design/service");
    const { changeMemberRole } = await import("./membership");
    await oauthClient("folder-agent");
    await consent("folder-agent", ownerId);
    await consent("folder-agent", invitedId);
    const ownerToken = await issueOAuthToken("folder-agent");
    const memberToken = await issueOAuthToken("folder-agent", invited);
    async function rpc<T>(token: string, method: string, params: object) {
      const response = await POST(
        new Request(mcpResource, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
            "MCP-Protocol-Version": "2025-06-18",
          },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        }),
      );
      expect(response.status).toBe(200);
      const body = await response.text();
      const json = response.headers.get("content-type")?.includes("text/event-stream")
        ? body
            .split("\n")
            .filter((line) => line.startsWith("data: "))
            .map((line) => JSON.parse(line.slice(6)))
            .find((message) => message.id === 1)
        : JSON.parse(body);
      expect(json.error).toBeUndefined();
      return json.result as T;
    }
    const tools = await rpc<{
      tools: {
        name: string;
        annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
      }[];
    }>(ownerToken.access_token, "tools/list", {});
    for (const name of [
      "list_folders",
      "create_folder",
      "rename_folder",
      "delete_folder",
      "move_file",
    ])
      expect(tools.tools.map((tool) => tool.name)).toContain(name);
    expect(
      tools.tools.find((tool) => tool.name === "list_folders")?.annotations?.readOnlyHint,
    ).toBe(true);
    expect(
      tools.tools.find((tool) => tool.name === "delete_folder")?.annotations?.destructiveHint,
    ).toBe(true);
    type Reply = {
      isError?: boolean;
      structuredContent?: {
        folder?: { id: string; name: string };
        file?: { folderId: string | null };
        folders?: { id: string }[];
        deleted?: { id: string; unfiledFileCount: number };
      };
    };
    const call = (token: string, name: string, args: object) =>
      rpc<Reply>(token, "tools/call", { name, arguments: args });
    expect(
      (await db.query('select 1 from "organizationMcpUsage" where "organizationId"=$1', [orgId]))
        .rowCount,
    ).toBe(0);
    const created = await call(ownerToken.access_token, "create_folder", {
      organization_id: orgId,
      name: "  Tidy Design System  ",
      userId: outsiderId,
    });
    expect(created.isError).toBeUndefined();
    expect(created.structuredContent?.folder?.name).toBe("Tidy Design System");
    const folderId = created.structuredContent!.folder!.id;
    const file = await createDesignFileForUser(ownerId, orgId, "Components — 2026-10-03");
    expect(
      (await call(ownerToken.access_token, "move_file", { file_id: file.id, folder_id: folderId }))
        .structuredContent?.file?.folderId,
    ).toBe(folderId);
    expect(
      (await call(ownerToken.access_token, "move_file", { file_id: file.id, folder_id: null }))
        .structuredContent?.file?.folderId,
    ).toBeNull();
    expect(
      (
        await call(ownerToken.access_token, "rename_folder", {
          folder_id: folderId,
          name: "Reusable components",
        })
      ).structuredContent?.folder?.name,
    ).toBe("Reusable components");
    await changeMemberRole(ownerId, orgId, await memberId(invitedId), "viewer");
    expect(
      (await call(memberToken.access_token, "list_folders", { organization_id: orgId }))
        .structuredContent?.folders,
    ).toMatchObject([{ id: folderId }]);
    for (const [name, args] of [
      ["create_folder", { organization_id: orgId, name: "Denied" }],
      ["rename_folder", { folder_id: folderId, name: "Denied" }],
      ["move_file", { file_id: file.id, folder_id: folderId }],
      ["delete_folder", { folder_id: folderId }],
    ] as const) {
      expect((await call(memberToken.access_token, name, args)).isError).toBe(true);
    }
    expect(
      (await call(ownerToken.access_token, "list_folders", { organization_id: otherId })).isError,
    ).toBe(true);
    expect(
      (await db.query('select 1 from "organizationMcpUsage" where "organizationId"=$1', [otherId]))
        .rowCount,
    ).toBe(0);
    expect(
      (await call(ownerToken.access_token, "delete_folder", { folder_id: folderId }))
        .structuredContent?.deleted,
    ).toEqual({ id: folderId, unfiledFileCount: 0 });
    expect(
      (await call(ownerToken.access_token, "list_folders", { organization_id: orgId }))
        .structuredContent?.folders,
    ).toEqual([]);
    // Exercise the gate through real OAuth + SDK dispatch, including its public
    // error shape and the absence of side effects when the allowance is full.
    await db.query(`update "billingDeployment" set "selfHosted"=false;
      update "billingPlan" set "mcpCallLimit"=1 where "id"='free'`);
    await db.query('update "organizationMcpUsage" set "calls"=0 where "organizationId"=$1', [
      orgId,
    ]);
    try {
      expect(
        (await call(ownerToken.access_token, "list_folders", { organization_id: orgId })).isError,
      ).toBeUndefined();
      const exhausted = await call(ownerToken.access_token, "create_folder", {
        organization_id: orgId,
        name: "Over quota",
      });
      expect(exhausted.isError).toBe(true);
      expect(JSON.stringify(exhausted)).toContain("Free allows 1 MCP calls per month");
      expect(
        (
          await db.query(
            'select 1 from "designFolder" where "organizationId"=$1 and "name"=\'Over quota\'',
            [orgId],
          )
        ).rowCount,
      ).toBe(0);
      expect(
        (
          await db.query<{ calls: string }>(
            'select "calls" from "organizationMcpUsage" where "organizationId"=$1',
            [orgId],
          )
        ).rows[0].calls,
      ).toBe("1");
      expect(
        (await rpc<{ tools: unknown[] }>(ownerToken.access_token, "tools/list", {})).tools.length,
      ).toBeGreaterThan(0);
    } finally {
      await db.query(`update "billingDeployment" set "selfHosted"=true;
        update "billingPlan" set "mcpCallLimit"=5000 where "id"='free'`);
    }
  },
);

integration(
  "a read-only MCP grant can read and receives a write challenge without changing designs",
  async () => {
    await oauthClient("readonly-agent");
    await consent("readonly-agent", ownerId, ["mcp:read"]);
    const tokens = await issueOAuthToken("readonly-agent", owner, "mcp:read offline_access");
    const { POST } = await import("../../app/api/mcp/route");
    const send = (method: string, params: object) =>
      POST(
        new Request(mcpResource, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${tokens.access_token}`,
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
          },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        }),
      );
    const read = await send("tools/call", { name: "list_organizations", arguments: {} });
    expect(read.status).toBe(200);
    expect(await read.text()).toContain(orgId);
    const write = await send("tools/call", {
      name: "create_file",
      arguments: { organization_id: orgId, name: "Forbidden" },
    });
    expect(write.status).toBe(403);
    expect(write.headers.get("WWW-Authenticate")).toContain('error="insufficient_scope"');
    expect(write.headers.get("WWW-Authenticate")).toContain("mcp:write");
    expect(
      (
        await db.query('select 1 from "designFile" where "organizationId" = $1 and "name" = $2', [
          orgId,
          "Forbidden",
        ])
      ).rowCount,
    ).toBe(0);
    expect((await send("tools/call", { name: "future_unknown_tool", arguments: {} })).status).toBe(
      403,
    );
  },
);

integration(
  "OAuth requires S256 PKCE, the correct verifier, single-use codes and the MCP resource",
  async () => {
    await oauthClient("pkce-agent");
    await consent("pkce-agent", ownerId);
    const verifier = "a-disposable-verifier-with-at-least-forty-three-characters";
    const query = new URLSearchParams({
      client_id: "pkce-agent",
      redirect_uri: "http://127.0.0.1:4319/callback",
      response_type: "code",
      scope: "mcp:read mcp:write offline_access",
      resource: mcpResource,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
      state: "disposable-state",
    });
    const authorize = async (params: URLSearchParams) =>
      auth.handler(
        new Request(`http://localhost:3000/api/auth/oauth2/authorize?${params}`, {
          headers: owner,
        }),
      );
    for (const change of [
      { code_challenge_method: "plain" },
      { resource: "https://another.example/mcp" },
    ]) {
      const invalid = new URLSearchParams(query);
      for (const [name, value] of Object.entries(change)) invalid.set(name, value);
      const response = await authorize(invalid);
      expect(response.headers.get("location") ?? (await response.text())).not.toContain("?code=");
      expect(
        response.status === 400 || (response.headers.get("location") ?? "").includes("error="),
      ).toBe(true);
    }
    const noResource = new URLSearchParams(query);
    noResource.delete("resource");
    const missing = await authorize(noResource);
    expect(
      missing.status === 400 || (missing.headers.get("location") ?? "").includes("error="),
    ).toBe(true);
    const authorized = await authorize(query);
    const code = new URL(authorized.headers.get("location")!).searchParams.get("code")!;
    const exchange = (value: string, verifierValue: string) =>
      auth.handler(
        new Request("http://localhost:3000/api/auth/oauth2/token", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "authorization_code",
            client_id: "pkce-agent",
            redirect_uri: "http://127.0.0.1:4319/callback",
            code: value,
            code_verifier: verifierValue,
            resource: mcpResource,
          }),
        }),
      );
    const incorrect = await exchange(
      code,
      "incorrect-verifier-with-at-least-forty-three-characters",
    );
    expect([400, 401]).toContain(incorrect.status);
    expect(await incorrect.text()).not.toContain("access_token");
    // A failed exchange may invalidate the code; authorize again for the success case.
    const fresh = await authorize(query);
    const freshCode = new URL(fresh.headers.get("location")!).searchParams.get("code")!;
    const tokenResponse = await exchange(freshCode, verifier);
    expect(tokenResponse.status).toBe(200);
    const token = (await tokenResponse.json()) as { access_token: string; expires_in: number };
    expect(token.expires_in).toBe(900);
    const claims = JSON.parse(
      Buffer.from(token.access_token.split(".")[1], "base64url").toString(),
    );
    expect(Array.isArray(claims.aud) ? claims.aud : [claims.aud]).toContain(mcpResource);
    expect([400, 401]).toContain((await exchange(freshCode, verifier)).status);
  },
);

integration(
  "refresh rotation recovers a retried response and rejects replay after the overlap window",
  async () => {
    await oauthClient("refresh-agent");
    await consent("refresh-agent", ownerId);
    const tokens = await issueOAuthToken("refresh-agent");
    const refresh = () =>
      auth.handler(
        new Request("http://localhost:3000/api/auth/oauth2/token", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "refresh_token",
            client_id: "refresh-agent",
            refresh_token: tokens.refresh_token,
            resource: mcpResource,
          }),
        }),
      );
    const rotated = await refresh();
    expect(rotated.status).toBe(200);
    const replacement = (await rotated.json()) as {
      access_token: string;
      refresh_token: string;
      expires_at: number;
      expires_in: number;
    };
    expect(replacement.refresh_token).not.toBe(tokens.refresh_token);
    const { expires_in: originalLifetime, ...unchangedResponse } = replacement;
    // Cross a second boundary: replay preserves tokens/absolute expiry, not the countdown.
    await Bun.sleep(1100);
    const replayStarted = Math.floor(Date.now() / 1000);
    const replay = await refresh();
    expect(replay.status).toBe(200);
    const replayed = (await replay.json()) as typeof replacement;
    const replayFinished = Math.floor(Date.now() / 1000);
    expect(replayed).toMatchObject(unchangedResponse);
    expect(replayed.expires_in).toBeGreaterThan(0);
    expect(replayed.expires_in).toBeLessThan(originalLifetime);
    expect(replayed.expires_in).toBeGreaterThanOrEqual(replayed.expires_at - replayFinished);
    expect(replayed.expires_in).toBeLessThanOrEqual(replayed.expires_at - replayStarted);
    await db.query(
      'update "oauthRefreshToken" set "rotationReplayExpiresAt" = now() - interval \'1 minute\', "rotatedAt" = now() - interval \'1 minute\' where "clientId" = $1 and "rotatedAt" is not null',
      ["refresh-agent"],
    );
    expect((await refresh()).status).toBe(400);
  },
);

integration(
  "MCP rejects correctly signed tokens with a wrong audience, wrong issuer or expired lifetime",
  async () => {
    await oauthClient("claims-agent");
    await consent("claims-agent", ownerId);
    const issued = await issueOAuthToken("claims-agent");
    const claims = JSON.parse(
      Buffer.from(issued.access_token.split(".")[1], "base64url").toString(),
    ) as Record<string, unknown>;
    const { POST } = await import("../../app/api/mcp/route");
    for (const changed of [
      { aud: "https://other.example/mcp" },
      { iss: "https://other.example/api/auth" },
      { exp: Math.floor(Date.now() / 1000) - 60 },
    ]) {
      const { token } = await auth.api.signJWT({ body: { payload: { ...claims, ...changed } } });
      const response = await POST(
        new Request(mcpResource, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
        }),
      );
      expect(response.status).toBe(401);
      expect(response.headers.get("WWW-Authenticate")).toContain("resource_metadata=");
    }
  },
);

integration(
  "realtime admission and reauthorization reject unverified, expired, revoked and foreign sessions",
  async () => {
    const { roomConnectionQuery, roomSessionsQuery } = await import("../realtime/authorization");
    const { createDesignFileForUser } = await import("../design/service");
    const file = await createDesignFileForUser(ownerId, orgId, "Realtime boundary");
    const session = (await auth.api.getSession({ headers: invited }))!;
    const check = async (allowed: boolean) => {
      const connection = await db.query(roomConnectionQuery, [
        file.id,
        invitedId,
        session.session.id,
        orgId,
      ]);
      const active = await db.query(roomSessionsQuery, [file.id, [session.session.id]]);
      expect(Boolean(connection.rowCount)).toBe(allowed);
      expect(Boolean(active.rowCount)).toBe(allowed);
    };
    await check(true);
    expect(
      (await db.query(roomConnectionQuery, [file.id, invitedId, session.session.id, otherId]))
        .rowCount,
    ).toBe(0);
    expect(
      (await db.query(roomConnectionQuery, [file.id, outsiderId, session.session.id, orgId]))
        .rowCount,
    ).toBe(0);
    await db.query('update "user" set "emailVerified"=false where "id"=$1', [invitedId]);
    await check(false);
    await db.query('update "user" set "emailVerified"=true where "id"=$1', [invitedId]);
    await db.query('update "member" set "role"=$1 where "userId"=$2', ["unknown", invitedId]);
    await check(false);
    await db.query('update "member" set "role"=$1 where "userId"=$2', ["viewer", invitedId]);
    await check(true);
    await db.query('update "session" set "expiresAt"=now()-interval \'1 second\' where "id"=$1', [
      session.session.id,
    ]);
    await check(false);
    await db.query('update "session" set "expiresAt"=now()+interval \'1 hour\' where "id"=$1', [
      session.session.id,
    ]);
    await db.query('delete from "member" where "userId"=$1 and "organizationId"=$2', [
      invitedId,
      orgId,
    ]);
    await check(false);
  },
);

integration(
  "shared permission and membership services reject unverified identities and malformed roles",
  async () => {
    const { requireOrganizationPermission, requireFilePermission } =
      await import("./authorization");
    const { changeMemberRole } = await import("./membership");
    const { createDesignFileForUser } = await import("../design/service");
    const file = await createDesignFileForUser(ownerId, orgId, "Verified actor");
    await db.query('update "user" set "emailVerified"=false where "id"=$1', [ownerId]);
    await expect(requireOrganizationPermission(ownerId, orgId, "own")).rejects.toThrow(
      "access denied",
    );
    await expect(requireFilePermission(ownerId, file.id, "view")).rejects.toThrow("access denied");
    await expect(
      changeMemberRole(ownerId, orgId, await memberId(invitedId), "viewer"),
    ).rejects.toThrow("Verify your email");
    await db.query('update "user" set "emailVerified"=true where "id"=$1', [ownerId]);
    await db.query('update "member" set "role"=$1 where "userId"=$2', ["owner,admin", ownerId]);
    await expect(
      changeMemberRole(ownerId, orgId, await memberId(invitedId), "admin"),
    ).rejects.toThrow("no longer belong");
    expect(
      (await db.query('select "role" from "member" where "userId"=$1', [invitedId])).rows[0].role,
    ).toBe("member");
  },
);

integration(
  "asset HTTP uploads reject foreign origins and oversized streams before multipart parsing",
  async () => {
    const { createDesignFileForUser } = await import("../design/service");
    const file = await createDesignFileForUser(ownerId, orgId, "Upload boundary");
    const { POST } = await import("../../app/api/files/[uid]/assets/route");
    const url = `http://localhost:3000/api/files/${file.id}/assets`;
    const foreign = new Headers(owner);
    foreign.set("origin", "https://untrusted.localhost");
    expect(
      (
        await POST(new Request(url, { method: "POST", headers: foreign, body: "unused" }), {
          params: Promise.resolve({ uid: file.id }),
        })
      ).status,
    ).toBe(403);
    const headers = new Headers(owner);
    headers.set("origin", "http://localhost:3000");
    headers.set("content-type", "multipart/form-data; boundary=test");
    let canceled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(1_000_000));
      },
      cancel() {
        canceled = true;
      },
    });
    const response = await POST(
      new Request(url, { method: "POST", headers, body, duplex: "half" } as RequestInit),
      { params: Promise.resolve({ uid: file.id }) },
    );
    expect(response.status).toBe(413);
    expect(canceled).toBe(true);
    expect(
      (await db.query('select "id" from "designAsset" where "organizationId"=$1', [orgId]))
        .rowCount,
    ).toBe(0);
  },
);

integration("auth HTTP rejects oversized JSON before creating an account", async () => {
  const { POST } = await import("../../app/api/auth/[...all]/route");
  const response = await POST(
    new Request("http://localhost:3000/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost:3000" },
      body: JSON.stringify({
        name: "Large body",
        email: "large@example.test",
        password: "disposable-password-123",
        padding: "x".repeat(70_000),
      }),
    }),
  );
  expect(response.status).toBe(413);
  expect(
    (await db.query('select "id" from "user" where "email"=$1', ["large@example.test"])).rowCount,
  ).toBe(0);
});

integration(
  "restricted runtime grants preserve product access and deny catalog administration",
  async () => {
    const { inDatabaseScope } = await import("../database-scope");
    const { organizationPlanUsage, requireRegisteredProPrice } =
      await import("../billing/plan-server");
    const { createDesignFileForUser } = await import("../design/service");
    const sql = await readFile(
      resolve(import.meta.dir, "../../../../migrations/operations/runtime-grants.sql"),
      "utf8",
    );
    const client = await db.connect();
    try {
      await client.query("begin");
      await client.query(
        "create role tidy_runtime_test login nosuperuser nobypassrls nocreatedb nocreaterole",
      );
      await client.query("grant pg_read_all_data, pg_write_all_data to tidy_runtime_test");
      await client.query("select set_config('tidy.runtime_role', 'tidy_runtime_test', true)");
      await client.query(sql);
      await client.query("set local role tidy_runtime_test");
      await inDatabaseScope(client, async () => {
        expect((await db.query("select current_user as role")).rows[0].role).toBe(
          "tidy_runtime_test",
        );
        expect((await organizationPlanUsage(orgId)).tier).toBe("self_hosted");
        const file = await createDesignFileForUser(ownerId, orgId, "Restricted runtime");
        expect(file.id).toBeTruthy();
        await (
          await import("../design/service")
        ).renameDesignFileForUser(ownerId, file.id, "Restricted runtime renamed");
        expect(
          (
            await db.query('select "fileId" from "designRealtimeState" where "fileId"=$1', [
              file.id,
            ])
          ).rowCount,
        ).toBe(1);
        expect((await auth.api.getSession({ headers: owner }))?.user.id).toBe(ownerId);
        const previousPrice = testEnvironment.STRIPE_PRO_PRICE_ID;
        try {
          testEnvironment.STRIPE_PRO_PRICE_ID = "price_not_enrolled";
          await expect(requireRegisteredProPrice()).rejects.toThrow("registered by an operator");
        } finally {
          if (previousPrice === undefined) delete testEnvironment.STRIPE_PRO_PRICE_ID;
          else testEnvironment.STRIPE_PRO_PRICE_ID = previousPrice;
        }
        for (const statement of [
          'update "billingDeployment" set "selfHosted"=true',
          'update "billingPlan" set "fileLimit"=null',
          'insert into "billingPlanPrice" ("priceId") values (\'price_not_enrolled\')',
          'insert into "organizationCreationPermission" ("userId","allowMultiple") values (\'arbitrary\',true)',
          'truncate "designFile" cascade',
          "create table public.runtime_owned (id text)",
        ]) {
          await client.query("savepoint denial");
          await expect(client.query(statement)).rejects.toMatchObject({ code: "42501" });
          await client.query("rollback to savepoint denial");
          await client.query("release savepoint denial");
        }
        expect(
          (
            await db.query('select "priceId" from "billingPlanPrice" where "priceId"=$1', [
              "price_not_enrolled",
            ])
          ).rowCount,
        ).toBe(0);
      });
    } finally {
      await client.query("rollback");
      client.release();
    }
  },
);

integration("runtime grant operation fails closed when an unreviewed table appears", async () => {
  const sql = await readFile(
    resolve(import.meta.dir, "../../../../migrations/operations/runtime-grants.sql"),
    "utf8",
  );
  const client = await db.connect();
  try {
    await client.query("begin");
    await client.query(
      "create role tidy_runtime_test login nosuperuser nobypassrls nocreatedb nocreaterole",
    );
    await client.query("select set_config('tidy.runtime_role', 'tidy_runtime_test', true)");
    await client.query("create table public.unreviewed_table (id text)");
    await expect(client.query(sql)).rejects.toThrow("table inventory differs");
  } finally {
    await client.query("rollback");
    client.release();
  }
});

integration(
  "page data services scope members, invitations, files, folders and billing to the current actor",
  async () => {
    const { listWorkspaceMembers, listPendingInvitations } = await import("./queries");
    const { listBrowserFiles, listBrowserFolders } = await import("../design/browser-queries");
    const { billingStatus } = await import("../billing/server");
    const { createDesignFolderForUser } = await import("../design/folder-service");
    const { createDesignFileForUser } = await import("../design/service");
    await createDesignFolderForUser(ownerId, orgId, "Private folder");
    await createDesignFileForUser(ownerId, orgId, "Private file");
    await auth.api.createInvitation({
      headers: owner,
      body: { email: "pending@example.test", role: "viewer", organizationId: orgId },
    });
    expect(await listWorkspaceMembers(ownerId, orgId)).toHaveLength(2);
    expect(await listPendingInvitations(ownerId, orgId)).toHaveLength(1);
    expect(await listPendingInvitations(invitedId, orgId)).toHaveLength(0);
    expect(await listBrowserFolders(ownerId, orgId)).toHaveLength(1);
    expect(await listBrowserFiles(ownerId, orgId, false, null)).toHaveLength(1);
    const denied = async (userId: string) => {
      expect(await listWorkspaceMembers(userId, orgId)).toEqual([]);
      expect(await listPendingInvitations(userId, orgId)).toEqual([]);
      expect(await listBrowserFolders(userId, orgId)).toEqual([]);
      expect(await listBrowserFiles(userId, orgId, false, null)).toEqual([]);
      await expect(billingStatus(userId, orgId, true)).rejects.toThrow("access denied");
    };
    await denied(outsiderId);
    await db.query('delete from "member" where "userId"=$1 and "organizationId"=$2', [
      invitedId,
      orgId,
    ]);
    await denied(invitedId);
    await db.query('update "user" set "emailVerified"=false where "id"=$1', [ownerId]);
    await denied(ownerId);
  },
);

integration(
  "file management services reject cross-tenant sources and destinations without partial copies",
  async () => {
    const {
      createBrowserFileForUser,
      duplicateFileForUser,
      duplicateFolderForUser,
      archiveFileForUser,
    } = await import("../design/file-management");
    const { createDesignFolderForUser } = await import("../design/folder-service");
    const folder = await createDesignFolderForUser(ownerId, orgId, "Private folder");
    const file = await createBrowserFileForUser(ownerId, orgId, folder.id);
    expect("id" in file).toBe(true);
    if (!file.id) throw new Error("Fixture file missing");
    const count = async () =>
      (await db.query('select count(*)::int as count from "designFile"')).rows[0].count;
    const before = await count();
    expect(await createBrowserFileForUser(outsiderId, otherId, folder.id)).toHaveProperty("error");
    expect(await duplicateFileForUser(outsiderId, file.id)).toHaveProperty("error");
    expect(await duplicateFolderForUser(outsiderId, folder.id)).toHaveProperty("error");
    expect(await archiveFileForUser(outsiderId, file.id, true)).toHaveProperty("error");
    expect(await count()).toBe(before);
    expect(
      (await db.query('select "archivedAt" from "designFile" where "id"=$1', [file.id])).rows[0]
        .archivedAt,
    ).toBeNull();
    expect(await duplicateFileForUser(ownerId, file.id)).toHaveProperty("id");
    expect(await duplicateFolderForUser(ownerId, folder.id)).toHaveProperty("id");
    expect(await count()).toBe(before + 3);
  },
);

for (const storedDocument of [false, true]) {
  integration(
    `archived snapshots remain read-only and require verified exact-role membership (${storedDocument ? "document" : "legacy"})`,
    async () => {
      const { createDesignFileForUser, getDesignFile, listDesignFiles, listDesignOrganizations } =
        await import("../design/service");
      const { ensureEditorDocument, getDocument, getArchivedEditorDocument } =
        await import("../design/document-service");
      const file = await createDesignFileForUser(ownerId, orgId, "Archived boundary");
      const frameId = crypto.randomUUID();
      await db.query(
        'insert into "designFrame" ("id","fileId","x","y","width","height") values ($1,$2,0,0,400,300)',
        [frameId, file.id],
      );
      if (storedDocument) await ensureEditorDocument(ownerId, file.id);
      await db.query(
        `update "member" set "role"='viewer' where "organizationId"=$1 and "userId"=$2`,
        [orgId, invitedId],
      );
      const before = (await db.query('select * from "designDocument" where "fileId"=$1', [file.id]))
        .rows;
      await db.query('update "designFile" set "archivedAt"=now() where "id"=$1', [file.id]);
      expect(await getDesignFile(invitedId, file.id, false)).toBeNull();
      expect(await getDesignFile(invitedId, file.id, false, true)).toMatchObject({
        id: file.id,
        role: "viewer",
      });
      const snapshot = await getArchivedEditorDocument(invitedId, file.id);
      expect(snapshot?.content.nodes.map((node) => node.id)).toContain(frameId);
      expect(await getDocument(invitedId, file.id)).toBeNull();
      await expect(ensureEditorDocument(invitedId, file.id)).rejects.toThrow("access denied");
      const denied = async (userId: string) => {
        expect(await getArchivedEditorDocument(userId, file.id)).toBeNull();
        expect(await getDesignFile(userId, file.id, true, true)).toBeNull();
        expect(await getDocument(userId, file.id)).toBeNull();
        expect(await listDesignFiles(userId, orgId)).toEqual([]);
        expect((await listDesignOrganizations(userId)).some((org) => org.id === orgId)).toBe(false);
        await expect(ensureEditorDocument(userId, file.id)).rejects.toThrow("access denied");
      };
      await denied(outsiderId);
      await db.query('update "user" set "emailVerified"=false where "id"=$1', [invitedId]);
      await denied(invitedId);
      await db.query('update "user" set "emailVerified"=true where "id"=$1', [invitedId]);
      await db.query(
        `update "member" set "role"='viewer,owner' where "organizationId"=$1 and "userId"=$2`,
        [orgId, invitedId],
      );
      await denied(invitedId);
      await db.query('delete from "member" where "organizationId"=$1 and "userId"=$2', [
        orgId,
        invitedId,
      ]);
      await denied(invitedId);
      expect(
        (await db.query('select * from "designDocument" where "fileId"=$1', [file.id])).rows,
      ).toEqual(before);
      // The same service boundary applies to active documents and lazy conversion.
      await db.query('update "designFile" set "archivedAt"=null where "id"=$1', [file.id]);
      await db.query('update "user" set "emailVerified"=false where "id"=$1', [ownerId]);
      await denied(ownerId);
      expect(
        (await db.query('select * from "designDocument" where "fileId"=$1', [file.id])).rows,
      ).toEqual(before);
    },
  );
}

integration(
  "document catch-up and command receipts require current verified membership",
  async () => {
    const { createDesignFileForUser } = await import("../design/service");
    const { ensureEditorDocument } = await import("../design/document-service");
    const { commitDocumentPatch } = await import("../design/commands");
    const { readFileChanges } = await import("../design/changes");
    const { diffDocument } = await import("../design/document-patch");
    const file = await createDesignFileForUser(ownerId, orgId, "Catch-up boundary");
    const initial = await ensureEditorDocument(ownerId, file.id);
    const patch = diffDocument(initial.content, {
      ...initial.content,
      pages: [{ id: "page-1", name: "Changed" }],
    });
    const operationId = crypto.randomUUID();
    const committed = await commitDocumentPatch(
      invitedId,
      file.id,
      operationId,
      initial.revision,
      patch,
      false,
    );
    expect((await readFileChanges(invitedId, file.id, initial.revision))?.patches).toHaveLength(1);
    expect(await readFileChanges(outsiderId, file.id, null)).toBeNull();
    for (const role of ["viewer", "invalid", "owner,admin"]) {
      await db.query('update "member" set "role"=$3 where "organizationId"=$1 and "userId"=$2', [
        orgId,
        invitedId,
        role,
      ]);
      const view = await readFileChanges(invitedId, file.id, null);
      if (role === "viewer") expect(view?.content).not.toBeNull();
      else expect(view).toBeNull();
      await expect(
        commitDocumentPatch(invitedId, file.id, operationId, initial.revision, patch, false),
      ).rejects.toThrow("access denied");
      await expect(
        commitDocumentPatch(invitedId, file.id, crypto.randomUUID(), initial.revision, [], false),
      ).rejects.toThrow("access denied");
    }
    await db.query(
      `update "member" set "role"='editor' where "organizationId"=$1 and "userId"=$2`,
      [orgId, invitedId],
    );
    await db.query('update "user" set "emailVerified"=false where "id"=$1', [invitedId]);
    expect(await readFileChanges(invitedId, file.id, null)).toBeNull();
    await expect(
      commitDocumentPatch(invitedId, file.id, operationId, initial.revision, patch, false),
    ).rejects.toThrow("access denied");
    await expect(
      commitDocumentPatch(invitedId, file.id, crypto.randomUUID(), initial.revision, [], false),
    ).rejects.toThrow("access denied");
    await db.query('update "user" set "emailVerified"=true where "id"=$1', [invitedId]);
    expect(
      (await commitDocumentPatch(invitedId, file.id, operationId, initial.revision, patch, false))
        .committedRevision,
    ).toBe(committed.committedRevision);
    // A missing delta must never look like a complete catch-up response.
    await db.query('delete from "designRealtimeOperation" where "fileId"=$1', [file.id]);
    const fallback = await readFileChanges(invitedId, file.id, initial.revision);
    expect(fallback?.patches).toBeNull();
    expect(fallback?.content).toEqual(committed.snapshot.content);
    await db.query('delete from "member" where "organizationId"=$1 and "userId"=$2', [
      orgId,
      invitedId,
    ]);
    expect(await readFileChanges(invitedId, file.id, null)).toBeNull();
    await expect(
      commitDocumentPatch(invitedId, file.id, crypto.randomUUID(), initial.revision, [], false),
    ).rejects.toThrow("access denied");
  },
);

integration("document edit transport bounds bytes, encodings and aborted streams", async () => {
  const { createDesignFileForUser } = await import("../design/service");
  const { ensureEditorDocument } = await import("../design/document-service");
  const { POST } = await import("../../app/api/files/[uid]/changes/route");
  const file = await createDesignFileForUser(ownerId, orgId, "Bounded edits");
  const initial = await ensureEditorDocument(ownerId, file.id);
  const headers = new Headers(owner);
  headers.set("origin", "http://localhost:3000");
  headers.set("content-type", "application/json");
  const url = `http://localhost:3000/api/files/${file.id}/changes`;
  const context = { params: Promise.resolve({ uid: file.id }) };
  const advertised = new Headers(headers);
  advertised.set("content-length", "2000001");
  expect(
    (await POST(new Request(url, { method: "POST", headers: advertised, body: "{}" }), context))
      .status,
  ).toBe(413);
  expect(
    (
      await POST(
        new Request(url, { method: "POST", headers, body: " ".repeat(2_000_001) }),
        context,
      )
    ).status,
  ).toBe(413);
  const encoded = new Headers(headers);
  encoded.set("content-encoding", "gzip");
  expect(
    (await POST(new Request(url, { method: "POST", headers: encoded, body: "{}" }), context))
      .status,
  ).toBe(415);
  const aborted = new AbortController();
  aborted.abort();
  expect(
    (
      await POST(
        new Request(url, { method: "POST", headers, body: "{}", signal: aborted.signal }),
        context,
      )
    ).status,
  ).toBe(408);
  const accepted = await POST(
    new Request(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        operationId: crypto.randomUUID(),
        patch: [],
        baseRevision: initial.revision,
      }),
    }),
    context,
  );
  expect(accepted.status).toBe(200);
  expect(((await accepted.json()) as { snapshot: { revision: number } }).snapshot.revision).toBe(
    initial.revision + 1,
  );
  await db.query(
    `update "designRealtimeOperation" set "createdAt"=now()-interval '8 days' where "fileId"=$1`,
    [file.id],
  );
  const expired = await POST(
    new Request(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        operationId: crypto.randomUUID(),
        patch: [],
        baseRevision: initial.revision,
      }),
    }),
    context,
  );
  expect(expired.status).toBe(410);
  expect(((await expired.json()) as { code: string }).code).toBe("EDIT_EXPIRED");
});

integration(
  "every comment service rejects unverified, unknown-role, archived and foreign access",
  async () => {
    const comments = await import("../design/comments");
    const { createDesignFileForUser } = await import("../design/service");
    const { ensureEditorDocument } = await import("../design/document-service");
    const file = await createDesignFileForUser(ownerId, orgId, "Comment access");
    await ensureEditorDocument(ownerId, file.id);
    const thread = await comments.createComment(file.id, invitedId, 0, 0, "Original");
    const message = (await comments.listComments(file.id, invitedId))!.threads[0].messages[0].id;
    const denied = async (actor = invitedId) => {
      expect(await comments.listComments(file.id, actor)).toBeNull();
      await expect(comments.createComment(file.id, actor, 0, 0, "Denied")).rejects.toThrow();
      await expect(comments.replyToComment(file.id, thread, actor, "Denied")).rejects.toThrow();
      await expect(
        comments.editComment(file.id, message, actor, "Original", "Denied"),
      ).rejects.toThrow();
      await expect(comments.toggleCommentReaction(file.id, message, actor, "👍")).rejects.toThrow();
      await expect(
        comments.setCommentThreadResolved(file.id, thread, actor, true),
      ).rejects.toThrow();
      await expect(comments.deleteCommentThread(file.id, thread, actor)).rejects.toThrow();
    };
    await denied(outsiderId);
    await db.query('update "user" set "emailVerified"=false where "id"=$1', [invitedId]);
    await denied();
    await db.query('update "user" set "emailVerified"=true where "id"=$1', [invitedId]);
    for (const role of ["invalid", "owner,admin"]) {
      await db.query('update "member" set "role"=$3 where "organizationId"=$1 and "userId"=$2', [
        orgId,
        invitedId,
        role,
      ]);
      await denied();
    }
    await db.query(
      `update "member" set "role"='viewer' where "organizationId"=$1 and "userId"=$2`,
      [orgId, invitedId],
    );
    await db.query('update "designFile" set "archivedAt"=now() where "id"=$1', [file.id]);
    await denied();
    await db.query('update "designFile" set "archivedAt"=null where "id"=$1', [file.id]);
    expect((await comments.listComments(file.id, invitedId))!.threads[0].messages[0].body).toBe(
      "Original",
    );
    await comments.deleteCommentThread(file.id, thread, invitedId);
    expect(
      (
        await db.query(
          `select "content"->'commentPages' as pages from "designDocument" where "fileId"=$1`,
          [file.id],
        )
      ).rows[0].pages,
    ).not.toHaveProperty(thread);
  },
);

integration(
  "comment thread and reply capacity is serialized and deleting a thread releases it",
  async () => {
    const comments = await import("../design/comments");
    const { COMMENT_LIMITS } = await import("../security/resource-limits");
    const { createDesignFileForUser } = await import("../design/service");
    const { ensureEditorDocument } = await import("../design/document-service");
    const file = await createDesignFileForUser(ownerId, orgId, "Comment capacity");
    await ensureEditorDocument(ownerId, file.id);
    await db.query(
      `insert into "designCommentThread" ("id","fileId","x","y","createdBy") select 'capacity-'||n,$1,0,0,$2 from generate_series(1,$3) n`,
      [file.id, ownerId, COMMENT_LIMITS.threadsPerFile - 1],
    );
    const attempts = await Promise.allSettled(
      Array.from({ length: 8 }, () =>
        comments.createComment(file.id, invitedId, 0, 0, "Concurrent"),
      ),
    );
    expect(attempts.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(
      (
        await db.query(
          'select count(*)::int as count from "designCommentThread" where "fileId"=$1',
          [file.id],
        )
      ).rows[0].count,
    ).toBe(COMMENT_LIMITS.threadsPerFile);
    const accepted = attempts.find(
      (result) => result.status === "fulfilled",
    ) as PromiseFulfilledResult<string>;
    await db.query(
      `insert into "designCommentMessage" ("id","threadId","authorId","body") select 'reply-'||n,$1,$2,'Fixture' from generate_series(1,$3) n`,
      [accepted.value, ownerId, COMMENT_LIMITS.messagesPerThread - 2],
    );
    const replies = await Promise.allSettled(
      Array.from({ length: 8 }, () =>
        comments.replyToComment(file.id, accepted.value, invitedId, "Concurrent reply"),
      ),
    );
    expect(replies.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(
      (
        await db.query(
          'select count(*)::int as count from "designCommentMessage" where "threadId"=$1',
          [accepted.value],
        )
      ).rows[0].count,
    ).toBe(COMMENT_LIMITS.messagesPerThread);
    await comments.deleteCommentThread(file.id, accepted.value, invitedId);
    expect(
      await comments.createComment(file.id, invitedId, 0, 0, "Capacity released"),
    ).toBeTruthy();
    await db.query(
      `insert into "designCommentMessage" ("id","threadId","authorId","body") select 'file-message-'||n,'capacity-'||(((n-1)%12)+1),$1,'Fixture' from generate_series(1,$2) n`,
      [ownerId, COMMENT_LIMITS.messagesPerFile - 2],
    );
    const totalAttempts = await Promise.allSettled(
      Array.from({ length: 8 }, () =>
        comments.replyToComment(file.id, "capacity-1", invitedId, "File capacity"),
      ),
    );
    expect(totalAttempts.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(
      (
        await db.query(
          `select count(*)::int as count from "designCommentMessage" c join "designCommentThread" t on t."id"=c."threadId" where t."fileId"=$1`,
          [file.id],
        )
      ).rows[0].count,
    ).toBe(COMMENT_LIMITS.messagesPerFile);
  },
);

integration(
  "reaction admission is bounded per message and file while removals release capacity",
  async () => {
    const comments = await import("../design/comments");
    const { COMMENT_LIMITS } = await import("../security/resource-limits");
    const { COMMENT_EMOJIS } = await import("../design/comment-emoji");
    const { createDesignFileForUser } = await import("../design/service");
    const { ensureEditorDocument } = await import("../design/document-service");
    const file = await createDesignFileForUser(ownerId, orgId, "Reaction capacity");
    await ensureEditorDocument(ownerId, file.id);
    const thread = await comments.createComment(file.id, ownerId, 0, 0, "Reactions");
    const message = (await comments.listComments(file.id, ownerId))!.threads[0].messages[0].id;
    // Model retained reactions from historical members; only the live test actors can mutate.
    await db.query(
      `insert into "user" ("id","name","email","emailVerified") select 'reaction-user-'||n,'Historical member','reaction-'||n||'@example.test',true from generate_series(1,$1) n`,
      [COMMENT_LIMITS.reactionsPerMessage],
    );
    await db.query(
      `insert into "designCommentReaction" ("messageId","userId","emoji") select $1,'reaction-user-'||n,'👍' from generate_series(1,$2) n`,
      [message, COMMENT_LIMITS.reactionsPerMessage - 1],
    );
    const attempts = await Promise.allSettled(
      COMMENT_EMOJIS.map((emoji) =>
        comments.toggleCommentReaction(file.id, message, invitedId, emoji),
      ),
    );
    expect(attempts.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(
      (
        await db.query(
          'select count(*)::int as count from "designCommentReaction" where "messageId"=$1',
          [message],
        )
      ).rows[0].count,
    ).toBe(COMMENT_LIMITS.reactionsPerMessage);
    const accepted = COMMENT_EMOJIS[attempts.findIndex((result) => result.status === "fulfilled")];
    await comments.toggleCommentReaction(file.id, message, invitedId, accepted);
    expect(
      (
        await db.query(
          'select count(*)::int as count from "designCommentReaction" where "messageId"=$1',
          [message],
        )
      ).rows[0].count,
    ).toBe(COMMENT_LIMITS.reactionsPerMessage - 1);
    // Nine more messages fill the file to one below its total ceiling.
    await db.query(
      `insert into "designCommentMessage" ("id","threadId","authorId","body") select 'reaction-message-'||n,$1,$2,'Fixture' from generate_series(1,9) n`,
      [thread, ownerId],
    );
    await db.query(
      `insert into "designCommentReaction" ("messageId","userId","emoji") select 'reaction-message-'||m,'reaction-user-'||u,'👍' from generate_series(1,9) m cross join generate_series(1,$1) u`,
      [COMMENT_LIMITS.reactionsPerMessage],
    );
    await comments.replyToComment(file.id, thread, ownerId, "Fresh message");
    const fresh = (
      await db.query(
        `select "id" from "designCommentMessage" where "threadId"=$1 and "body"='Fresh message'`,
        [thread],
      )
    ).rows[0].id;
    const totalAttempts = await Promise.allSettled(
      COMMENT_EMOJIS.map((emoji) =>
        comments.toggleCommentReaction(file.id, fresh, invitedId, emoji),
      ),
    );
    expect(totalAttempts.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const total = async () =>
      (
        await db.query(
          `select count(*)::int as count from "designCommentReaction" r join "designCommentMessage" c on c."id"=r."messageId" where c."threadId"=$1`,
          [thread],
        )
      ).rows[0].count;
    expect(await total()).toBe(COMMENT_LIMITS.reactionsPerFile);
    await comments.toggleCommentReaction(
      file.id,
      fresh,
      invitedId,
      COMMENT_EMOJIS[totalAttempts.findIndex((result) => result.status === "fulfilled")],
    );
    expect(await total()).toBe(COMMENT_LIMITS.reactionsPerFile - 1);
    await comments.toggleCommentReaction(file.id, fresh, ownerId, "👍");
    expect(await total()).toBe(COMMENT_LIMITS.reactionsPerFile);
  },
);

integration(
  "comment pages preserve precise cursors, survive anchor deletion and isolate file/page/detail reads",
  async () => {
    const { listComments, createComment } = await import("../design/comments");
    const { createDesignFileForUser } = await import("../design/service");
    const { ensureEditorDocument } = await import("../design/document-service");
    const file = await createDesignFileForUser(ownerId, orgId, "Legacy comment pages");
    await ensureEditorDocument(ownerId, file.id);
    const thread = await createComment(file.id, ownerId, 0, 0, "First");
    await db.query(
      `update "designCommentMessage" set "createdAt"='2026-01-01T00:00:00.000000Z' where "threadId"=$1`,
      [thread],
    );
    // Legacy history can exceed new admission ceilings; reads must still be bounded and complete.
    await db.query(
      `insert into "designCommentMessage" ("id","threadId","authorId","body","createdAt")
    select 'pagination-'||n,$1,$2,'Message '||n,'2026-01-01T00:00:00Z'::timestamptz+n*interval '1 microsecond' from generate_series(1,249) n`,
      [thread, ownerId],
    );
    const first = (await listComments(file.id, invitedId, { pageId: "page-1" }))!;
    const messages = (page: NonNullable<Awaited<ReturnType<typeof listComments>>>) =>
      page.threads.flatMap((thread) => thread.messages);
    expect(messages(first)).toHaveLength(100);
    expect(first.nextCursor).toBeTruthy();
    expect(messages(first).at(-1)!.createdAt).toBe("2026-01-01T00:00:00.000099Z");
    await db.query('delete from "designCommentMessage" where "id"=$1', [
      messages(first).at(-1)!.id,
    ]);
    const second = (await listComments(file.id, invitedId, {
      cursor: first.nextCursor!,
      pageId: "page-1",
    }))!;
    const third = (await listComments(file.id, invitedId, {
      cursor: second.nextCursor!,
      pageId: "page-1",
    }))!;
    expect(messages(second)).toHaveLength(100);
    expect(messages(third)).toHaveLength(50);
    expect(third.nextCursor).toBeNull();
    expect(
      new Set(
        [...messages(first), ...messages(second), ...messages(third)].map((message) => message.id),
      ).size,
    ).toBe(250);
    const detail = (await listComments(file.id, invitedId, { threadId: thread }))!;
    expect(messages(detail)).toHaveLength(100);
    expect(messages(detail).at(-1)!.body).toBe("Message 249");
    expect(detail.threads[0].preview?.body).toBe("First");
    expect((await listComments(file.id, invitedId, { pageId: "another-page" }))!.threads).toEqual(
      [],
    );
    const foreign = await createDesignFileForUser(outsiderId, otherId, "Foreign comments");
    await ensureEditorDocument(outsiderId, foreign.id);
    const foreignThread = await createComment(foreign.id, outsiderId, 0, 0, "Private");
    expect(await listComments(foreign.id, invitedId, { cursor: first.nextCursor! })).toBeNull();
    expect((await listComments(file.id, invitedId, { threadId: foreignThread }))!.threads).toEqual(
      [],
    );
    const malformed = Buffer.from(
      JSON.stringify({ at: "2026-02-30T00:00:00.000000Z", id: "x" }),
    ).toString("base64url");
    await expect(listComments(file.id, invitedId, { cursor: malformed })).rejects.toThrow(
      "Invalid comment cursor",
    );
    await db.query(
      `update "designCommentMessage" set "createdAt"='2026-01-01T00:00:00Z' where "threadId"=$1`,
      [thread],
    );
    const tied = new Set<string>();
    let tieCursor: string | undefined;
    for (let page = 0; page < 3; page++) {
      const result = (await listComments(file.id, invitedId, { cursor: tieCursor }))!;
      for (const message of messages(result)) {
        expect(tied.has(message.id)).toBe(false);
        tied.add(message.id);
      }
      tieCursor = result.nextCursor ?? undefined;
    }
    expect(tieCursor).toBeUndefined();
    expect(tied.size).toBe(249);
    const { GET } = await import("../../app/api/files/[uid]/comments/route");
    const response = await GET(
      new Request(`http://localhost:3000/api/files/${file.id}/comments?cursor=bad`, {
        headers: invited,
      }),
      { params: Promise.resolve({ uid: file.id }) },
    );
    expect(response.status).toBe(400);
  },
);

integration(
  "concurrent auth invitations serialize pending capacity and duplicate recipients",
  async () => {
    const { INVITATION_LIMITS } = await import("./invitation-admission");
    await db.query(
      `insert into "invitation" ("id","organizationId","email","role","status","expiresAt","inviterId") select 'pending-'||n,$1,'pending-'||n||'@example.test','viewer','pending',now()+interval '1 day',$2 from generate_series(1,$3) n`,
      [orgId, ownerId, INVITATION_LIMITS.pending - 1],
    );
    const attempts = await Promise.allSettled(
      Array.from({ length: 8 }, (_, index) =>
        auth.api.createInvitation({
          headers: owner,
          body: {
            email: `concurrent-${index}@example.test`,
            role: "viewer",
            organizationId: orgId,
          },
        }),
      ),
    );
    expect(attempts.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(
      (
        await db.query(
          `select count(*)::int as count from "invitation" where "organizationId"=$1 and "status"='pending' and "expiresAt">now()`,
          [orgId],
        )
      ).rows[0].count,
    ).toBe(INVITATION_LIMITS.pending);
    await db.query(`delete from "invitation" where "organizationId"=$1 and "status"='pending'`, [
      orgId,
    ]);
    const duplicate = await Promise.allSettled(
      Array.from({ length: 8 }, () =>
        auth.api.createInvitation({
          headers: owner,
          body: { email: "one-recipient@example.test", role: "viewer", organizationId: orgId },
        }),
      ),
    );
    expect(duplicate.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(
      (
        await db.query(
          `select count(*)::int as count from "invitation" where "organizationId"=$1 and lower("email")='one-recipient@example.test'`,
          [orgId],
        )
      ).rows[0].count,
    ).toBe(1);
  },
);

integration(
  "invitation history is bounded and expiry cleanup stays within the organization",
  async () => {
    const { INVITATION_LIMITS } = await import("./invitation-admission");
    await db.query('delete from "invitation" where "organizationId"=$1', [orgId]);
    await db.query(
      `insert into "invitation" ("id","organizationId","email","role","status","expiresAt","inviterId") select 'retained-'||n,$1,'retained-'||n||'@example.test','viewer','canceled',now()+interval '1 day',$2 from generate_series(1,$3) n`,
      [orgId, ownerId, INVITATION_LIMITS.retained],
    );
    await expect(
      auth.api.createInvitation({
        headers: owner,
        body: { email: "history-limit@example.test", role: "viewer", organizationId: orgId },
      }),
    ).rejects.toThrow("invitation history limit");
    await db.query(
      `update "invitation" set "expiresAt"=now()-interval '31 days' where "organizationId"=$1`,
      [orgId],
    );
    await db.query(
      `insert into "invitation" ("id","organizationId","email","role","status","expiresAt","inviterId") values ('foreign-history',$1,'foreign@example.test','viewer','canceled',now()-interval '31 days',$2)`,
      [otherId, outsiderId],
    );
    const created = await auth.api.createInvitation({
      headers: owner,
      body: { email: "history-limit@example.test", role: "viewer", organizationId: orgId },
    });
    expect(created.id).toBeTruthy();
    expect(
      (
        await db.query(
          'select count(*)::int as count from "invitation" where "organizationId"=$1',
          [orgId],
        )
      ).rows[0].count,
    ).toBe(1);
    expect(
      (await db.query(`select "id" from "invitation" where "id"='foreign-history'`)).rowCount,
    ).toBe(1);
  },
);

for (const revocation of [
  "inviter-role",
  "inviter-verification",
  "recipient-verification",
  "recipient-session",
] as const)
  integration(
    `acceptance rechecks ${revocation} after the invitation status transition`,
    async () => {
      const { changeMemberRole } = await import("./membership");
      const { tryGetCurrentAuthEndpointContext } = await import("@better-auth/core/context");
      await changeMemberRole(ownerId, orgId, await memberId(invitedId), "admin");
      const invitation = await auth.api.createInvitation({
        headers: invited,
        body: { email: "outsider@example.com", role: "editor", organizationId: orgId },
      });
      const adapter = (await auth.$context).adapter;
      const original = adapter.transaction.bind(adapter);
      let revoked = false;
      const transaction = spyOn(adapter, "transaction").mockImplementation(async (callback) => {
        if (
          !revoked &&
          tryGetCurrentAuthEndpointContext()?.path === "/organization/accept-invitation"
        ) {
          expect(
            (await db.query('select "status" from "invitation" where "id"=$1', [invitation.id]))
              .rows[0].status,
          ).toBe("accepted");
          revoked = true;
          if (revocation === "inviter-role")
            await changeMemberRole(ownerId, orgId, await memberId(invitedId), "viewer");
          else if (revocation === "recipient-session")
            await db.query('delete from "session" where "userId"=$1', [outsiderId]);
          else
            await db.query('update "user" set "emailVerified"=false where "id"=$1', [
              revocation === "inviter-verification" ? invitedId : outsiderId,
            ]);
        }
        return original(callback);
      });
      try {
        await expect(
          auth.api.acceptInvitation({ headers: outsider, body: { invitationId: invitation.id } }),
        ).rejects.toThrow("can no longer grant access");
        expect(revoked).toBe(true);
        expect(
          (
            await db.query('select 1 from "member" where "organizationId"=$1 and "userId"=$2', [
              orgId,
              outsiderId,
            ])
          ).rowCount,
        ).toBe(0);
        expect(
          (await db.query('select "status" from "invitation" where "id"=$1', [invitation.id]))
            .rows[0].status,
        ).toBe("pending");
      } finally {
        transaction.mockRestore();
      }
    },
  );

integration(
  "concurrent acceptance of duplicate legacy invitations creates one membership",
  async () => {
    await db.query(
      `insert into "invitation" ("id","organizationId","email","role","status","expiresAt","inviterId")
    values ('accept-a',$1,'outsider@example.com','viewer','pending',now()+interval '1 day',$2),
    ('accept-b',$1,'outsider@example.com','editor','pending',now()+interval '1 day',$2)`,
      [orgId, ownerId],
    );
    const results = await Promise.allSettled(
      ["accept-a", "accept-b"].map((invitationId) =>
        auth.api.acceptInvitation({ headers: outsider, body: { invitationId } }),
      ),
    );
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(
      (
        await db.query('select 1 from "member" where "organizationId"=$1 and "userId"=$2', [
          orgId,
          outsiderId,
        ])
      ).rowCount,
    ).toBe(1);
  },
);

integration("acceptance rolls back membership when the session update fails", async () => {
  const invitation = await auth.api.createInvitation({
    headers: owner,
    body: { email: "outsider@example.com", role: "editor", organizationId: orgId },
  });
  const adapter = (await auth.$context).adapter;
  const original = adapter.update.bind(adapter);
  let failed = false;
  const update = spyOn(adapter, "update").mockImplementation(async (input) => {
    if (input.model === "session" && input.update.activeOrganizationId === orgId) {
      failed = true;
      throw new Error("test session write failure");
    }
    return original(input);
  });
  try {
    await expect(
      auth.api.acceptInvitation({ headers: outsider, body: { invitationId: invitation.id } }),
    ).rejects.toThrow("test session write failure");
    expect(failed).toBe(true);
    expect(
      (
        await db.query('select 1 from "member" where "organizationId"=$1 and "userId"=$2', [
          orgId,
          outsiderId,
        ])
      ).rowCount,
    ).toBe(0);
    expect(
      (await db.query('select "status" from "invitation" where "id"=$1', [invitation.id])).rows[0]
        .status,
    ).toBe("pending");
  } finally {
    update.mockRestore();
  }
});

integration("concurrent acceptance cannot exceed the workspace member ceiling", async () => {
  const { INVITATION_LIMITS } = await import("./invitation-admission");
  const recipient = await account("Last seat", "last-seat@example.test");
  const initial = (
    await db.query('select count(*)::int as count from "member" where "organizationId"=$1', [orgId])
  ).rows[0].count;
  await db.query(
    `insert into "user" ("id","name","email","emailVerified") select 'seat-'||n,'Seat','seat-'||n||'@example.test',true from generate_series(1,$1) n`,
    [INVITATION_LIMITS.members - initial - 1],
  );
  await db.query(
    `insert into "member" ("id","organizationId","userId","role","createdAt") select 'seat-member-'||n,$1,'seat-'||n,'viewer',now() from generate_series(1,$2) n`,
    [orgId, INVITATION_LIMITS.members - initial - 1],
  );
  await db.query(
    `insert into "invitation" ("id","organizationId","email","role","status","expiresAt","inviterId")
    values ('seat-a',$1,'outsider@example.com','viewer','pending',now()+interval '1 day',$2),
    ('seat-b',$1,'last-seat@example.test','viewer','pending',now()+interval '1 day',$2)`,
    [orgId, ownerId],
  );
  const results = await Promise.allSettled([
    auth.api.acceptInvitation({ headers: outsider, body: { invitationId: "seat-a" } }),
    auth.api.acceptInvitation({ headers: recipient.headers, body: { invitationId: "seat-b" } }),
  ]);
  expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  expect(
    (
      await db.query('select count(*)::int as count from "member" where "organizationId"=$1', [
        orgId,
      ])
    ).rows[0].count,
  ).toBe(INVITATION_LIMITS.members);
});

integration(
  "feedback admission requires verification and serializes retained count and bytes",
  async () => {
    const { storeAttachments, readAttachment, FEEDBACK_UPLOAD_LIMITS } =
      await import("../feedback/storage");
    const contextKey = Symbol.for("__cloudflare-context__");
    const runtime = globalThis as unknown as Record<symbol, unknown>;
    const previous = runtime[contextKey];
    let puts = 0,
      gets = 0;
    runtime[contextKey] = {
      env: {
        HYPERDRIVE: { connectionString: testUrl },
        FEEDBACK_IMAGES: {
          put: async () => {
            puts++;
          },
          delete: async () => {},
          get: async () => {
            gets++;
            return { body: "bytes" };
          },
        },
      },
      ctx: { waitUntil() {} },
    };
    const png = new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], "screen.png", {
      type: "image/png",
    });
    try {
      await db.query('update "user" set "emailVerified"=false where "id"=$1', [ownerId]);
      await expect(storeAttachments(ownerId, crypto.randomUUID(), [png])).rejects.toThrow(
        "Verify your email",
      );
      expect(puts).toBe(0);
      await db.query('update "user" set "emailVerified"=true where "id"=$1', [ownerId]);
      await db.query(
        `insert into "feedbackUpload" ("id","userId","fingerprint","attachments","createdAt")
      select gen_random_uuid(),$1,'seed','[]'::jsonb,now()-interval '2 hours' from generate_series(1,$2)`,
        [ownerId, FEEDBACK_UPLOAD_LIMITS.retained - 1],
      );
      const attempts = await Promise.allSettled([
        storeAttachments(ownerId, crypto.randomUUID(), [png]),
        storeAttachments(ownerId, crypto.randomUUID(), [png]),
      ]);
      expect(attempts.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(puts).toBe(1);
      expect(
        (
          await db.query('select count(*)::int as count from "feedbackUpload" where "userId"=$1', [
            ownerId,
          ])
        ).rows[0].count,
      ).toBe(FEEDBACK_UPLOAD_LIMITS.retained);
      // One account's cap does not consume another account's allowance.
      const otherId = crypto.randomUUID();
      const stored = await storeAttachments(outsiderId, otherId, [png]);
      expect(await storeAttachments(outsiderId, otherId, [png])).toEqual(stored);
      expect(puts).toBe(2);
      await expect(storeAttachments(ownerId, otherId, [png])).rejects.toBeDefined();
      expect(puts).toBe(2);
      const staleActor = { id: outsiderId, email: "outsider@example.com", emailVerified: true };
      expect(await readAttachment(staleActor, otherId, 0)).not.toBeNull();
      expect(gets).toBe(1);
      await db.query('update "user" set "emailVerified"=false where "id"=$1', [outsiderId]);
      expect(await readAttachment(staleActor, otherId, 0)).toBeNull();
      expect(gets).toBe(1);
      await db.query('delete from "feedbackUpload" where "userId"=$1', [ownerId]);
      await db.query(
        `insert into "feedbackUpload" ("id","userId","fingerprint","attachments","createdAt") values (gen_random_uuid(),$1,'seed',$2,now()-interval '2 hours')`,
        [ownerId, JSON.stringify([{ size: FEEDBACK_UPLOAD_LIMITS.bytes - 4 }])],
      );
      await expect(storeAttachments(ownerId, crypto.randomUUID(), [png])).rejects.toThrow(
        "storage limit",
      );
      expect(puts).toBe(2);
    } finally {
      if (previous === undefined) delete runtime[contextKey];
      else runtime[contextKey] = previous;
    }
  },
);

for (const limit of ["retained", "hourly"] as const)
  integration(`OAuth registration serializes the final ${limit} slot`, async () => {
    const { OAUTH_CLIENT_LIMITS } = await import("../auth/client-admission");
    await oauthClient("existing-client");
    await consent("existing-client", ownerId);
    await db.query('update "oauthClient" set "createdAt"=now() where "clientId"=$1', [
      "existing-client",
    ]);
    await db.query(
      `insert into "oauthClient" ("id","clientId","redirectUris","createdAt") select 'registered-'||n,'registered-'||n,'[]'::jsonb,
    case when $2 then now() else now()-interval '2 hours' end from generate_series(1,$1) n`,
      [OAUTH_CLIENT_LIMITS[limit] - 2, limit === "hourly"],
    );
    const register = () =>
      auth.handler(
        new Request("http://localhost:3000/api/auth/oauth2/register", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            client_name: "Admission test",
            redirect_uris: ["http://127.0.0.1:4319/callback"],
            token_endpoint_auth_method: "none",
            grant_types: ["authorization_code"],
            response_types: ["code"],
          }),
        }),
      );
    const responses = await Promise.all([register(), register()]);
    expect(responses.map((response) => response.status).sort()).toEqual([201, 429]);
    expect((await db.query('select count(*)::int as count from "oauthClient"')).rows[0].count).toBe(
      OAUTH_CLIENT_LIMITS[limit],
    );
    expect(
      (await db.query(`select "clientId" from "oauthClient" where "clientId"='registered-1'`))
        .rowCount,
    ).toBe(1);
    expect((await issueOAuthToken("existing-client")).access_token).toBeTruthy();
  });

integration("OAuth registration bounds stored metadata before insertion", async () => {
  const response = await auth.handler(
    new Request("http://localhost:3000/api/auth/oauth2/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: "x".repeat(17_000),
        redirect_uris: ["http://127.0.0.1:4319/callback"],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code"],
        response_types: ["code"],
      }),
    }),
  );
  expect(response.status).toBe(400);
  expect((await db.query('select count(*)::int as count from "oauthClient"')).rows[0].count).toBe(
    0,
  );
});

integration(
  "expired-state maintenance reports without writes, bounds batches and preserves live state",
  async () => {
    const { maintainExpiredState } = await import("../security/expired-state");
    const client = await db.connect();
    try {
      await db.query(`insert into "verification" ("id","identifier","value","expiresAt") values
      ('expired-a','cleanup-a','secret',now()-interval '3 days'),
      ('expired-b','cleanup-b','secret',now()-interval '2 days'),
      ('recent-expiry','cleanup-c','secret',now()-interval '1 hour'),
      ('live-verification','cleanup-d','secret',now()+interval '1 day')`);
      await db.query(
        `insert into "designImport" ("id","userId","organizationId","name","expiresAt") values
      ('expired-import',$1,$2,'Expired',now()-interval '8 days'),
      ('live-import',$1,$2,'Live',now()+interval '1 day')`,
        [ownerId, orgId],
      );
      await oauthClient("cleanup-client");
      for (const live of [false, true]) {
        const prefix = live ? "live-cleanup" : "expired-cleanup";
        const expiry = live ? "1 day" : "-10 days";
        await db.query(
          `insert into "session" ("id","token","userId","expiresAt","updatedAt") values ($1,$1,$2,now()+$3::interval,now())`,
          [prefix, ownerId, expiry],
        );
        await db.query(
          `insert into "oauthClientAssertion" ("id","expiresAt") values ($1,now()+$2::interval)`,
          [prefix, expiry],
        );
        for (const table of ["oauthAccessToken", "oauthRefreshToken"] as const) {
          await db.query(
            `insert into "${table}" ("id","token","clientId","userId","expiresAt","createdAt","scopes") values ($1,$1,'cleanup-client',$2,now()+$3::interval,now(),'[]')`,
            [prefix, ownerId, expiry],
          );
        }
      }
      const preview = await maintainExpiredState(client);
      expect(preview.find((row) => row.table === "verification")).toMatchObject({
        eligible: 2,
        removed: 0,
      });
      expect((await db.query(`select 1 from "verification" where "id"='expired-a'`)).rowCount).toBe(
        1,
      );
      const applied = await maintainExpiredState(client, true, 1);
      expect(applied.find((row) => row.table === "verification")).toMatchObject({
        eligible: 2,
        removed: 1,
      });
      expect(applied.find((row) => row.table === "designImport")?.removed).toBe(1);
      for (const table of [
        "session",
        "oauthClientAssertion",
        "oauthAccessToken",
        "oauthRefreshToken",
      ] as const) {
        expect(applied.find((row) => row.table === table)?.removed).toBe(1);
        expect(
          (await db.query(`select 1 from "${table}" where "id"='live-cleanup'`)).rowCount,
        ).toBe(1);
        expect(
          (await db.query(`select 1 from "${table}" where "id"='expired-cleanup'`)).rowCount,
        ).toBe(0);
      }
      expect(
        (
          await db.query(
            `select 1 from "verification" where "id" in ('recent-expiry','live-verification')`,
          )
        ).rowCount,
      ).toBe(2);
      expect(
        (await db.query(`select 1 from "designImport" where "id"='live-import'`)).rowCount,
      ).toBe(1);
      expect(await auth.api.getSession({ headers: owner })).not.toBeNull();
      expect(
        (await maintainExpiredState(client, true, 1)).find((row) => row.table === "verification")
          ?.removed,
      ).toBe(1);
      expect((await maintainExpiredState(client, true, 1)).every((row) => row.removed === 0)).toBe(
        true,
      );
      await expect(maintainExpiredState(client, true, 1001)).rejects.toThrow("Cleanup batch");
    } finally {
      client.release();
    }
  },
);

integration(
  "the exact restricted runtime role supports auth, product, agent and signed webhook writes",
  async () => {
    const { inDatabaseScope } = await import("../database-scope");
    const { createDesignFileForUser } = await import("../design/service");
    const { createComment, replyToComment, listComments } = await import("../design/comments");
    const { createVaultLogin, updateVaultLogin } = await import("../vault/logins");
    const { startAgentRun } = await import("../agents/store");
    const { claimExecution, executeRequest } = await import("../agents/execution");
    const sql = await readFile(
      resolve(import.meta.dir, "../../../../migrations/operations/runtime-grants.sql"),
      "utf8",
    );
    const client = await db.connect();
    try {
      await client.query("begin");
      await client.query(
        "create role tidy_runtime_flows login nosuperuser nobypassrls nocreatedb nocreaterole",
      );
      await client.query("grant pg_read_all_data, pg_write_all_data to tidy_runtime_flows");
      await client.query("select set_config('tidy.runtime_role', 'tidy_runtime_flows', true)");
      await client.query(sql);
      await client.query("set local role tidy_runtime_flows");
      const transactionId = (await client.query("select txid_current()::text as id")).rows[0].id;
      await inDatabaseScope(client, async () => {
        const user = await account("Restricted", "restricted-runtime@example.test");
        const org = await create(user.headers, "Restricted workspace");
        const invitation = await auth.api.createInvitation({
          headers: user.headers,
          body: { organizationId: org.id, email: "outsider@example.com", role: "editor" },
        });
        expect(
          (
            await auth.api.acceptInvitation({
              headers: outsider,
              body: { invitationId: invitation.id },
            })
          ).member.userId,
        ).toBe(outsiderId);
        const registered = await auth.handler(
          new Request("http://localhost:3000/api/auth/oauth2/register", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              client_name: "Restricted MCP",
              redirect_uris: ["http://127.0.0.1:4319/callback"],
              token_endpoint_auth_method: "none",
              grant_types: ["authorization_code", "refresh_token"],
              response_types: ["code"],
            }),
          }),
        );
        expect(registered.status).toBe(201);
        await oauthClient("restricted-authorized-client");
        await consent("restricted-authorized-client", user.id);
        expect(
          (await issueOAuthToken("restricted-authorized-client", user.headers)).access_token,
        ).toBeTruthy();
        const file = await createDesignFileForUser(user.id, org.id, "Restricted file");
        await (await import("../design/document-service")).ensureEditorDocument(user.id, file.id);
        const comment = await createComment(file.id, user.id, 0, 0, "Restricted comment");
        await replyToComment(file.id, comment, outsiderId, "Restricted reply");
        expect((await listComments(file.id, user.id))?.threads[0].messages).toHaveLength(2);
        const login = await createVaultLogin(user.id, "Restricted vault", "account", "secret-test");
        await updateVaultLogin(user.id, login.id, { username: "updated-account" });
        await db.query(
          `insert into "agentConnection" ("id","userId","provider","subject","clientId","accountLabel","status") values ($1,$2,'codex','','codex-managed','restricted','connected')`,
          [crypto.randomUUID(), user.id],
        );
        const started = await startAgentRun(
          user.id,
          {
            requestId: crypto.randomUUID(),
            organizationId: org.id,
            prompt: "Rename the file",
            agentLimit: 1,
            files: [{ id: file.id, selectedNodeIds: [] }],
          },
          "test-model",
        );
        const run = (await claimExecution(crypto.randomUUID()))!;
        expect(run.id).toBe(started.runId);
        await executeRequest({
          action: "tool",
          runId: run.id,
          generation: run.generation,
          agentId: run.workers[0].id,
          callId: "restricted-rename",
          tool: "rename_file",
          arguments: { file_id: file.id, name: "Renamed by restricted agent" },
        });
        await executeRequest({
          action: "finish",
          runId: run.id,
          generation: run.generation,
          status: "completed",
          reason: "complete",
        });
        expect(
          (await db.query('select "status" from "agentRun" where "id"=$1', [run.id])).rows[0]
            .status,
        ).toBe("completed");
        expect(
          (await db.query('select "name" from "designFile" where "id"=$1', [file.id])).rows[0].name,
        ).toBe("Renamed by restricted agent");
        const secretNames = [
          "GITHUB_WEBHOOK_SECRET",
          "LINEAR_WEBHOOK_SECRET",
          "LINEAR_CLIENT_ID",
        ] as const;
        const previous = secretNames.map((name) => testEnvironment[name]);
        try {
          testEnvironment.GITHUB_WEBHOOK_SECRET = "restricted-github-webhook";
          testEnvironment.LINEAR_WEBHOOK_SECRET = "restricted-linear-webhook";
          testEnvironment.LINEAR_CLIENT_ID = "restricted-linear-client";
          await db.query(
            `insert into "githubConnection" ("organizationId","installationId","account") values ($1,4242,'restricted'),($2,4343,'other')`,
            [org.id, otherId],
          );
          const { POST: githubWebhook } = await import("../../app/api/github/webhook/route");
          const githubBody = JSON.stringify({ action: "suspend", installation: { id: 4242 } });
          const githubRequest = (valid: boolean) =>
            new Request("http://localhost:3000/api/github/webhook", {
              method: "POST",
              body: githubBody,
              headers: {
                "x-github-delivery": "restricted-delivery",
                "x-github-event": "installation",
                "x-hub-signature-256":
                  "sha256=" +
                  createHmac("sha256", valid ? testEnvironment.GITHUB_WEBHOOK_SECRET! : "wrong")
                    .update(githubBody)
                    .digest("hex"),
              },
            });
          expect((await githubWebhook(githubRequest(false))).status).toBe(401);
          expect((await githubWebhook(githubRequest(true))).status).toBe(200);
          expect((await githubWebhook(githubRequest(true))).status).toBe(200);
          expect(
            (
              await db.query('select "active" from "githubConnection" where "organizationId"=$1', [
                org.id,
              ])
            ).rows[0].active,
          ).toBe(false);
          expect(
            (
              await db.query('select "active" from "githubConnection" where "organizationId"=$1', [
                otherId,
              ])
            ).rows[0].active,
          ).toBe(true);
          expect(
            (
              await db.query(
                `select 1 from "githubWebhookDelivery" where "id"='restricted-delivery'`,
              )
            ).rowCount,
          ).toBe(1);
          const workspace = crypto.randomUUID(),
            otherWorkspace = crypto.randomUUID();
          await db.query(
            `insert into "connectorAccount" ("id","provider","userId","externalWorkspaceId","externalUserId","workspaceName","accountName","credentials","scopes","expiresAt")
          values (gen_random_uuid(),'linear',$1,$2,'external-user','Workspace','Account','{}','{}',now()+interval '1 hour'),
          (gen_random_uuid(),'linear',$1,$3,'external-user','Other','Account','{}','{}',now()+interval '1 hour')`,
            [user.id, workspace, otherWorkspace],
          );
          const { POST: linearWebhook } = await import("../../app/api/linear/webhook/route");
          const linearBody = JSON.stringify({
            type: "OAuthApp",
            action: "revoked",
            organizationId: workspace,
            oauthClientId: testEnvironment.LINEAR_CLIENT_ID,
            webhookTimestamp: Date.now(),
          });
          const delivery = crypto.randomUUID();
          const linearRequest = (valid: boolean) =>
            new Request("http://localhost:3000/api/linear/webhook", {
              method: "POST",
              body: linearBody,
              headers: {
                "linear-delivery": delivery,
                "linear-signature": createHmac(
                  "sha256",
                  valid ? testEnvironment.LINEAR_WEBHOOK_SECRET! : "wrong",
                )
                  .update(linearBody)
                  .digest("hex"),
              },
            });
          expect((await linearWebhook(linearRequest(false))).status).toBe(401);
          expect((await linearWebhook(linearRequest(true))).status).toBe(200);
          expect((await linearWebhook(linearRequest(true))).status).toBe(200);
          expect(
            (
              await db.query(
                'select "state","credentials" from "connectorAccount" where "externalWorkspaceId"=$1',
                [workspace],
              )
            ).rows[0],
          ).toEqual({ state: "reconnect", credentials: null });
          expect(
            (
              await db.query(
                'select "state" from "connectorAccount" where "externalWorkspaceId"=$1',
                [otherWorkspace],
              )
            ).rows[0].state,
          ).toBe("connected");
          expect(
            (await db.query('select 1 from "connectorWebhookDelivery" where "id"=$1', [delivery]))
              .rowCount,
          ).toBe(1);
        } finally {
          secretNames.forEach((name, index) => {
            if (previous[index] === undefined) delete testEnvironment[name];
            else testEnvironment[name] = previous[index];
          });
        }
        expect(
          (await db.query("select current_user as role, txid_current()::text as id")).rows[0],
        ).toEqual({ role: "tidy_runtime_flows", id: transactionId });
      });
    } finally {
      await client.query("rollback");
      client.release();
    }
    expect(
      (await db.query(`select 1 from pg_roles where rolname='tidy_runtime_flows'`)).rowCount,
    ).toBe(0);
  },
);

integration(
  "signed Stripe reconciliation works under restricted grants and preserves tenant/customer binding",
  async () => {
    const { inDatabaseScope } = await import("../database-scope");
    const { stripe } = await import("../billing/server");
    const { POST } = await import("../../app/api/billing/webhook/route");
    const names = ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "STRIPE_PRO_PRICE_ID"] as const;
    const previous = names.map((name) => testEnvironment[name]);
    testEnvironment.STRIPE_SECRET_KEY = "sk_test_disposable_runtime";
    testEnvironment.STRIPE_WEBHOOK_SECRET = "whsec_disposable_runtime";
    testEnvironment.STRIPE_PRO_PRICE_ID = "price_restricted_runtime";
    const stripeClient = stripe();
    const subscription = {
      id: "sub_restricted_runtime",
      customer: "cus_restricted",
      metadata: { organizationId: orgId },
      status: "active",
      created: Math.floor(Date.now() / 1000),
      cancel_at_period_end: false,
      items: {
        data: [
          {
            price: { id: "price_restricted_runtime" },
            current_period_end: Math.floor(Date.now() / 1000) + 86400,
          },
        ],
      },
    } as unknown as Awaited<ReturnType<typeof stripeClient.subscriptions.retrieve>>;
    const retrieve = spyOn(stripeClient.subscriptions, "retrieve").mockResolvedValue(subscription);
    const logged = spyOn(console, "error").mockImplementation(() => {});
    const client = await db.connect();
    try {
      await client.query("begin");
      await client.query(
        'insert into "billingPlanPrice" ("priceId") values ($1) on conflict do nothing',
        ["price_restricted_runtime"],
      );
      await client.query(
        `insert into "organization_billing" ("organizationId","stripeCustomerId") values ($1,'cus_restricted'),($2,'cus_other') on conflict ("organizationId") do update set "stripeCustomerId"=excluded."stripeCustomerId"`,
        [orgId, otherId],
      );
      await client.query(
        "create role tidy_runtime_billing login nosuperuser nobypassrls nocreatedb nocreaterole",
      );
      await client.query("select set_config('tidy.runtime_role', 'tidy_runtime_billing', true)");
      await client.query(
        await readFile(
          resolve(import.meta.dir, "../../../../migrations/operations/runtime-grants.sql"),
          "utf8",
        ),
      );
      await client.query("set local role tidy_runtime_billing");
      const body = JSON.stringify({
        id: "evt_restricted",
        object: "event",
        type: "customer.subscription.updated",
        data: { object: { id: subscription.id } },
      });
      const request = (valid = true) => {
        const timestamp = Math.floor(Date.now() / 1000);
        const signature = createHmac(
          "sha256",
          valid ? testEnvironment.STRIPE_WEBHOOK_SECRET! : "wrong",
        )
          .update(`${timestamp}.${body}`)
          .digest("hex");
        return new Request("http://localhost:3000/api/billing/webhook", {
          method: "POST",
          body,
          headers: { "stripe-signature": `t=${timestamp},v1=${signature}` },
        });
      };
      await inDatabaseScope(client, async () => {
        expect((await POST(request(false))).status).toBe(401);
        expect(retrieve).not.toHaveBeenCalled();
        expect((await POST(request())).status).toBe(200);
        expect((await POST(request())).status).toBe(200);
        expect(
          (
            await db.query(
              'select "stripeStatus","stripeSubscriptionId" from "organization_billing" where "organizationId"=$1',
              [orgId],
            )
          ).rows[0],
        ).toEqual({ stripeStatus: "active", stripeSubscriptionId: subscription.id });
        expect(
          (
            await db.query(
              'select "stripeSubscriptionId" from "organization_billing" where "organizationId"=$1',
              [otherId],
            )
          ).rows[0].stripeSubscriptionId,
        ).toBeNull();
        subscription.customer = "cus_other";
        subscription.status = "canceled";
        expect((await POST(request())).status).toBe(503);
        expect(
          (
            await db.query(
              'select "stripeStatus" from "organization_billing" where "organizationId"=$1',
              [orgId],
            )
          ).rows[0].stripeStatus,
        ).toBe("active");
        testEnvironment.STRIPE_PRO_PRICE_ID = "price_not_enrolled_runtime";
        expect((await POST(request())).status).toBe(503);
        expect(
          (
            await db.query('select 1 from "billingPlanPrice" where "priceId"=$1', [
              testEnvironment.STRIPE_PRO_PRICE_ID,
            ])
          ).rowCount,
        ).toBe(0);
        expect((await db.query("select current_user as role")).rows[0].role).toBe(
          "tidy_runtime_billing",
        );
      });
    } finally {
      await client.query("rollback");
      client.release();
      retrieve.mockRestore();
      logged.mockRestore();
      names.forEach((name, index) => {
        if (previous[index] === undefined) delete testEnvironment[name];
        else testEnvironment[name] = previous[index];
      });
    }
  },
);

integration(
  "webhook boundaries reject oversized, encoded and canceled payloads before processing",
  async () => {
    const handlers = [
      (await import("../../app/api/github/webhook/route")).POST,
      (await import("../../app/api/linear/webhook/route")).POST,
      (await import("../../app/api/billing/webhook/route")).POST,
    ];
    const names = [
      "GITHUB_WEBHOOK_SECRET",
      "LINEAR_WEBHOOK_SECRET",
      "STRIPE_WEBHOOK_SECRET",
    ] as const;
    const previous = names.map((name) => testEnvironment[name]);
    names.forEach((name) => {
      testEnvironment[name] = "disposable-webhook-secret";
    });
    try {
      for (const handler of handlers) {
        let canceled = false;
        const body = new ReadableStream({
          pull(controller) {
            controller.enqueue(new Uint8Array(1024 * 1024 + 1));
          },
          cancel() {
            canceled = true;
          },
        });
        expect(
          (
            await handler(
              new Request("http://localhost:3000/webhook", {
                method: "POST",
                body,
                duplex: "half",
              } as RequestInit),
            )
          ).status,
        ).toBe(413);
        expect(canceled).toBe(true);
        expect(
          (
            await handler(
              new Request("http://localhost:3000/webhook", {
                method: "POST",
                headers: { "Content-Encoding": "gzip" },
                body: "encoded",
              }),
            )
          ).status,
        ).toBe(415);
        const abort = new AbortController();
        const stalled = new ReadableStream({
          cancel() {
            canceled = true;
          },
        });
        canceled = false;
        const reading = handler(
          new Request("http://localhost:3000/webhook", {
            method: "POST",
            body: stalled,
            signal: abort.signal,
            duplex: "half",
          } as RequestInit),
        );
        abort.abort();
        expect((await reading).status).toBe(408);
        expect(canceled).toBe(true);
      }
    } finally {
      names.forEach((name, index) => {
        if (previous[index] === undefined) delete testEnvironment[name];
        else testEnvironment[name] = previous[index];
      });
    }
  },
);

for (const state of ["unverified", "unknown-role", "removed", "foreign"] as const) {
  integration(`shared design services reject ${state} actors without writes`, async () => {
    const files = await import("../design/service");
    const folders = await import("../design/folder-service");
    const docs = await import("../design/document-service");
    const { getFileImage } = await import("../design/file-image");
    const { buildDrawnNode } = await import("../design/document");
    const file = await files.createDesignFileForUser(ownerId, orgId, "Protected canvas");
    const archived = await files.createDesignFileForUser(ownerId, orgId, "Protected archive");
    await db.query('update "designFile" set "archivedAt"=now() where "id"=$1', [archived.id]);
    const folder = await folders.createDesignFolderForUser(ownerId, orgId, "Protected folder");
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString("base64");
    const asset = await docs.putAsset(ownerId, orgId, "image/svg+xml", svg);
    const initial = await docs.ensureEditorDocument(ownerId, file.id);
    const node = {
      ...buildDrawnNode(crypto.randomUUID(), "container", null, {
        x: 0,
        y: 0,
        width: 100,
        height: 100,
      }),
      type: "image" as const,
      assetId: asset.assetId,
    };
    const content = { ...initial.content, nodes: [node] };
    const saved = await docs.replaceDocumentForHistory(ownerId, file.id, initial.revision, content);
    const staging = await docs.createImport(invitedId, orgId, "Owned import");
    await docs.putImportChunk(invitedId, staging.importId, "one", [node]);
    if (state === "unverified")
      await db.query('update "user" set "emailVerified"=false where "id"=$1', [invitedId]);
    if (state === "unknown-role")
      await db.query('update "member" set "role"=\'editor,owner\' where "userId"=$1', [invitedId]);
    if (state === "removed") await db.query('delete from "member" where "userId"=$1', [invitedId]);
    const actor = state === "foreign" ? outsiderId : invitedId;
    const snapshot = async () =>
      (
        await db.query(`select jsonb_build_object(
      'files',(select jsonb_agg(f order by "id") from "designFile" f),
      'folders',(select jsonb_agg(f order by "id") from "designFolder" f),
      'documents',(select jsonb_agg(d order by "fileId") from "designDocument" d),
      'imports',(select jsonb_agg(i order by "id") from "designImport" i),
      'assets',(select jsonb_agg(a order by "id") from "designAsset" a)
    ) as value`)
      ).rows[0].value;
    const before = await snapshot();
    expect(await folders.listDesignFolders(actor, orgId)).toEqual([]);
    expect(await files.getDesignFile(actor, file.id)).toBeNull();
    const denied = [
      () => files.createDesignFileForUser(actor, orgId, "Denied"),
      () => files.renameDesignFileForUser(actor, file.id, "Denied"),
      () => files.deleteArchivedDesignFileForUser(actor, archived.id),
      () => folders.createDesignFolderForUser(actor, orgId, "Denied"),
      () => folders.renameDesignFolderForUser(actor, folder.id, "Denied"),
      () => folders.moveDesignFileForUser(actor, file.id, folder.id),
      () => folders.deleteDesignFolderForUser(actor, folder.id),
      () => docs.createImport(actor, orgId, "Denied", file.id),
      () => docs.putImportChunk(actor, staging.importId, "two", [node]),
      () => docs.validateImport(actor, staging.importId),
      () => docs.commitImport(actor, staging.importId),
      () => docs.putAsset(actor, orgId, "image/svg+xml", svg), // Includes dedup retry.
      () => docs.replaceDocumentForHistory(actor, file.id, saved.revision, content),
      () => docs.patchDocumentNode(actor, file.id, saved.revision, node.id, { name: "Denied" }),
      () => docs.addDocumentNode(actor, file.id, saved.revision, null, "text"),
      () =>
        docs.drawDocumentNode(actor, file.id, saved.revision, crypto.randomUUID(), "text", null, {
          x: 0,
          y: 0,
          width: 100,
          height: 100,
        }),
      () => docs.deleteDocumentNode(actor, file.id, saved.revision, node.id),
      () => docs.duplicateDocumentNode(actor, file.id, saved.revision, node.id),
      () => docs.getExportAssets(actor, [asset.assetId]),
      () => getFileImage(actor, file.id, asset.assetId),
    ];
    for (const work of denied) await expect(work()).rejects.toThrow();
    expect((await docs.abortImport(actor, staging.importId)).aborted).toBe(false);
    expect(await snapshot()).toEqual(before);
  });
}

integration("committed import retries require the current same-tenant active file", async () => {
  const docs = await import("../design/document-service");
  const { buildDrawnNode } = await import("../design/document");
  const staged = await docs.createImport(invitedId, orgId, "Idempotent import");
  await docs.putImportChunk(invitedId, staged.importId, "one", [
    buildDrawnNode(crypto.randomUUID(), "artboard", null, { x: 0, y: 0, width: 200, height: 200 }),
  ]);
  const result = await docs.commitImport(invitedId, staged.importId);
  expect(await docs.commitImport(invitedId, staged.importId)).toMatchObject({
    fileId: result.fileId,
    alreadyCommitted: true,
  });
  await db.query('update "designFile" set "archivedAt"=now() where "id"=$1', [result.fileId]);
  await expect(docs.commitImport(invitedId, staged.importId)).rejects.toThrow("access denied");
  await db.query('update "designFile" set "archivedAt"=null,"organizationId"=$2 where "id"=$1', [
    result.fileId,
    otherId,
  ]);
  await expect(docs.commitImport(invitedId, staged.importId)).rejects.toThrow("access denied");
});

integration(
  "exports measure bigint totals before reading R2, allow viewers and bound actual bytes",
  async () => {
    const { getExportAssets, putAsset } = await import("../design/document-service");
    const first = await putAsset(
      ownerId,
      orgId,
      "image/svg+xml",
      Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString("base64"),
    );
    const second = await putAsset(
      ownerId,
      orgId,
      "image/svg+xml",
      Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>').toString("base64"),
    );
    await db.query('update "member" set "role"=\'viewer\' where "userId"=$1', [invitedId]);
    expect(await getExportAssets(invitedId, [first.assetId, first.assetId])).toHaveLength(1);
    const symbol = Symbol.for("__cloudflare-context__");
    const globals = globalThis as unknown as Record<symbol, unknown>;
    const previous = globals[symbol];
    let gets = 0;
    let actual = Buffer.from("bounded original");
    globals[symbol] = {
      env: {
        HYPERDRIVE: { connectionString: testUrl },
        DESIGN_OBJECTS: {
          get: async () => {
            gets++;
            return { size: 1, body: new Response(actual).body };
          },
        },
      },
      ctx: {},
    };
    try {
      await db.query(
        `update "designAsset" set "body"=null,"objectKey"="id","byteSize"=case when "id"=$1 then 8000000 else 4100000 end where "id"=any($2::text[])`,
        [first.assetId, [first.assetId, second.assetId]],
      );
      await expect(getExportAssets(invitedId, [first.assetId, second.assetId])).rejects.toThrow(
        "12 MB",
      );
      expect(gets).toBe(0);
      await expect(getExportAssets(invitedId, Array(1001).fill(first.assetId))).rejects.toThrow(
        "too many assets",
      );
      expect(gets).toBe(0);
      await db.query('update "designAsset" set "byteSize"=1 where "id"=any($1::text[])', [
        [first.assetId, second.assetId],
      ]);
      expect((await getExportAssets(invitedId, [first.assetId]))[0].base64).toBe(
        actual.toString("base64"),
      );
      // Metadata deliberately understates size: streamed bytes must still enforce the ceiling.
      actual = Buffer.alloc(12_000_001);
      await expect(getExportAssets(invitedId, [first.assetId])).rejects.toThrow("too large");
      // Simulate an unmetered legacy row; current write triggers correctly reject creating one.
      await db.query('alter table "designAsset" disable trigger "designAsset_plan"');
      try {
        await db.query('update "designAsset" set "byteSize"=null where "id"=$1', [first.assetId]);
      } finally {
        await db.query('alter table "designAsset" enable trigger "designAsset_plan"');
      }
      const before = gets;
      await expect(getExportAssets(invitedId, [first.assetId])).rejects.toThrow("unknown sizes");
      expect(gets).toBe(before);
      await db.query('update "user" set "emailVerified"=false where "id"=$1', [invitedId]);
      await expect(getExportAssets(invitedId, [second.assetId])).rejects.toThrow("inaccessible");
      expect(gets).toBe(before);
    } finally {
      if (previous === undefined) delete globals[symbol];
      else globals[symbol] = previous;
    }
  },
);

for (const revoke of ["role", "verification"] as const) {
  integration(
    `an admitted asset upload excludes concurrent ${revoke} revocation until outer publication`,
    async () => {
      const { putAsset } = await import("../design/document-service");
      const { inDatabaseScope } = await import("../database-scope");
      const { Client } = await import("pg");
      const actor = await db.connect();
      const revoker = new Client({ connectionString: testUrl });
      const observer = new Client({ connectionString: testUrl });
      await Promise.all([revoker.connect(), observer.connect()]);
      let entered!: () => void, finish!: () => void;
      const uploading = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const released = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const symbol = Symbol.for("__cloudflare-context__");
      const globals = globalThis as unknown as Record<symbol, unknown>;
      const previous = globals[symbol];
      let puts = 0,
        pending: Promise<unknown> | undefined;
      globals[symbol] = {
        env: {
          HYPERDRIVE: { connectionString: testUrl },
          DESIGN_OBJECTS: {
            put: async () => {
              puts++;
              entered();
              await released;
              return { etag: "fixture" };
            },
          },
        },
        ctx: {},
      };
      try {
        await actor.query("begin");
        const pid = (await revoker.query("select pg_backend_pid() as pid")).rows[0].pid;
        await revoker.query("set lock_timeout='3s'");
        await inDatabaseScope(actor, async () => {
          const upload = putAsset(
            invitedId,
            orgId,
            "image/svg+xml",
            Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString("base64"),
          );
          await uploading;
          pending =
            revoke === "role"
              ? revoker.query(
                  'update "member" set "role"=\'viewer\' where "userId"=$1 and "organizationId"=$2',
                  [invitedId, orgId],
                )
              : revoker.query('update "user" set "emailVerified"=false where "id"=$1', [invitedId]);
          let blocked = false;
          for (let attempt = 0; attempt < 60 && !blocked; attempt++) {
            blocked = (
              await observer.query("select cardinality(pg_blocking_pids($1))>0 as blocked", [pid])
            ).rows[0].blocked;
            if (!blocked) await Bun.sleep(5);
          }
          expect(blocked).toBe(true);
          finish();
          const asset = await upload;
          expect(
            (await actor.query('select "id" from "designAsset" where "id"=$1', [asset.assetId]))
              .rowCount,
          ).toBe(1);
          expect(
            (await observer.query("select cardinality(pg_blocking_pids($1))>0 as blocked", [pid]))
              .rows[0].blocked,
          ).toBe(true);
        });
        await actor.query("commit");
        await pending;
        expect(puts).toBe(1);
        await expect(
          putAsset(
            invitedId,
            orgId,
            "image/svg+xml",
            Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString("base64"),
          ),
        ).rejects.toThrow("access denied");
        expect(puts).toBe(1);
      } finally {
        finish();
        await actor.query("rollback").catch(() => {});
        await pending?.catch(() => {});
        actor.release();
        await Promise.all([revoker.end(), observer.end()]);
        if (previous === undefined) delete globals[symbol];
        else globals[symbol] = previous;
      }
    },
  );
}

integration(
  "verified editor services preserve allowed document, image, folder and import workflows",
  async () => {
    const files = await import("../design/service");
    const folders = await import("../design/folder-service");
    const docs = await import("../design/document-service");
    const { getFileImage } = await import("../design/file-image");
    const { buildDrawnNode } = await import("../design/document");
    await db.query('update "member" set "role"=\'editor\' where "userId"=$1', [invitedId]);
    const folder = await folders.createDesignFolderForUser(invitedId, orgId, "Editor folder");
    expect(
      (await folders.renameDesignFolderForUser(invitedId, folder.id, "Renamed folder")).name,
    ).toBe("Renamed folder");
    const file = await files.createDesignFileForUser(invitedId, orgId, "Editor file");
    expect((await files.renameDesignFileForUser(invitedId, file.id, "Renamed file")).name).toBe(
      "Renamed file",
    );
    expect((await folders.moveDesignFileForUser(invitedId, file.id, folder.id)).folderId).toBe(
      folder.id,
    );
    // Managed tools compose metadata reads with writes inside an enclosing transaction.
    const { inDatabaseScope } = await import("../database-scope");
    const scoped = await db.connect();
    try {
      await scoped.query("begin");
      const transaction = (await scoped.query("select txid_current()::text as id")).rows[0].id;
      await inDatabaseScope(scoped, async () => {
        expect((await files.getDesignFile(invitedId, file.id, false))?.id).toBe(file.id);
      });
      expect((await scoped.query("select txid_current()::text as id")).rows[0].id).toBe(
        transaction,
      );
      await scoped.query("rollback");
    } finally {
      scoped.release();
    }
    const initial = await docs.ensureEditorDocument(invitedId, file.id);
    const added = await docs.addDocumentNode(invitedId, file.id, initial.revision, null, "text");
    const patched = await docs.patchDocumentNode(
      invitedId,
      file.id,
      added.revision,
      added.node.id,
      { text: "Changed" },
    );
    expect(patched.node?.text).toBe("Changed");
    const duplicate = await docs.duplicateDocumentNode(
      invitedId,
      file.id,
      patched.revision,
      added.node.id,
    );
    expect(duplicate.document.nodes).toHaveLength(2);
    const drawn = await docs.drawDocumentNode(
      invitedId,
      file.id,
      duplicate.revision,
      crypto.randomUUID(),
      "container",
      null,
      { x: 300, y: 300, width: 100, height: 100 },
    );
    const deleted = await docs.deleteDocumentNode(
      invitedId,
      file.id,
      drawn.revision,
      drawn.node.id,
    );
    expect(deleted.document.nodes).toHaveLength(2);
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"/>';
    const asset = await docs.putAsset(
      invitedId,
      orgId,
      "image/svg+xml",
      Buffer.from(svg).toString("base64"),
    );
    const image = {
      ...buildDrawnNode(crypto.randomUUID(), "container", null, {
        x: 0,
        y: 0,
        width: 100,
        height: 100,
      }),
      type: "image" as const,
      assetId: asset.assetId,
    };
    const content = { ...deleted.document, nodes: [...deleted.document.nodes, image] };
    const replaced = await docs.replaceDocumentForHistory(
      invitedId,
      file.id,
      deleted.revision,
      content,
    );
    expect((await getFileImage(invitedId, file.id, asset.assetId)).base64).toBe(
      Buffer.from(svg).toString("base64"),
    );
    expect((await docs.getExportAssets(invitedId, [asset.assetId]))[0].base64).toBe(
      Buffer.from(svg).toString("base64"),
    );
    const staged = await docs.createImport(invitedId, orgId, "Existing file import", file.id);
    expect(staged.expectedRevision).toBe(replaced.revision);
    await docs.putImportChunk(
      invitedId,
      staged.importId,
      "one",
      [
        buildDrawnNode(crypto.randomUUID(), "artboard", null, {
          x: 600,
          y: 0,
          width: 200,
          height: 200,
        }),
      ],
      { project: "fixture", route: "/editor" },
    );
    expect((await docs.validateImport(invitedId, staged.importId)).layout.valid).toBe(true);
    const committed = await docs.commitImport(invitedId, staged.importId);
    expect(committed.fileId).toBe(file.id);
    const abandoned = await docs.createImport(invitedId, orgId, "Abortable");
    expect((await docs.abortImport(invitedId, abandoned.importId)).aborted).toBe(true);
    expect((await folders.deleteDesignFolderForUser(invitedId, folder.id)).unfiledFileCount).toBe(
      1,
    );
    expect((await files.getDesignFile(invitedId, file.id))?.folderId).toBeNull();
    await db.query('update "designFile" set "archivedAt"=now() where "id"=$1', [file.id]);
    await files.deleteArchivedDesignFileForUser(invitedId, file.id);
    expect(await files.getDesignFile(invitedId, file.id, false, true)).toBeNull();
  },
);

integration(
  "revocation while waiting for storage admission prevents both R2 and object claims",
  async () => {
    const { putAsset } = await import("../design/document-service");
    const { inDatabaseScope } = await import("../database-scope");
    const { Client } = await import("pg");
    const actor = await db.connect();
    const blocker = new Client({ connectionString: testUrl });
    await blocker.connect();
    const symbol = Symbol.for("__cloudflare-context__");
    const globals = globalThis as unknown as Record<symbol, unknown>;
    const previous = globals[symbol];
    let puts = 0;
    globals[symbol] = {
      env: {
        HYPERDRIVE: { connectionString: testUrl },
        DESIGN_OBJECTS: {
          put: async () => {
            puts++;
            return { etag: "fixture" };
          },
        },
      },
      ctx: {},
    };
    let pending: Promise<unknown> | undefined;
    try {
      await actor.query("begin");
      const pid = (await actor.query("select pg_backend_pid() as pid")).rows[0].pid;
      await blocker.query("begin");
      await blocker.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [orgId]);
      pending = inDatabaseScope(actor, async () => {
        try {
          await putAsset(
            invitedId,
            orgId,
            "image/svg+xml",
            Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString("base64"),
          );
          return "unexpected success";
        } catch (error) {
          return error;
        }
      });
      let blocked = false;
      for (let attempt = 0; attempt < 60 && !blocked; attempt++) {
        blocked = (
          await blocker.query("select cardinality(pg_blocking_pids($1))>0 as blocked", [pid])
        ).rows[0].blocked;
        if (!blocked) await Bun.sleep(5);
      }
      expect(blocked).toBe(true);
      await db.query('update "user" set "emailVerified"=false where "id"=$1', [invitedId]);
      await blocker.query("commit");
      const { value } = (await pending) as { value: Error };
      expect(value.message).toContain("access denied");
      await actor.query("rollback");
      expect(puts).toBe(0);
      expect(
        (await db.query('select 1 from "designObject" where "organizationId"=$1', [orgId]))
          .rowCount,
      ).toBe(0);
      expect(
        (await db.query('select 1 from "designAsset" where "organizationId"=$1', [orgId])).rowCount,
      ).toBe(0);
    } finally {
      await blocker.query("rollback").catch(() => {});
      await pending?.catch(() => {});
      await actor.query("rollback").catch(() => {});
      actor.release();
      await blocker.end();
      if (previous === undefined) delete globals[symbol];
      else globals[symbol] = previous;
    }
  },
);

integration(
  "file-targeted staging rejects archived or substituted parents and still permits owned cleanup",
  async () => {
    const { createDesignFileForUser } = await import("../design/service");
    const docs = await import("../design/document-service");
    const { buildDrawnNode } = await import("../design/document");
    const file = await createDesignFileForUser(ownerId, orgId, "Import target");
    const staged = await docs.createImport(invitedId, orgId, "Targeted import", file.id);
    const nodes = [
      buildDrawnNode(crypto.randomUUID(), "artboard", null, {
        x: 0,
        y: 0,
        width: 200,
        height: 200,
      }),
    ];
    await docs.putImportChunk(invitedId, staged.importId, "one", nodes);
    for (const substitute of [false, true]) {
      if (substitute)
        await db.query(
          'update "designFile" set "archivedAt"=null,"organizationId"=$2 where "id"=$1',
          [file.id, otherId],
        );
      else await db.query('update "designFile" set "archivedAt"=now() where "id"=$1', [file.id]);
      await expect(docs.putImportChunk(invitedId, staged.importId, "two", nodes)).rejects.toThrow(
        "Import unavailable",
      );
      await expect(docs.validateImport(invitedId, staged.importId)).rejects.toThrow(
        "Import not found",
      );
      await expect(docs.commitImport(invitedId, staged.importId)).rejects.toThrow("access denied");
      expect(
        (
          await db.query(
            'select jsonb_object_keys("chunks") as key from "designImport" where "id"=$1',
            [staged.importId],
          )
        ).rows,
      ).toEqual([{ key: "one" }]);
    }
    expect((await docs.abortImport(invitedId, staged.importId)).aborted).toBe(true);
    expect(
      (
        await db.query('select "status","chunks" from "designImport" where "id"=$1', [
          staged.importId,
        ])
      ).rows[0],
    ).toEqual({ status: "aborted", chunks: {} });
  },
);
