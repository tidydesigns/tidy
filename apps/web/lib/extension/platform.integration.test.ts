import { afterAll, beforeAll, beforeEach, expect, mock, test } from "bun:test";
import { createHmac } from "node:crypto";
import { Client } from "pg";
import { db } from "../db";
import { blankDesignDocument, type DesignNode } from "@tidy/design/document";
import { extensionAccountSchema, importResultSchema } from "@tidy/design/web-capture";
import { DEVELOPMENT_EXTENSION_ID } from "@tidy/design/extension";
mock.module("server-only", () => ({}));
const { submitCapture } = await import("./submit");
const { captureReceipt } = await import("./receipts");
const { importWebCapture } = await import("../design/web-capture-service");
const documentServices = await import("../design/document-service");
const { POST } = await import("../../app/api/extension/import/route");
const { GET: account } = await import("../../app/api/extension/account/route");
const { GET: receipt } = await import("../../app/api/extension/import/[id]/route");
const { auth } = await import("../auth");
const testUrl = process.env.EXTENSION_TEST_DATABASE_URL;
const setupUrl = process.env.EXTENSION_SETUP_DATABASE_URL;
const enabled = Boolean(
  testUrl &&
  setupUrl &&
  process.env.DATABASE_URL === testUrl &&
  new URL(testUrl).hostname === "127.0.0.1" &&
  new URL(setupUrl).hostname === "127.0.0.1" &&
  new URL(testUrl).pathname === "/tidy_extension_test" &&
  new URL(setupUrl).pathname === "/tidy_extension_test" &&
  new URL(testUrl).port === new URL(setupUrl).port,
);
const integration = enabled ? test : test.skip;
let admin: Client;
let cookie: string;
const previousIds = process.env.BELLA_EXTENSION_IDS;
const fileId = "00000000-0000-4000-8000-000000000001";
const foreignId = "00000000-0000-4000-8000-000000000002";
const frame: DesignNode = {
  id: "frame",
  parentId: null,
  type: "artboard",
  name: "Frame",
  box: { x: 0, y: 0, width: 100, height: 100 },
  style: {},
  layout: "absolute",
  visible: true,
  locked: false,
};
function input(existing = false) {
  return {
    request: { id: crypto.randomUUID(), createdAt: Date.now() },
    userId: "editor",
    organizationId: "a",
    ...(existing ? { fileId } : {}),
    capture: {
      title: "Captured",
      url: "https://example.test/page",
      mode: "page",
      document: { ...blankDesignDocument(), nodes: [frame] },
      assets: [],
    },
  };
}
function request(
  path: string,
  body?: unknown,
  origin = `chrome-extension://${DEVELOPMENT_EXTENSION_ID}`,
) {
  return new Request(`http://localhost:3000/api/extension/${path}`, {
    method: body ? "POST" : "GET",
    headers: {
      cookie,
      "x-tidy-extension": "1",
      origin,
      "content-type": "application/json",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}
async function fileCount() {
  return Number((await admin.query(`select count(*) from "designFile"`)).rows[0].count);
}
beforeAll(async () => {
  if (!enabled) return;
  process.env.BELLA_EXTENSION_IDS = DEVELOPMENT_EXTENSION_ID;
  admin = new Client({ connectionString: setupUrl });
  await admin.connect();
  const context = await auth.$context;
  const token = "extension-fixture-session";
  const signature = createHmac("sha256", process.env.BETTER_AUTH_SECRET!)
    .update(token)
    .digest("base64");
  cookie = `${context.authCookies.sessionToken.name}=${encodeURIComponent(`${token}.${signature}`)}`;
});
beforeEach(async () => {
  if (!enabled) return;
  await admin.query(`drop trigger if exists fixture_receipt_failure on "designImport";
    truncate "user","organization" cascade; truncate "designObject";
    update "billingDeployment" set "selfHosted"=true;
    insert into "user" ("id","name","email","emailVerified") values
      ('editor','Editor','editor@example.test',true),('viewer','Viewer','viewer@example.test',true),('outsider','Outside','outside@example.test',true);
    insert into "organization" ("id","name","slug","createdAt","createdByUserId") values
      ('a','A','a',now(),'editor'),('b','B','b',now(),'outsider');
    insert into "member" ("id","organizationId","userId","role","createdAt") values
      ('edit','a','editor','editor',now()),('view','a','viewer','viewer',now()),('outside','b','outsider','owner',now());
    insert into "session" ("id","token","userId","expiresAt","updatedAt") values
      ('extension-session','extension-fixture-session','editor',now()+interval '1 hour',now());
    insert into "designFile" ("id","organizationId","name","createdBy") values
      ('${fileId}','a','Existing','editor'),('${foreignId}','b','Foreign','outsider');`);
  await admin.query(
    `insert into "designDocument" ("fileId","revision","content") values ($1,7,$2)`,
    [fileId, blankDesignDocument()],
  );
});
afterAll(async () => {
  if (!enabled) return;
  if (previousIds === undefined) delete process.env.BELLA_EXTENSION_IDS;
  else process.env.BELLA_EXTENSION_IDS = previousIds;
  await db.end();
  await admin.end();
});
integration(
  "real sessions and restricted runtime authorize only editable active destinations",
  async () => {
    expect((await db.query("select current_user")).rows[0].current_user).toBe(
      "tidy_runtime_fixture",
    );
    const response = await account(request("account"));
    expect(response.status).toBe(200);
    expect(extensionAccountSchema.parse(await response.json()).organizations).toEqual([
      { id: "a", name: "A", files: [{ id: fileId, name: "Existing" }] },
    ]);
    const check = await account(request(`account?userId=editor&organizationId=a&fileId=${fileId}`));
    expect(check.status).toBe(200);
    expect(await check.json()).not.toHaveProperty("organizations");
    expect(
      (await account(request(`account?userId=editor&organizationId=a&fileId=${foreignId}`))).status,
    ).toBe(403);
    expect((await account(request("account?userId=outsider&organizationId=a"))).status).toBe(409);
    await admin.query(`update "member" set "role"='viewer' where "userId"='editor'`);
    expect((await account(request("account?userId=editor&organizationId=a"))).status).toBe(403);
  },
);
integration("untrusted origins and anonymous requests cannot stage captures", async () => {
  expect((await POST(request("import", input(), "https://evil.test"))).status).toBe(403);
  const anonymous = request("import", input());
  anonymous.headers.delete("cookie");
  expect((await POST(anonymous)).status).toBe(401);
  const noOrigin = request("import", input());
  noOrigin.headers.delete("origin");
  expect((await POST(noOrigin)).status).toBe(403);
  expect(Number((await admin.query(`select count(*) from "designImport"`)).rows[0].count)).toBe(0);
});
integration(
  "lost responses recover through a durable receipt and replay never creates a second design",
  async () => {
    const body = input();
    const response = await POST(request("import", body));
    expect(response.status).toBe(200);
    const original = importResultSchema.parse(await response.json());
    const recovered = await receipt(request(`import/${body.request.id}`), {
      params: Promise.resolve({ id: body.request.id }),
    });
    expect(recovered.status).toBe(200);
    expect(await recovered.json()).toMatchObject({
      state: "done",
      result: { fileId: original.fileId, nodeIds: original.nodeIds, revision: 1 },
    });
    const replay = await POST(request("import", body));
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({
      fileId: original.fileId,
      revision: 1,
      nodeIds: original.nodeIds,
    });
    expect(await fileCount()).toBe(3);
    body.capture.title = "Changed content";
    expect((await POST(request("import", body))).status).toBe(409);
    expect(await fileCount()).toBe(3);
  },
);
integration("concurrent identical submissions publish exactly once", async () => {
  const body = input();
  const responses = await Promise.all([
    POST(request("import", body)),
    POST(request("import", body)),
  ]);
  expect(responses.some((r) => r.status === 200)).toBe(true);
  expect(responses.every((r) => r.status === 200 || r.status === 202)).toBe(true);
  expect(await fileCount()).toBe(3);
  expect(await captureReceipt("editor", body.request.id)).toMatchObject({ state: "done" });
});
integration(
  "receipt reads cannot bypass ownership, membership, or archived-file boundaries",
  async () => {
    const body = input();
    const result = await submitCapture("editor", body);
    await admin.query(`update "member" set "role"='editor' where "userId"='viewer'`);
    expect(await captureReceipt("viewer", body.request.id)).toBeNull();
    expect(await captureReceipt("outsider", body.request.id)).toBeNull();
    await admin.query(`update "designFile" set "archivedAt"=now() where "id"=$1`, [result.fileId]);
    expect(await captureReceipt("editor", body.request.id)).toBeNull();
    await admin.query(`update "designFile" set "archivedAt"=null where "id"=$1`, [result.fileId]);
    await admin.query(`delete from "member" where "userId"='editor'`);
    expect(await captureReceipt("editor", body.request.id)).toBeNull();
    expect(
      (
        await receipt(request(`import/${body.request.id}`), {
          params: Promise.resolve({ id: body.request.id }),
        })
      ).status,
    ).toBe(404);
  },
);
integration(
  "receipt and design publication roll back together if the final receipt write fails",
  async () => {
    await admin.query(`create or replace function fixture_reject_receipt() returns trigger language plpgsql as $$
    begin if NEW."status"='committed' then raise exception 'fixture receipt failure'; end if; return NEW; end $$;
    create trigger fixture_receipt_failure before update on "designImport" for each row execute function fixture_reject_receipt();`);
    const body = input();
    await expect(submitCapture("editor", body)).rejects.toThrow("fixture receipt failure");
    expect(await fileCount()).toBe(2);
    expect(await captureReceipt("editor", body.request.id)).toEqual({ state: "failed" });
    await admin.query(`drop trigger fixture_receipt_failure on "designImport"`);
    await submitCapture("editor", input()); // cleanup must retain the failed receipt
    await expect(submitCapture("editor", body)).rejects.toThrow("failed or expired");
    expect(await fileCount()).toBe(3);
  },
);
integration(
  "concurrent edits are preserved and the capture aborts on revision conflict",
  async () => {
    const body = input(true);
    const services = {
      ...documentServices,
      captureReceipt,
      commitImport: async (...args: Parameters<typeof documentServices.commitImport>) => {
        await admin.query(`update "designDocument" set "revision"=8 where "fileId"=$1`, [fileId]);
        return documentServices.commitImport(...args);
      },
    };
    await expect(
      importWebCapture(
        "editor",
        {
          userId: body.userId,
          organizationId: body.organizationId,
          fileId: body.fileId,
          capture: body.capture,
        },
        services,
        undefined,
        { id: body.request.id, hash: "a".repeat(64), createdAt: Date.now() },
      ),
    ).rejects.toThrow("changed");
    const stored = (
      await admin.query(`select "revision","content" from "designDocument" where "fileId"=$1`, [
        fileId,
      ])
    ).rows[0];
    expect(stored.revision).toBe(8);
    expect(stored.content.nodes).toHaveLength(0);
    expect(await captureReceipt("editor", body.request.id)).toEqual({ state: "failed" });
  },
);
integration("permission revocation after staging prevents publication", async () => {
  const body = input();
  const services = {
    ...documentServices,
    captureReceipt,
    commitImport: async (...args: Parameters<typeof documentServices.commitImport>) => {
      await admin.query(`update "member" set "role"='viewer' where "userId"='editor'`);
      return documentServices.commitImport(...args);
    },
  };
  await expect(
    importWebCapture(
      "editor",
      {
        userId: body.userId,
        organizationId: body.organizationId,
        fileId: body.fileId,
        capture: body.capture,
      },
      services,
      undefined,
      { id: body.request.id, hash: "b".repeat(64), createdAt: Date.now() },
    ),
  ).rejects.toThrow("not found or expired");
  expect(await fileCount()).toBe(2);
  expect(await captureReceipt("editor", body.request.id)).toBeNull();
});
integration("expired request IDs cannot be recreated after receipt cleanup", async () => {
  const body = input();
  body.request.createdAt -= 24 * 60 * 60_000;
  expect((await POST(request("import", body))).status).toBe(400);
  expect(await fileCount()).toBe(2);
  expect(Number((await admin.query(`select count(*) from "designImport"`)).rows[0].count)).toBe(0);
});

integration("a 5,000-layer capture commits and recovers within the design limits", async () => {
  const body = input();
  body.capture.document.nodes = [
    frame,
    ...Array.from({ length: 4999 }, (_, index) => ({
      ...frame,
      id: `node-${index}`,
      parentId: "frame",
      type: "container" as const,
    })),
  ];
  const result = await submitCapture("editor", body);
  expect(result.nodeCount).toBe(5000);
  expect(await captureReceipt("editor", body.request.id)).toMatchObject({
    state: "done",
    result: { fileId: result.fileId },
  });
  expect(
    (await admin.query(`select "chunks" from "designImport" where "id"=$1`, [body.request.id]))
      .rows[0].chunks,
  ).toEqual({});
});

integration("accepted client clock skew cannot outlive its retained receipt", async () => {
  const body = input();
  body.request.createdAt += 4 * 60_000;
  await submitCapture("editor", body);
  const row = (
    await admin.query(`select "expiresAt" from "designImport" where "id"=$1`, [body.request.id])
  ).rows[0];
  expect(new Date(row.expiresAt).getTime()).toBe(body.request.createdAt + 24 * 60 * 60_000);
});

integration(
  "generic platform imports retain their original protocol and database expiry",
  async () => {
    const staging = await documentServices.createImport("editor", "a", "Generic import");
    await documentServices.putImportDocument("editor", staging.importId, {
      ...blankDesignDocument(),
      nodes: [frame],
    });
    const result = await documentServices.commitImport("editor", staging.importId);
    expect(result.nodeCount).toBe(1);
    expect(await captureReceipt("editor", staging.importId)).toBeNull();
    const row = (
      await admin.query(
        `select "requestHash","requestResult",extract(epoch from ("expiresAt"-"createdAt")) as lifetime from "designImport" where "id"=$1`,
        [staging.importId],
      )
    ).rows[0];
    expect(row.requestHash).toBeNull();
    expect(row.requestResult).toBeNull();
    expect(Number(row.lifetime)).toBe(86400);
  },
);

integration(
  "web captures append to the existing first page without creating or renaming pages",
  async () => {
    const current = {
      ...blankDesignDocument(),
      pages: [{ id: "custom-page", name: "My designs" }],
      nodes: [{ ...frame, id: "existing-frame", pageId: "custom-page", name: "User edits" }],
    };
    await admin.query(`update "designDocument" set "content"=$2 where "fileId"=$1`, [
      fileId,
      current,
    ]);
    const body = input(true);
    const result = await submitCapture("editor", body);
    expect(result.revision).toBe(8);
    const saved = (
      await admin.query(`select "content" from "designDocument" where "fileId"=$1`, [fileId])
    ).rows[0].content;
    expect(saved.pages).toEqual(current.pages);
    expect(saved.nodes).toHaveLength(2);
    expect(saved.nodes[0]).toMatchObject(current.nodes[0]);
    expect(saved.nodes[1]).toMatchObject({ pageId: "custom-page", box: { x: 220 } });
  },
);
