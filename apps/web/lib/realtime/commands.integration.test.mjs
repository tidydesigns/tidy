import { beforeAll, afterAll, describe, test, expect, mock } from "bun:test";
import pg from "pg";
import { blankDesignDocument, buildDrawnNode } from "../design/document";
import { diffDocument, invertPatch } from "../design/document-patch";

mock.module("server-only", () => ({}));
const url = process.env.MULTIPLAYER_TEST_DATABASE_URL;
const enabled = !!url && ["localhost", "127.0.0.1"].includes(new URL(url).hostname);
const id = crypto.randomUUID();
const userA = `test-a-${id}`,
  userB = `test-b-${id}`,
  outsider = `test-c-${id}`,
  organization = `test-org-${id}`,
  fileId = `test-file-${id}`;
let client, commitDocumentPatch, commitAtRevision, documentServices, commentServices;
const requestRevisions = new Map();
const base = () => ({
  ...blankDesignDocument(),
  nodes: [
    buildDrawnNode("a", "container", null, { x: 10, y: 10, width: 100, height: 100 }),
    buildDrawnNode("b", "container", null, { x: 200, y: 10, width: 100, height: 100 }),
  ],
});
async function snapshot() {
  return (
    await client.query(`select "revision", "content" from "designDocument" where "fileId"=$1`, [
      fileId,
    ])
  ).rows[0];
}
async function edit(actor, before, nodeId, name, operationId = crypto.randomUUID()) {
  const after = {
    ...before,
    nodes: before.nodes.map((node) => (node.id === nodeId ? { ...node, name } : node)),
  };
  return commitDocumentPatch(actor, fileId, operationId, diffDocument(before, after), false);
}
describe.skipIf(!enabled)("local Postgres multiplayer commands", () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    ({ commitDocumentPatch: commitAtRevision } = await import("../design/commands"));
    // Model the client retaining the original base revision across a lost-ack retry.
    commitDocumentPatch = async (actor, file, operationId, ...args) => {
      if (!requestRevisions.has(operationId))
        requestRevisions.set(operationId, (await snapshot()).revision);
      return commitAtRevision(actor, file, operationId, requestRevisions.get(operationId), ...args);
    };
    documentServices = await import("../design/document-service");
    commentServices = await import("../design/comments");
    client = new pg.Client({ connectionString: url });
    await client.connect();
    for (const user of [userA, userB, outsider])
      await client.query(
        `insert into "user" ("id","name","email","emailVerified") values ($1,$1,$2,true)`,
        [user, `${user}@localhost.test`],
      );
    await client.query(
      `insert into "organization" ("id","name","slug","createdAt","createdByUserId") values ($1,$1,$1,now(),$2)`,
      [organization, userA],
    );
    // Collaboration fixtures use Pro; hosted Free intentionally includes one editor.
    await client.query(
      `insert into "billingPlanPrice" ("priceId") values ('price_multiplayer_fixture') on conflict do nothing`,
    );
    await client.query(
      `insert into "organization_billing" ("organizationId","stripeStatus","stripePriceId") values ($1,'active','price_multiplayer_fixture')`,
      [organization],
    );
    for (const user of [userA, userB])
      await client.query(
        `insert into "member" ("id","organizationId","userId","role","createdAt") values ($1,$2,$3,'owner',now())`,
        [`member-${user}`, organization, user],
      );
    await client.query(
      `insert into "designFile" ("id","organizationId","name","createdBy") values ($1,$2,'Test',$3)`,
      [fileId, organization, userA],
    );
    await client.query(`insert into "designDocument" ("fileId","content") values ($1,$2::jsonb)`, [
      fileId,
      JSON.stringify(base()),
    ]);
  });
  afterAll(async () => {
    if (client) {
      await client.query(`delete from "organization" where "id"=$1`, [organization]);
      for (const user of [userA, userB, outsider])
        await client.query(`delete from "user" where "id"=$1`, [user]);
      await client.end();
    }
    const { db } = await import("../db");
    await db.end();
  });
  test("actual concurrent transactions preserve independent edits", async () => {
    const before = (await snapshot()).content;
    await Promise.all([edit(userA, before, "a", "From A"), edit(userB, before, "b", "From B")]);
    expect((await snapshot()).content.nodes.map((node) => node.name)).toEqual(["From A", "From B"]);
  });
  test("lost acknowledgment retry commits once and rejects ID reuse", async () => {
    const before = (await snapshot()).content;
    const operation = crypto.randomUUID();
    const first = await edit(userA, before, "a", "Once", operation);
    const retry = await edit(userA, before, "a", "Once", operation);
    expect(retry.snapshot.revision).toBe(first.snapshot.revision);
    expect(retry.patch).toEqual(first.patch);
    await expect(edit(userA, before, "a", "Different", operation)).rejects.toThrow(
      "different edit",
    );
  });
  test("a nonmember cannot mutate the file", async () => {
    await expect(edit(outsider, (await snapshot()).content, "a", "Denied")).rejects.toThrow(
      "access denied",
    );
  });
  test("MCP activity routing requires current file membership and import ownership", async () => {
    const { resolveActivityScope } = await import("../mcp/activity-scope");
    expect(await resolveActivityScope(userA, { file_id: fileId, node_id: "a" })).toEqual({
      fileId,
      nodeIds: ["a"],
    });
    expect(await resolveActivityScope(outsider, { file_id: fileId })).toBeNull();
    const staging = await documentServices.createImport(
      userA,
      organization,
      "Activity scope",
      fileId,
    );
    const destination = { fileId, importId: staging.importId };
    expect(await resolveActivityScope(userA, { import_id: staging.importId })).toEqual(destination);
    expect(await resolveActivityScope(userB, { import_id: staging.importId })).toBeNull();
    expect(
      await resolveActivityScope(userA, {
        import_id: staging.importId,
        organization_id: "another-org",
      }),
    ).toBeNull();
    await client.query('update "designFile" set "archivedAt"=now() where "id"=$1', [fileId]);
    try {
      expect(await resolveActivityScope(userA, { import_id: staging.importId })).toBeNull();
    } finally {
      await client.query('update "designFile" set "archivedAt"=null where "id"=$1', [fileId]);
    }
    await client.query('delete from "member" where "organizationId"=$1 and "userId"=$2', [
      organization,
      userA,
    ]);
    try {
      expect(await resolveActivityScope(userA, { file_id: fileId })).toBeNull();
      expect(await resolveActivityScope(userA, { import_id: staging.importId })).toBeNull();
    } finally {
      await client.query(
        `insert into "member" ("id","organizationId","userId","role","createdAt") values ($1,$2,$3,'owner',now())`,
        [`member-${userA}`, organization, userA],
      );
    }
    await documentServices.abortImport(userA, staging.importId);
    expect(await resolveActivityScope(userA, { import_id: staging.importId })).toBeNull();
    const newFile = await documentServices.createImport(userA, organization, "No destination yet");
    expect(await resolveActivityScope(userA, { import_id: newFile.importId })).toBeNull();
    await documentServices.abortImport(userA, newFile.importId);
  });
  test("conditional undo leaves another actor's independent edit intact", async () => {
    const local = await edit(userA, (await snapshot()).content, "a", "Undo me");
    await edit(userB, (await snapshot()).content, "b", "Keep remote");
    await commitDocumentPatch(
      userA,
      fileId,
      crypto.randomUUID(),
      invertPatch(local.patch),
      true,
      undefined,
      local.sequence,
    );
    expect((await snapshot()).content.nodes.map((node) => node.name)).toEqual([
      "Once",
      "Keep remote",
    ]);
  });
  test("undo detects a newer edit even when its value was changed back", async () => {
    const local = await edit(userA, (await snapshot()).content, "a", "ABA local");
    await edit(userB, (await snapshot()).content, "a", "ABA remote");
    await edit(userB, (await snapshot()).content, "a", "ABA local");
    await expect(
      commitDocumentPatch(
        userA,
        fileId,
        crypto.randomUUID(),
        invertPatch(local.patch),
        true,
        undefined,
        local.sequence,
      ),
    ).rejects.toThrow("cannot be undone");
  });
  test("all existing MCP service mutations generate durable events", async () => {
    const before = await snapshot();
    const seq = Number(
      (
        await client.query(`select "sequence" from "designRealtimeState" where "fileId"=$1`, [
          fileId,
        ])
      ).rows[0].sequence,
    );
    await documentServices.patchDocumentNode(userA, fileId, before.revision, "a", {
      name: "MCP edit",
    });
    const events = (
      await client.query(
        `select "kind" from "designRealtimeEvent" where "fileId"=$1 and "sequence">$2`,
        [fileId, seq],
      )
    ).rows;
    expect(events.some((event) => event.kind === "document")).toBe(true);
    expect((await snapshot()).content.nodes[0].name).toBe("MCP edit");
  });
  test("comments and reactions generate events and preserve viewer-specific reactions", async () => {
    const threadId = await commentServices.createComment(
      fileId,
      userA,
      200,
      200,
      "Hello live",
      "page-1",
    );
    const comments = await commentServices.listComments(fileId, userA);
    const message = comments.threads.find((thread) => thread.id === threadId).messages[0];
    await commentServices.toggleCommentReaction(fileId, message.id, userA, "👍");
    const a = await commentServices.listComments(fileId, userA),
      b = await commentServices.listComments(fileId, userB);
    expect(a.threads[0].messages[0].reactions[0].reacted).toBe(true);
    expect(b.threads[0].messages[0].reactions[0].reacted).toBe(false);
    expect(
      (
        await client.query(
          `select "kind" from "designRealtimeEvent" where "fileId"=$1 and "kind"='comments'`,
          [fileId],
        )
      ).rowCount,
    ).toBeGreaterThan(0);
    await commentServices.deleteCommentThread(fileId, threadId, userA);
    expect((await commentServices.listComments(fileId, userB)).threads).toHaveLength(0);
  });
  test("latest component instances receive a master edit despite a stale base", async () => {
    const before = await snapshot();
    const master = {
      ...buildDrawnNode("master", "container", null, { x: 0, y: 0, width: 100, height: 100 }),
      isComponent: true,
    };
    await client.query(
      `update "designDocument" set "content"=$2::jsonb,"revision"="revision"+1 where "fileId"=$1`,
      [fileId, JSON.stringify({ ...before.content, nodes: [...before.content.nodes, master] })],
    );
    const stale = (await snapshot()).content;
    const instance = {
      ...master,
      id: "instance",
      isComponent: undefined,
      instanceOf: "master",
      componentSourceId: "master",
      instanceOverrides: [],
    };
    await commitDocumentPatch(
      userB,
      fileId,
      crypto.randomUUID(),
      diffDocument(stale, { ...stale, nodes: [...stale.nodes, instance] }),
      false,
    );
    await commitDocumentPatch(
      userA,
      fileId,
      crypto.randomUUID(),
      diffDocument(stale, {
        ...stale,
        nodes: stale.nodes.map((node) =>
          node.id === "master" ? { ...node, style: { ...node.style, fill: "#123456" } } : node,
        ),
      }),
      false,
      "master",
    );
    expect((await snapshot()).content.nodes.find((node) => node.id === "instance").style.fill).toBe(
      "#123456",
    );
  });
  test("consecutive undos on the same property accept verified earlier history versions", async () => {
    const before = (await snapshot()).content.nodes[0].name;
    const first = await edit(userA, (await snapshot()).content, "a", "First pending edit");
    const second = await edit(userA, (await snapshot()).content, "a", "Second pending edit");
    const undoSecond = await commitDocumentPatch(
      userA,
      fileId,
      crypto.randomUUID(),
      invertPatch(second.patch),
      true,
      undefined,
      second.sequence,
    );
    const undoFirst = await commitDocumentPatch(
      userA,
      fileId,
      crypto.randomUUID(),
      invertPatch(first.patch),
      true,
      undefined,
      first.sequence,
      [undoSecond.sequence],
    );
    expect((await snapshot()).content.nodes[0].name).toBe(before);
    const redoFirst = await commitDocumentPatch(
      userA,
      fileId,
      crypto.randomUUID(),
      invertPatch(undoFirst.patch),
      true,
      undefined,
      undoFirst.sequence,
    );
    await commitDocumentPatch(
      userA,
      fileId,
      crypto.randomUUID(),
      invertPatch(undoSecond.patch),
      true,
      undefined,
      undoSecond.sequence,
      [redoFirst.sequence],
    );
    expect((await snapshot()).content.nodes[0].name).toBe("Second pending edit");
  });
  test("a history exemption cannot name another user's operation", async () => {
    const original = await edit(userA, (await snapshot()).content, "a", "Guarded history");
    const remote = await edit(userB, (await snapshot()).content, "a", "Remote guard");
    await expect(
      commitDocumentPatch(
        userA,
        fileId,
        crypto.randomUUID(),
        invertPatch(original.patch),
        true,
        undefined,
        original.sequence,
        [remote.sequence],
      ),
    ).rejects.toThrow("unavailable edit version");
    expect((await snapshot()).content.nodes[0].name).toBe("Remote guard");
  });
  test("an owned history version does not exempt a subsequent remote ABA edit", async () => {
    const first = await edit(userA, (await snapshot()).content, "a", "Owned first");
    const second = await edit(userA, (await snapshot()).content, "a", "Owned second");
    const undone = await commitDocumentPatch(
      userA,
      fileId,
      crypto.randomUUID(),
      invertPatch(second.patch),
      true,
      undefined,
      second.sequence,
    );
    await edit(userB, (await snapshot()).content, "a", "Remote ABA");
    await edit(userB, (await snapshot()).content, "a", "Owned first");
    await expect(
      commitDocumentPatch(
        userA,
        fileId,
        crypto.randomUUID(),
        invertPatch(first.patch),
        true,
        undefined,
        first.sequence,
        [undone.sequence],
      ),
    ).rejects.toThrow("cannot be undone");
  });
  test("image fills enforce asset ownership for room and MCP edits, including hidden fills", async () => {
    const foreignOrg = `foreign-${id}`,
      foreignAsset = crypto.randomUUID(),
      ownAsset = crypto.randomUUID();
    await client.query(
      `insert into "organization" ("id","name","slug","createdAt","createdByUserId") values ($1,$1,$1,now(),$2)`,
      [foreignOrg, outsider],
    );
    try {
      for (const [asset, org] of [
        [foreignAsset, foreignOrg],
        [ownAsset, organization],
      ])
        await client.query(
          `insert into "designAsset" ("id","organizationId","mimeType","sha256","body") values ($1,$2,'image/png',$3,$4)`,
          [asset, org, asset, Buffer.from("89504e470d0a1a0a", "hex")],
        );
      const before = (await snapshot()).content;
      const paint = (assetId) => ({
        id: "image-fill",
        type: "image",
        assetId,
        visible: false,
        opacity: 1,
        fit: "cover",
        positionX: 50,
        positionY: 50,
      });
      const after = (assetId) => ({
        ...before,
        nodes: before.nodes.map((node) =>
          node.id === "a" ? { ...node, style: { ...node.style, paints: [paint(assetId)] } } : node,
        ),
      });
      await expect(
        commitDocumentPatch(
          userA,
          fileId,
          crypto.randomUUID(),
          diffDocument(before, after(foreignAsset)),
          false,
        ),
      ).rejects.toThrow("assets are inaccessible");
      await expect(
        commitDocumentPatch(
          userA,
          fileId,
          crypto.randomUUID(),
          diffDocument(before, after(crypto.randomUUID())),
          false,
        ),
      ).rejects.toThrow("assets are inaccessible");
      await commitDocumentPatch(
        userA,
        fileId,
        crypto.randomUUID(),
        diffDocument(before, after(ownAsset)),
        false,
      );
      expect(
        (await snapshot()).content.nodes.find((node) => node.id === "a").style.paints[0].assetId,
      ).toBe(ownAsset);
      const current = await snapshot();
      await expect(
        documentServices.patchDocumentNode(userA, fileId, current.revision, "a", {
          style: { paints: [paint(foreignAsset)] },
        }),
      ).rejects.toThrow("missing or inaccessible");
      await documentServices.patchDocumentNode(userA, fileId, current.revision, "a", {
        style: { paints: [{ ...paint(ownAsset), visible: true }] },
      });
      expect(
        (await snapshot()).content.nodes.find((node) => node.id === "a").style.paints[0].visible,
      ).toBe(true);
    } finally {
      await client.query(`delete from "organization" where "id"=$1`, [foreignOrg]);
    }
  });

  test("revision catch-up returns patches, while imports and missing history fall back to snapshots", async () => {
    const { readFileChanges } = await import("../design/changes");
    const { applyRevisionChanges } = await import("../design/revision-sync");
    const before = await snapshot();
    const first = await edit(userA, before.content, "a", "Delta one");
    await edit(userB, (await snapshot()).content, "b", "Delta two");
    const delta = await readFileChanges(userA, fileId, before.revision);
    expect(delta.content).toBeNull();
    expect(delta.patches).toHaveLength(2);
    expect(
      applyRevisionChanges(before, {
        baseRevision: before.revision,
        revision: delta.revision,
        patches: delta.patches,
      }),
    ).toEqual(await snapshot());
    const unchanged = await readFileChanges(userA, fileId, delta.revision);
    expect(unchanged.content).toBeNull();
    expect(unchanged.patches).toEqual([]);
    expect(await readFileChanges(outsider, fileId, delta.revision)).toBeNull();
    const current = await snapshot();
    await documentServices.patchDocumentNode(userA, fileId, current.revision, "a", {
      name: "External edit",
    });
    const gap = await readFileChanges(userA, fileId, first.snapshot.revision);
    expect(gap.patches).toBeNull();
    expect(gap.content.nodes[0].name).toBe("External edit");
    expect((await readFileChanges(userA, fileId, null)).content).not.toBeNull();
    expect((await readFileChanges(userA, fileId, 2147483647)).content).not.toBeNull();
  });

  test("receipt retention bounds no-op growth and rejects stale replay after deletion", async () => {
    const { DOCUMENT_HISTORY_LIMITS } = await import("../design/history-retention");
    const { readFileChanges } = await import("../design/changes");
    const initial = await snapshot();
    const operationId = crypto.randomUUID();
    const accepted = await commitAtRevision(
      userA,
      fileId,
      operationId,
      initial.revision,
      [],
      false,
    );
    expect(accepted.snapshot.revision).toBe(initial.revision + 1);
    for (let index = 0; index < DOCUMENT_HISTORY_LIMITS.operations; index++) {
      await commitAtRevision(
        userA,
        fileId,
        crypto.randomUUID(),
        (await snapshot()).revision,
        [],
        false,
      );
    }
    const count = await client.query(
      `select count(*)::int as count from "designRealtimeOperation" where "fileId"=$1`,
      [fileId],
    );
    expect(count.rows[0].count).toBe(DOCUMENT_HISTORY_LIMITS.operations);
    expect(
      (
        await client.query(
          `select 1 from "designRealtimeOperation" where "fileId"=$1 and "operationId"=$2`,
          [fileId, operationId],
        )
      ).rowCount,
    ).toBe(0);
    const beforeRetry = await snapshot();
    await expect(
      commitAtRevision(userA, fileId, operationId, initial.revision, [], false),
    ).rejects.toThrow("retry window has expired");
    expect(await snapshot()).toEqual(beforeRetry);
    const fallback = await readFileChanges(userA, fileId, initial.revision);
    expect(fallback.patches).toBeNull();
    expect(fallback.content).toEqual(beforeRetry.content);
    const currentId = crypto.randomUUID();
    const recent = await commitAtRevision(
      userA,
      fileId,
      currentId,
      beforeRetry.revision,
      [],
      false,
    );
    const retry = await commitAtRevision(userA, fileId, currentId, beforeRetry.revision, [], false);
    expect(retry.committedRevision).toBe(recent.committedRevision);
    expect((await snapshot()).revision).toBe(recent.snapshot.revision);
  }, 30_000);

  test("expired receipt is rejected before replay even without a cleanup scheduler", async () => {
    const before = await snapshot();
    const operationId = crypto.randomUUID();
    const patch = diffDocument(before.content, {
      ...before.content,
      nodes: before.content.nodes.map((node) =>
        node.id === "a" ? { ...node, name: "Expired receipt" } : node,
      ),
    });
    await commitAtRevision(userA, fileId, operationId, before.revision, patch, false);
    await client.query(
      `update "designRealtimeOperation" set "createdAt"=now()-interval '8 days' where "fileId"=$1 and "operationId"=$2`,
      [fileId, operationId],
    );
    const saved = await snapshot();
    await expect(
      commitAtRevision(userA, fileId, operationId, before.revision, patch, false),
    ).rejects.toThrow("retry window has expired");
    expect(await snapshot()).toEqual(saved);
    await commitAtRevision(userA, fileId, crypto.randomUUID(), saved.revision, [], false);
    expect(
      (
        await client.query(
          `select 1 from "designRealtimeOperation" where "fileId"=$1 and "operationId"=$2`,
          [fileId, operationId],
        )
      ).rowCount,
    ).toBe(0);
  });

  test("receipt byte retention advances cutoff atomically and preserves current retries", async () => {
    const { DOCUMENT_HISTORY_LIMITS } = await import("../design/history-retention");
    // Populate historical payload bytes without constructing huge editor documents.
    // The next real command must atomically retire these receipts before admitting its own.
    await client.query(
      `update "designRealtimeOperation" set "patch"=jsonb_build_array(jsonb_build_object('fixture', repeat('x', 100000))) where "fileId"=$1`,
      [fileId],
    );
    const before = await snapshot();
    const op = crypto.randomUUID();
    const result = await commitAtRevision(userA, fileId, op, before.revision, [], false);
    const usage = (
      await client.query(
        `select coalesce(sum(octet_length("patch"::text)+256),0)::bigint as bytes from "designRealtimeOperation" where "fileId"=$1`,
        [fileId],
      )
    ).rows[0];
    expect(Number(usage.bytes)).toBeLessThanOrEqual(DOCUMENT_HISTORY_LIMITS.bytes);
    expect(
      (await commitAtRevision(userA, fileId, op, before.revision, [], false)).committedRevision,
    ).toBe(result.committedRevision);
    await expect(
      commitAtRevision(userA, fileId, crypto.randomUUID(), result.snapshot.revision + 1, [], false),
    ).rejects.toThrow("ahead");
  });

  test("retained event gaps invalidate documents, metadata and comments together", async () => {
    const { fileEvents } = await import("./server");
    const start = Number(
      (
        await client.query(`select "sequence" from "designRealtimeState" where "fileId"=$1`, [
          fileId,
        ])
      ).rows[0].sequence,
    );
    await client.query(`select bella_file_event($1, 'metadata') from generate_series(1, 2005)`, [
      fileId,
    ]);
    const state = Number(
      (
        await client.query(`select "sequence" from "designRealtimeState" where "fileId"=$1`, [
          fileId,
        ])
      ).rows[0].sequence,
    );
    expect(
      (
        await client.query(
          `select count(*)::int as count from "designRealtimeEvent" where "fileId"=$1`,
          [fileId],
        )
      ).rows[0].count,
    ).toBe(2000);
    const gap = await fileEvents(fileId, start);
    expect(gap.map((event) => event.kind).sort()).toEqual(["comments", "document", "metadata"]);
    expect(gap.every((event) => event.sequence === state)).toBe(true);
    expect(await fileEvents(fileId, state)).toEqual([]);
    expect(await fileEvents(fileId, state - 1)).toEqual([{ sequence: state, kind: "metadata" }]);
    // Even a wholly missing outbox must not hide an advanced authoritative sequence.
    await client.query(`delete from "designRealtimeEvent" where "fileId"=$1`, [fileId]);
    expect((await fileEvents(fileId, state - 1)).map((event) => event.kind).sort()).toEqual([
      "comments",
      "document",
      "metadata",
    ]);
  }, 15_000);

  test("pruned conflict markers expire unsafe undo while recent undo remains valid", async () => {
    const old = await edit(userA, (await snapshot()).content, "a", "Undo cutoff");
    await client.query(`select bella_file_event($1, 'metadata') from generate_series(1, 2005)`, [
      fileId,
    ]);
    const next = await edit(userB, (await snapshot()).content, "b", "Recent undo");
    const floor = Number(
      (
        await client.query(
          `select "historyFloorSequence" from "designRealtimeState" where "fileId"=$1`,
          [fileId],
        )
      ).rows[0].historyFloorSequence,
    );
    expect(floor).toBeGreaterThan(0);
    await expect(
      commitAtRevision(
        userA,
        fileId,
        crypto.randomUUID(),
        (await snapshot()).revision,
        invertPatch(old.patch),
        true,
        undefined,
        floor - 1,
      ),
    ).rejects.toThrow("undo history has expired");
    await commitAtRevision(
      userB,
      fileId,
      crypto.randomUUID(),
      (await snapshot()).revision,
      invertPatch(next.patch),
      true,
      undefined,
      next.sequence,
    );
    expect((await snapshot()).content.nodes.find((node) => node.id === "b").name).not.toBe(
      "Recent undo",
    );
    // Many distinct paths in a single revision cannot grow the conflict index indefinitely.
    await client.query(
      `insert into "designRealtimeProperty" ("fileId","collection","entityId","path","sequence")
      select $1,'nodes','retention-'||n,array['name'],1 from generate_series(1, 20005) n`,
      [fileId],
    );
    await commitAtRevision(
      userA,
      fileId,
      crypto.randomUUID(),
      (await snapshot()).revision,
      [],
      false,
    );
    expect(
      (
        await client.query(
          `select count(*)::int as count from "designRealtimeProperty" where "fileId"=$1`,
          [fileId],
        )
      ).rows[0].count,
    ).toBeLessThanOrEqual(20000);
  }, 15_000);

  test("migration invalidates legacy receipts once and preserves document content", async () => {
    const { readFile } = await import("node:fs/promises");
    const migration = await readFile(
      new URL("../../../../migrations/20261006-document-history-bounds.sql", import.meta.url),
      "utf8",
    );
    const before = await snapshot();
    const legacyId = crypto.randomUUID();
    const dormant = `${fileId}-dormant`;
    await client.query(
      `insert into "designFile" ("id","organizationId","name","createdBy") values ($1,$2,'Dormant',$3)`,
      [dormant, organization, userA],
    );
    await client.query(`insert into "designDocument" ("fileId","content") values ($1,$2::jsonb)`, [
      dormant,
      JSON.stringify(base()),
    ]);
    const dormantBefore = (
      await client.query(`select "revision","content" from "designDocument" where "fileId"=$1`, [
        dormant,
      ])
    ).rows[0];
    await client.query(
      `insert into "designRealtimeEvent" ("fileId","sequence","kind") select $1,n,'metadata' from generate_series(2,3005) n`,
      [dormant],
    );
    await client.query(`update "designRealtimeState" set "sequence"=3005 where "fileId"=$1`, [
      dormant,
    ]);
    await client.query(
      `insert into "designRealtimeProperty" ("fileId","collection","entityId","path","sequence") select $1,'nodes','old-'||n,array['name'],1 from generate_series(1,20005) n`,
      [dormant],
    );
    await client.query(
      `alter table "designRealtimeOperation" alter column "requestRevision" drop not null`,
    );
    await client.query(
      `insert into "designRealtimeOperation" ("fileId","operationId","userId","hash","patch","baseRevision","revision") values ($1,$2,$3,'legacy','[]',$4,$4)`,
      [fileId, legacyId, userA, before.revision],
    );
    await client.query(migration);
    const migrated = await snapshot();
    expect(
      (
        await client.query(`select "revision","content" from "designDocument" where "fileId"=$1`, [
          dormant,
        ])
      ).rows[0],
    ).toEqual(dormantBefore);
    expect(
      (
        await client.query(
          `select count(*)::int as count from "designRealtimeEvent" where "fileId"=$1`,
          [dormant],
        )
      ).rows[0].count,
    ).toBe(2000);
    expect(
      (
        await client.query(
          `select count(*)::int as count from "designRealtimeProperty" where "fileId"=$1`,
          [dormant],
        )
      ).rows[0].count,
    ).toBeLessThanOrEqual(20000);
    expect(migrated.content).toEqual(before.content);
    expect(migrated.revision).toBe(before.revision + 1);
    await expect(
      commitAtRevision(userA, fileId, legacyId, before.revision, [], false),
    ).rejects.toThrow("retry window has expired");
    const currentId = crypto.randomUUID();
    const saved = await commitAtRevision(userA, fileId, currentId, migrated.revision, [], false);
    await client.query(migration);
    expect(await snapshot()).toEqual(saved.snapshot);
    expect(
      (await commitAtRevision(userA, fileId, currentId, migrated.revision, [], false))
        .committedRevision,
    ).toBe(saved.committedRevision);
  });

  test("concurrent admission at the receipt boundary preserves every active retry", async () => {
    let before = await snapshot();
    const retained = (
      await client.query(
        `select count(*)::int as count from "designRealtimeOperation" where "fileId"=$1`,
        [fileId],
      )
    ).rows[0].count;
    for (let index = retained; index < 1000; index++) {
      before = (
        await commitAtRevision(userA, fileId, crypto.randomUUID(), before.revision, [], false)
      ).snapshot;
    }
    const operations = Array.from({ length: 12 }, () => crypto.randomUUID());
    const results = await Promise.all(
      operations.map((id) => commitAtRevision(userA, fileId, id, before.revision, [], false)),
    );
    expect(new Set(results.map((result) => result.committedRevision)).size).toBe(12);
    const current = await snapshot();
    expect(current.revision).toBe(before.revision + 12);
    for (const [index, id] of operations.entries()) {
      expect(
        (await commitAtRevision(userA, fileId, id, before.revision, [], false)).committedRevision,
      ).toBe(results[index].committedRevision);
    }
    expect(await snapshot()).toEqual(current);
    expect(
      (
        await client.query(
          `select count(*)::int as count from "designRealtimeOperation" where "fileId"=$1`,
          [fileId],
        )
      ).rows[0].count,
    ).toBeLessThanOrEqual(1000);
  }, 30_000);
});

// Coverage for equal-value overwrites: value comparison alone cannot detect ABA.
