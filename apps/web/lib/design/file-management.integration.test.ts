import { afterAll, beforeAll, beforeEach, expect, mock, test } from "bun:test";
import { Client } from "pg";
import { db } from "../db";
import { blankDesignDocument, buildDrawnNode } from "./document";
mock.module("server-only", () => ({}));
const {
  createBrowserFileForUser,
  duplicateFileForUser,
  duplicateFolderForUser,
  archiveFileForUser,
} = await import("./file-management");
const {
  createDesignFolderForUser,
  renameDesignFolderForUser,
  moveDesignFileForUser,
  deleteDesignFolderForUser,
} = await import("./folder-service");
const { createDesignFileForUser, renameDesignFileForUser, deleteArchivedDesignFileForUser } =
  await import("./service");
const { consumeMcpCall } = await import("../mcp/usage");
const testUrl = process.env.FILES_TEST_DATABASE_URL,
  setupUrl = process.env.FILES_SETUP_DATABASE_URL;
const enabled = Boolean(
  testUrl &&
  setupUrl &&
  process.env.DATABASE_URL === testUrl &&
  new URL(testUrl).hostname === "127.0.0.1" &&
  new URL(setupUrl).hostname === "127.0.0.1" &&
  new URL(testUrl).pathname === "/tidy_files_test" &&
  new URL(setupUrl).pathname === "/tidy_files_test" &&
  new URL(testUrl).port === new URL(setupUrl).port,
);
const integration = enabled ? test : test.skip;
let admin: Client;
const symbol = Symbol.for("__cloudflare-context__");
const globals = globalThis as unknown as Record<symbol, unknown>;
let previous: unknown;
const operations = {
  create: () => createBrowserFileForUser("editor", "a", "folder"),
  file: () => duplicateFileForUser("editor", "file"),
  folder: () => duplicateFolderForUser("editor", "folder"),
  archive: () => archiveFileForUser("editor", "file", true),
};
async function state() {
  return (
    await admin.query(`select jsonb_build_object(
    'files',(select jsonb_agg(f order by "id") from "designFile" f),
    'folders',(select jsonb_agg(d order by "id") from "designFolder" d),
    'documents',(select jsonb_agg(d order by "fileId") from "designDocument" d),
    'frames',(select jsonb_agg(f order by "id") from "designFrame" f),
    'rectangles',(select jsonb_agg(r order by "id") from "designRectangle" r)) as value`)
  ).rows[0].value;
}
async function waitingApplication() {
  for (let attempt = 0; attempt < 200; attempt++) {
    const result = await admin.query<{ pid: number }>(`select pid from pg_stat_activity
      where usename='tidy_runtime_fixture' and wait_event='advisory' and state='active'`);
    if (result.rows[0]) return result.rows[0].pid;
    await Bun.sleep(5);
  }
  throw new Error("Expected actual application advisory admission wait.");
}
async function waitForBlock(pid: number) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (
      (await admin.query("select cardinality(pg_blocking_pids($1))>0 as blocked", [pid])).rows[0]
        .blocked
    )
      return;
    await Bun.sleep(5);
  }
  throw new Error("Expected actual authority revocation wait.");
}
beforeAll(async () => {
  if (!enabled) return;
  previous = globals[symbol];
  admin = new Client({ connectionString: setupUrl });
  await admin.connect();
});
beforeEach(async () => {
  if (!enabled) return;
  globals[symbol] = undefined;
  await admin.query(`drop trigger if exists fixture_pause on "designFile";
    drop trigger if exists fixture_failure on "designDocument";
    drop trigger if exists fixture_usage_pause on "organizationMcpUsage";
    truncate "user","organization" cascade; truncate "designObject";
    update "billingDeployment" set "selfHosted"=true;
    insert into "user" ("id","name","email","emailVerified") values
      ('editor','Editor','editor@example.test',true),('viewer','Viewer','viewer@example.test',true),('outsider','Outside','outside@example.test',true);
    insert into "organization" ("id","name","slug","createdAt","createdByUserId") values
      ('a','A','a',now(),'editor'),('b','B','b',now(),'outsider');
    insert into "member" ("id","organizationId","userId","role","createdAt") values
      ('edit','a','editor','editor',now()),('view','a','viewer','viewer',now()),('both','b','editor','editor',now()),('outside','b','outsider','owner',now());
    insert into "designFolder" ("id","organizationId","name","createdBy") values ('folder','a','Source','editor'),('foreign','b','Foreign','outsider'),('empty','a','Empty','editor');
    insert into "designFile" ("id","organizationId","name","createdBy","folderId") values ('file','a','Source','editor','folder');
    insert into "designFrame" ("id","fileId","x","y","width","height") values ('frame','file',1,2,100,200);
    insert into "designRectangle" ("id","fileId","x","y","width","height") values ('rect','file',3,4,50,60);`);
  await admin.query(
    `insert into "designDocument" ("fileId","revision","content") values ('file',7,$1)`,
    [blankDesignDocument()],
  );
});
afterAll(async () => {
  if (!enabled) return;
  globals[symbol] = previous;
  await db.end();
  await admin.end();
});

integration(
  "browser creation and copies run as the actual restricted login and preserve content with fresh identities",
  async () => {
    expect((await db.query("select current_user,session_user")).rows[0]).toEqual({
      current_user: "tidy_runtime_fixture",
      session_user: "tidy_runtime_fixture",
    });
    const created = await operations.create(),
      copied = await operations.file(),
      folder = await operations.folder();
    expect(created).toHaveProperty("id");
    expect(copied).toHaveProperty("id");
    expect(folder).toHaveProperty("id");
    if (!copied.id || !folder.id || !created.id)
      throw new Error("Missing successful copy fixture.");
    const child = (
      await admin.query(`select "id" from "designFile" where "folderId"=$1 and "name"='Source'`, [
        folder.id,
      ])
    ).rows[0].id;
    for (const id of [copied.id, child]) {
      expect(
        (
          await admin.query(`select "revision","content" from "designDocument" where "fileId"=$1`, [
            id,
          ])
        ).rows[0],
      ).toEqual({ revision: 1, content: blankDesignDocument() });
      expect(
        (
          await admin.query(
            `select "x","y","width","height" from "designFrame" where "fileId"=$1`,
            [id],
          )
        ).rows,
      ).toEqual([{ x: 1, y: 2, width: 100, height: 200 }]);
      expect(
        (await admin.query(`select "id" from "designFrame" where "fileId"=$1`, [id])).rows[0].id,
      ).not.toBe("frame");
    }
    expect(
      (await admin.query(`select "revision" from "designDocument" where "fileId"=$1`, [created.id]))
        .rows[0].revision,
    ).toBe(1);
  },
);

for (const denial of ["viewer", "outsider", "removed", "unverified", "combined-role"]) {
  integration(
    `all browser file management rejects ${denial} without changing product state`,
    async () => {
      let actor = "editor";
      if (denial === "viewer" || denial === "outsider") actor = denial;
      if (denial === "removed") await admin.query(`delete from "member" where "id"='edit'`);
      if (denial === "unverified")
        await admin.query(`update "user" set "emailVerified"=false where "id"='editor'`);
      if (denial === "combined-role")
        await admin.query(`update "member" set "role"='viewer,owner' where "id"='edit'`);
      const before = await state();
      expect(await createBrowserFileForUser(actor, "a", "folder")).toHaveProperty("error");
      expect(await duplicateFileForUser(actor, "file")).toHaveProperty("error");
      expect(await duplicateFolderForUser(actor, "folder")).toHaveProperty("error");
      expect(await archiveFileForUser(actor, "file", true)).toHaveProperty("error");
      await expect(createDesignFolderForUser(actor, "a", "New")).rejects.toThrow("access denied");
      await expect(renameDesignFolderForUser(actor, "folder", "New")).rejects.toThrow(
        "access denied",
      );
      await expect(moveDesignFileForUser(actor, "file", "empty")).rejects.toThrow("access denied");
      await expect(deleteDesignFolderForUser(actor, "folder")).rejects.toThrow("access denied");
      expect(await state()).toEqual(before);
    },
  );
}
integration("cross-tenant destinations and malformed selectors fail without copies", async () => {
  const before = await state();
  expect(await createBrowserFileForUser("editor", "a", "foreign")).toHaveProperty("error");
  await expect(moveDesignFileForUser("editor", "file", "foreign")).rejects.toThrow("access denied");
  for (const id of ["", "x".repeat(121)]) {
    expect(await duplicateFileForUser("editor", id)).toHaveProperty("error");
    expect(await duplicateFolderForUser("editor", id)).toHaveProperty("error");
  }
  expect(await state()).toEqual(before);
});
integration(
  "archived file copies become active while folder copies preserve archive state; source remains unchanged",
  async () => {
    expect(await operations.archive()).toEqual({});
    const archived = (await admin.query(`select "archivedAt" from "designFile" where "id"='file'`))
      .rows[0].archivedAt;
    const copied = await operations.file(),
      folder = await operations.folder();
    expect(
      (await admin.query(`select "archivedAt" from "designFile" where "id"=$1`, [copied.id]))
        .rows[0].archivedAt,
    ).toBeNull();
    expect(
      (
        await admin.query(
          `select "archivedAt" from "designFile" where "folderId"=$1 and "archivedAt" is not null`,
          [folder.id],
        )
      ).rows[0].archivedAt,
    ).toEqual(archived);
    expect(await archiveFileForUser("editor", "file", false)).toEqual({});
  },
);

for (const [name, operation] of Object.entries(operations)) {
  for (const change of ["membership", "verification", "parent"]) {
    integration(
      `${name} rechecks ${change} after queued organization admission, without retaining product locks`,
      async () => {
        const blocker = new Client({ connectionString: setupUrl });
        await blocker.connect();
        await blocker.query("begin");
        await blocker.query("select pg_advisory_xact_lock(hashtextextended('a',0))");
        const pending = operation();
        try {
          await waitingApplication();
          await admin.query("set lock_timeout='500ms'");
          if (change === "membership") await admin.query(`delete from "member" where "id"='edit'`);
          if (change === "verification")
            await admin.query(`update "user" set "emailVerified"=false where "id"='editor'`);
          if (change === "parent") {
            if (name === "file" || name === "archive")
              await admin.query(
                `update "designFile" set "folderId"=null,"organizationId"='b' where "id"='file'`,
              );
            else {
              await admin.query(`update "designFile" set "folderId"=null where "id"='file'`);
              await admin.query(
                `update "designFolder" set "organizationId"='b' where "id"='folder'`,
              );
            }
          }
          const before = await state();
          await blocker.query("commit");
          expect(await pending).toHaveProperty("error");
          expect(await state()).toEqual(before);
        } finally {
          await blocker.query("rollback");
          await blocker.end();
          await admin.query("reset lock_timeout");
          await pending;
        }
      },
    );
  }
}

for (const [name, operation] of Object.entries(operations)) {
  for (const change of ["verification", "membership"])
    integration(`${name} retains admitted ${change} authority through publication`, async () => {
      await admin.query(`create or replace function fixture_pause_file() returns trigger language plpgsql as $$ begin
      if (TG_OP='INSERT' and NEW."id"<>'file') or (TG_OP='UPDATE' and NEW."id"='file') then
        perform pg_advisory_xact_lock(hashtextextended('fixture-publication',0)); end if; return NEW; end $$;
      create trigger fixture_pause before insert or update on "designFile" for each row execute function fixture_pause_file();`);
      const blocker = new Client({ connectionString: setupUrl }),
        revoker = new Client({ connectionString: setupUrl });
      await blocker.connect();
      await revoker.connect();
      await blocker.query("begin");
      await blocker.query(
        "select pg_advisory_xact_lock(hashtextextended('fixture-publication',0))",
      );
      const pending = operation();
      let revoke: Promise<unknown> | undefined;
      try {
        await waitingApplication();
        const pid = (await revoker.query("select pg_backend_pid() as pid")).rows[0].pid;
        revoke = revoker.query(
          change === "verification"
            ? `update "user" set "emailVerified"=false where "id"='editor'`
            : `delete from "member" where "id"='edit'`,
        );
        await waitForBlock(pid);
        await blocker.query("commit");
        expect(await pending).not.toHaveProperty("error");
        await revoke;
        expect(await operation()).toHaveProperty("error");
      } finally {
        await blocker.query("rollback");
        await pending;
        await revoke;
        await blocker.end();
        await revoker.end();
      }
    });
}

integration("folder copies reject over 25 files before destination publication", async () => {
  await admin.query(`insert into "designFile" ("id","organizationId","name","createdBy","folderId")
    select 'extra-'||n,'a','Extra','editor','folder' from generate_series(1,25) n`);
  const before = await state();
  expect(await operations.folder()).toEqual({ error: expect.stringContaining("too many files") });
  expect(await state()).toEqual(before);
});
for (const bound of ["per-file-bytes", "aggregate-bytes", "aggregate-nodes", "legacy-shapes"]) {
  integration(`copy rejects ${bound} without partial destinations`, async () => {
    if (bound === "per-file-bytes")
      await admin.query(
        `update "designDocument" set "content"="content"||jsonb_build_object('oversize',repeat('x',5000001)) where "fileId"='file'`,
      );
    if (bound === "aggregate-bytes" || bound === "aggregate-nodes") {
      await admin.query(
        `insert into "designFile" ("id","organizationId","name","createdBy","folderId") select 'extra-'||n,'a','Extra','editor','folder' from generate_series(1,3) n`,
      );
      await admin.query(
        `insert into "designDocument" ("fileId","revision","content") select "id",1,$1::jsonb from "designFile" where "id"<>'file'`,
        [blankDesignDocument()],
      );
      if (bound === "aggregate-bytes")
        await admin.query(
          `update "designDocument" set "content"="content"||jsonb_build_object('oversize',repeat('x',4100000))`,
        );
      else
        await admin.query(
          `update "designDocument" set "content"=jsonb_set("content",'{nodes}',(select jsonb_agg(jsonb_build_object('id',n)) from generate_series(1,3000) n))`,
        );
    }
    if (bound === "legacy-shapes")
      await admin.query(
        `insert into "designRectangle" ("id","fileId","x","y","width","height") select 'extra-'||n,'file',0,0,10,10 from generate_series(1,10000) n`,
      );
    const before = await state();
    expect(await operations.folder()).toHaveProperty("error");
    expect(await state()).toEqual(before);
  });
}
integration(
  "copy preflights the entire paid file allowance without creating a partial folder",
  async () => {
    await admin.query(`update "billingDeployment" set "selfHosted"=false;
    insert into "designFile" ("id","organizationId","name","createdBy","folderId") values ('second','a','Second','editor','folder')`);
    const before = await state();
    expect(await operations.folder()).toEqual({ error: expect.stringContaining("file allowance") });
    expect(await state()).toEqual(before);
  },
);
integration(
  "copy validates own-organization document images, including paint references",
  async () => {
    const node = buildDrawnNode("image-node", "container", null, {
      x: 0,
      y: 0,
      width: 100,
      height: 100,
    });
    const content = {
      ...blankDesignDocument(),
      nodes: [
        {
          ...node,
          style: {
            paints: [
              {
                id: "paint",
                type: "image",
                assetId: "00000000-0000-4000-8000-000000000011",
                fit: "cover",
              },
            ],
          },
        },
      ],
    };
    await admin.query(
      `insert into "designAsset" ("id","organizationId","mimeType","sha256","body") values ('00000000-0000-4000-8000-000000000011','b','image/png',repeat('a',64),decode('01','hex'))`,
    );
    await admin.query(`update "designDocument" set "content"=$1 where "fileId"='file'`, [content]);
    const before = await state();
    expect(await operations.file()).toEqual({
      error: expect.stringContaining("images are missing or inaccessible"),
    });
    expect(await state()).toEqual(before);
    await admin.query(
      `update "designAsset" set "organizationId"='a' where "id"='00000000-0000-4000-8000-000000000011'`,
    );
    expect(await operations.file()).toHaveProperty("id");
  },
);
integration(
  "publication SQL failures roll back files, folders and geometry and never expose private exceptions",
  async () => {
    await admin.query(`create or replace function fixture_fail_document() returns trigger language plpgsql as $$ begin
    raise exception 'private database credential fixture must not escape'; end $$;
    create trigger fixture_failure before insert on "designDocument" for each row execute function fixture_fail_document();`);
    const before = await state();
    expect(await operations.file()).toEqual({ error: "Could not duplicate the file." });
    expect(await operations.folder()).toEqual({ error: "Could not duplicate the folder." });
    expect(await operations.create()).toEqual({
      error: "Could not create the file. Please try again.",
    });
    expect(await state()).toEqual(before);
  },
);
integration(
  "concurrent folder copies, file moves and removal use consistent organization lock ordering",
  async () => {
    const results = await Promise.allSettled([
      operations.folder(),
      operations.file(),
      moveDesignFileForUser("editor", "file", "empty"),
      deleteDesignFolderForUser("editor", "folder"),
    ]);
    expect(results.every((result) => result.status === "fulfilled")).toBe(true);
    expect(
      (
        await admin.query(
          `select count(*)::int as count from "designFile" f join "designFolder" d on d."id"=f."folderId" where f."organizationId"<>d."organizationId"`,
        )
      ).rows[0].count,
    ).toBe(0);
    expect(
      (await admin.query(`select "folderId" from "designFile" where "id"='file'`)).rows[0].folderId,
    ).toBe("empty");
  },
);

integration(
  "shared hosted attempt reservations precede locks and copy work; guard failures and exhaustion fail closed",
  async () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    const calls: { key: string; rule: unknown }[] = [];
    let fail = false,
      deny = false;
    globals[symbol] = {
      env: {
        HYPERDRIVE: { connectionString: testUrl },
        BETTER_AUTH_SECRET: "fixture-budget-secret-at-least-32-characters",
        AUTH_GUARD: {
          idFromName: (name: string) => name,
          get: () => ({
            consume: async (key: string, rule: unknown) => {
              calls.push({ key, rule });
              if (fail) throw new Error("private guard connection failure");
              return { allowed: !deny, retryAfter: 23 };
            },
          }),
        },
      },
      ctx: { waitUntil: () => {} },
    };
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: { userAgent: "Cloudflare-Workers" },
    });
    try {
      const before = await state();
      deny = true;
      expect(await operations.folder()).toEqual({
        error: "Too many changes. Wait before trying again.",
      });
      expect(calls).toHaveLength(1);
      deny = false;
      fail = true;
      expect(await operations.file()).toEqual({
        error: "File changes are temporarily unavailable. Try again shortly.",
      });
      fail = false;
      calls.length = 0;
      expect(await createBrowserFileForUser("editor", "a", "foreign")).toHaveProperty("error");
      expect(calls).toHaveLength(4);
      expect(calls.every((call) => /^[a-f0-9]{64}$/.test(call.key))).toBe(true);
      expect(await state()).toEqual(before);
    } finally {
      if (descriptor) Object.defineProperty(globalThis, "navigator", descriptor);
      else Reflect.deleteProperty(globalThis, "navigator");
      globals[symbol] = undefined;
    }
  },
);

for (const [name, run] of Object.entries({
  rename: () => renameDesignFolderForUser("editor", "folder", "Changed"),
  move: () => moveDesignFileForUser("editor", "file", "empty"),
  remove: () => deleteDesignFolderForUser("editor", "folder"),
  "file-rename": () => renameDesignFileForUser("editor", "file", "Changed"),
  "file-delete": () => deleteArchivedDesignFileForUser("editor", "file"),
})) {
  for (const change of ["membership", "verification", "parent"])
    integration(
      `${name} folder operation binds current tenant after queued ${change} change`,
      async () => {
        if (name === "file-delete")
          await admin.query(`update "designFile" set "archivedAt"=now() where "id"='file'`);
        const blocker = new Client({ connectionString: setupUrl });
        await blocker.connect();
        await blocker.query("begin");
        await blocker.query("select pg_advisory_xact_lock(hashtextextended('a',0))");
        const pending = run().then(
          (value) => ({ value }),
          (error) => ({ error }),
        );
        try {
          await waitingApplication();
          await admin.query("set lock_timeout='500ms'");
          if (change === "membership") await admin.query(`delete from "member" where "id"='edit'`);
          if (change === "verification")
            await admin.query(`update "user" set "emailVerified"=false where "id"='editor'`);
          if (change === "parent") {
            if (name === "move" || name === "file-rename" || name === "file-delete")
              await admin.query(
                `update "designFile" set "folderId"=null,"organizationId"='b' where "id"='file'`,
              );
            else {
              await admin.query(`update "designFile" set "folderId"=null where "id"='file'`);
              await admin.query(
                `update "designFolder" set "organizationId"='b' where "id"='folder'`,
              );
            }
          }
          const before = await state();
          await blocker.query("commit");
          expect(await pending).toHaveProperty("error");
          expect(await state()).toEqual(before);
        } finally {
          await blocker.query("rollback");
          await blocker.end();
          await admin.query("reset lock_timeout");
          await pending;
        }
      },
    );
}

integration("named creation, rename and archived deletion retain product semantics", async () => {
  const created = await createDesignFileForUser("editor", "a", "Named");
  await renameDesignFileForUser("editor", created.id, "Renamed");
  await expect(deleteArchivedDesignFileForUser("editor", created.id)).rejects.toThrow(
    "Archived file",
  );
  expect(await archiveFileForUser("editor", created.id, true)).toEqual({});
  await expect(renameDesignFileForUser("editor", created.id, "Wrong")).rejects.toThrow(
    "access denied",
  );
  await deleteArchivedDesignFileForUser("editor", created.id);
  expect(
    (await admin.query(`select "id" from "designFile" where "id"=$1`, [created.id])).rows,
  ).toEqual([]);
});

integration(
  "folder removal rejects over 1000 files atomically and unfiles permitted active/archive children without deleting documents",
  async () => {
    await admin.query(`insert into "designFile" ("id","organizationId","name","createdBy","folderId")
    select 'bulk-'||n,'a','Bulk','editor','folder' from generate_series(1,1000) n`);
    const before = await state();
    await expect(deleteDesignFolderForUser("editor", "folder")).rejects.toThrow("too many files");
    expect(await state()).toEqual(before);
    await admin.query(
      `delete from "designFile" where "id" like 'bulk-%'; update "designFile" set "archivedAt"=now() where "id"='file'`,
    );
    expect(await deleteDesignFolderForUser("editor", "folder")).toEqual({
      id: "folder",
      unfiledFileCount: 1,
    });
    expect(
      (
        await admin.query(
          `select "folderId","archivedAt" is not null as archived from "designFile" where "id"='file'`,
        )
      ).rows[0],
    ).toEqual({ folderId: null, archived: true });
    expect(
      (await admin.query(`select "revision" from "designDocument" where "fileId"='file'`)).rows[0]
        .revision,
    ).toBe(7);
  },
);

for (const denial of ["unverified", "unknown-role", "removed", "outsider"])
  integration(
    `MCP monthly reservations reject ${denial} before consuming workspace usage`,
    async () => {
      if (denial === "unverified")
        await admin.query(`update "user" set "emailVerified"=false where "id"='editor'`);
      if (denial === "unknown-role")
        await admin.query(`update "member" set "role"='viewer,owner' where "id"='edit'`);
      if (denial === "removed") await admin.query(`delete from "member" where "id"='edit'`);
      const actor = denial === "outsider" ? "outsider" : "editor";
      for (const input of [{ organization_id: "a" }, { file_id: "file" }, { folder_id: "folder" }])
        await expect(consumeMcpCall(actor, input)).rejects.toThrow("access denied");
      expect((await admin.query(`select * from "organizationMcpUsage"`)).rows).toEqual([]);
    },
  );
integration(
  "MCP monthly reservations allow verified viewers and reject conflicting/malformed targets without catalog writes",
  async () => {
    await consumeMcpCall("viewer", { file_id: "file", folder_id: null });
    await consumeMcpCall("editor", {});
    await consumeMcpCall("editor", { organization_id: "a", folder_id: "folder", file_id: "file" });
    for (const input of [
      { file_id: "file", folder_id: "foreign" },
      { organization_id: "a", organizationId: "b" },
      { file_id: "" },
      { file_id: 123 },
      { file_id: "x".repeat(121) },
    ])
      await expect(consumeMcpCall("editor", input)).rejects.toThrow("access denied");
    expect(
      (
        await admin.query(
          `select "organizationId","calls"::int as calls from "organizationMcpUsage"`,
        )
      ).rows,
    ).toEqual([{ organizationId: "a", calls: 3 }]);
  },
);
for (const change of ["membership", "verification", "parent"])
  integration(
    `MCP monthly reservation rechecks ${change} after queued quota admission`,
    async () => {
      const blocker = new Client({ connectionString: setupUrl });
      await blocker.connect();
      await blocker.query("begin");
      await blocker.query("select pg_advisory_xact_lock(hashtextextended('a',0))");
      const pending = consumeMcpCall("editor", { file_id: "file" }).then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
      try {
        await waitingApplication();
        await admin.query("set lock_timeout='500ms'");
        if (change === "membership") await admin.query(`delete from "member" where "id"='edit'`);
        if (change === "verification")
          await admin.query(`update "user" set "emailVerified"=false where "id"='editor'`);
        if (change === "parent")
          await admin.query(
            `update "designFile" set "folderId"=null,"organizationId"='b' where "id"='file'`,
          );
        await blocker.query("commit");
        expect(await pending).toHaveProperty("error");
        expect((await admin.query(`select * from "organizationMcpUsage"`)).rows).toEqual([]);
      } finally {
        await blocker.query("rollback");
        await blocker.end();
        await admin.query("reset lock_timeout");
        await pending;
      }
    },
  );

for (const change of ["membership", "verification"])
  integration(
    `MCP usage reservation retains admitted ${change} authority until its independent commit`,
    async () => {
      await admin.query(`create or replace function fixture_pause_usage() returns trigger language plpgsql as $$ begin
      perform pg_advisory_xact_lock(hashtextextended('fixture-usage',0)); return NEW; end $$;
      create trigger fixture_usage_pause before insert on "organizationMcpUsage" for each row execute function fixture_pause_usage();`);
      const blocker = new Client({ connectionString: setupUrl }),
        revoker = new Client({ connectionString: setupUrl });
      await blocker.connect();
      await revoker.connect();
      await blocker.query("begin");
      await blocker.query("select pg_advisory_xact_lock(hashtextextended('fixture-usage',0))");
      const pending = consumeMcpCall("editor", { file_id: "file" });
      let revoke: Promise<unknown> | undefined;
      try {
        await waitingApplication();
        const pid = (await revoker.query("select pg_backend_pid() as pid")).rows[0].pid;
        revoke = revoker.query(
          change === "membership"
            ? `delete from "member" where "id"='edit'`
            : `update "user" set "emailVerified"=false where "id"='editor'`,
        );
        await waitForBlock(pid);
        await blocker.query("commit");
        await pending;
        await revoke;
        await expect(consumeMcpCall("editor", { file_id: "file" })).rejects.toThrow(
          "access denied",
        );
        expect(
          (
            await admin.query(
              `select "calls"::int as calls from "organizationMcpUsage" where "organizationId"='a'`,
            )
          ).rows[0].calls,
        ).toBe(1);
      } finally {
        await blocker.query("rollback");
        await pending;
        await revoke;
        await blocker.end();
        await revoker.end();
      }
    },
  );
