import { beforeAll, afterAll, test, expect, mock } from "bun:test";
import pg from "pg";
import { blankDesignDocument, buildDrawnNode, parseDesignDocument } from "./document";
import { diffDocument, invertPatch } from "./document-patch";
mock.module("server-only", () => ({}));
const url = process.env.VERSION_TEST_DATABASE_URL;
const enabled = Boolean(
  url &&
  process.env.DATABASE_URL === url &&
  ["127.0.0.1", "localhost"].includes(new URL(url).hostname) &&
  new URL(url).pathname === "/tidy_versions_test",
);
const integration = enabled ? test : test.skip;
const fixture = crypto.randomUUID(),
  file = `versions-${fixture}`,
  organization = `org-${file}`,
  other = `foreign-${file}`;
const actor = `actor-${fixture}`,
  peer = `peer-${fixture}`,
  outsider = `outsider-${fixture}`;
const asset = crypto.randomUUID(),
  second = crypto.randomUUID();
let client: pg.Client,
  versions: typeof import("./file-versions"),
  commands: typeof import("./commands");
const initial = () =>
  parseDesignDocument({
    ...blankDesignDocument(),
    legacyConverted: true,
    nodes: [
      {
        ...buildDrawnNode("frame", "artboard", null, { x: 0, y: 0, width: 400, height: 300 }),
        style: { fill: "#ffffff" },
      },
      {
        ...buildDrawnNode("text", "text", "frame", { x: 20, y: 20, width: 250, height: 60 }),
        text: "Original",
        style: { fontFamily: "monospace", fontSize: 22 },
      },
      {
        ...buildDrawnNode("image", "container", "frame", {
          x: 20,
          y: 120,
          width: 180,
          height: 100,
        }),
        type: "image",
        assetId: asset,
        style: {
          imageCrop: {
            x: 0.1,
            y: 0.1,
            width: 0.8,
            height: 0.8,
            sourceWidth: 400,
            sourceHeight: 200,
          },
        },
      },
    ],
  });
const snapshot = async () =>
  (
    await client.query<{ revision: number; content: ReturnType<typeof initial> }>(
      'select "revision","content" from "designDocument" where "fileId"=$1',
      [file],
    )
  ).rows[0];
const edit = async (text: string) => {
  const before = await snapshot(),
    after = {
      ...before.content,
      nodes: before.content.nodes.map((node) => (node.id === "text" ? { ...node, text } : node)),
    };
  return commands.commitDocumentPatch(
    actor,
    file,
    crypto.randomUUID(),
    before.revision,
    diffDocument(before.content, after),
    false,
  );
};
const restore = (
  versionId: string,
  expectedRevision: number,
  operationId = crypto.randomUUID(),
  user = actor,
) =>
  commands.commitDocumentPatch(
    user,
    file,
    operationId,
    expectedRevision,
    [],
    false,
    undefined,
    undefined,
    undefined,
    { versionId, expectedRevision },
  );
beforeAll(async () => {
  if (!enabled) return;
  client = new pg.Client({ connectionString: process.env.VERSION_SETUP_DATABASE_URL ?? url });
  await client.connect();
  versions = await import("./file-versions");
  commands = await import("./commands");
  for (const id of [actor, peer, outsider])
    await client.query(
      'insert into "user" ("id","name","email","emailVerified") values ($1,$1,$2,true)',
      [id, `${id}@example.invalid`],
    );
  for (const [id, creator] of [
    [organization, actor],
    [other, outsider],
  ])
    await client.query(
      'insert into "organization" ("id","name","slug","createdAt","createdByUserId") values ($1,$1,$1,now(),$2)',
      [id, creator],
    );
  await client.query(
    'insert into "billingPlanPrice" ("priceId") values (\'price_multiplayer_fixture\') on conflict do nothing',
  );
  await client.query(
    'insert into "organization_billing" ("organizationId","stripeStatus","stripePriceId") values ($1,\'active\',\'price_multiplayer_fixture\')',
    [organization],
  );
  for (const [user, org] of [
    [actor, organization],
    [peer, organization],
    [outsider, other],
    [actor, other],
  ])
    await client.query(
      'insert into "member" ("id","organizationId","userId","role","createdAt") values ($1,$2,$3,$4,now())',
      [`${user}-${org}`, org, user, org === other && user === actor ? "viewer" : "owner"],
    );
  await client.query(
    'insert into "designFile" ("id","organizationId","name","createdBy") values ($1,$2,\'Versions\',$3)',
    [file, organization, actor],
  );
  for (const id of [asset, second])
    await client.query(
      'insert into "designAsset" ("id","organizationId","mimeType","sha256","body","byteSize") values ($1,$2,\'image/png\',$1,$3,3)',
      [id, organization, Buffer.from([1, 2, 3])],
    );
  await client.query('insert into "designDocument" ("fileId","content") values ($1,$2::jsonb)', [
    file,
    JSON.stringify(initial()),
  ]);
});
afterAll(async () => {
  if (!enabled) return;
  // Deleting organizations must still cascade through historical asset pins.
  await client.query('delete from "organization" where "id"=any($1::text[])', [
    [organization, other],
  ]);
  for (const id of [actor, peer, outsider])
    await client.query('delete from "user" where "id"=$1', [id]);
  await client.end();
  const { db } = await import("@/lib/db");
  await db.end();
});
integration("automatic checkpoints cover direct writes and pin historical originals", async () => {
  const first = (await versions.listFileVersions(actor, file)).versions[0];
  expect(first.kind).toBe("automatic");
  expect(first.revision).toBe(1);
  expect(
    (
      await client.query('select "assetId" from "designFileVersionAsset" where "versionId"=$1', [
        first.id,
      ])
    ).rows,
  ).toEqual([{ assetId: asset }]);
  await expect(client.query('delete from "designAsset" where "id"=$1', [asset])).rejects.toThrow();
  await client.query(
    'update "designFileVersion" set "createdAt"=now()-interval \'6 minutes\' where "id"=$1',
    [first.id],
  );
  await client.query(
    'update "designDocument" set "content"=jsonb_set("content",\'{nodes,1,text}\',\'"Direct MCP-style write"\'),"revision"="revision"+1 where "fileId"=$1',
    [file],
  );
  const next = (await versions.listFileVersions(actor, file)).versions[0];
  expect(next.revision).toBe(2);
  expect(Number(next.sequence)).toBeGreaterThan(Number(first.sequence));
  expect((await versions.readFileVersion(actor, file, first.id)).content.nodes[1].text).toBe(
    "Original",
  );
});
integration(
  "named checkpoints are immutable, idempotent and survive more than the local undo window",
  async () => {
    const before = await snapshot(),
      id = crypto.randomUUID();
    await versions.createFileVersion(actor, file, "Before many edits", before.revision, id);
    for (let index = 0; index < 55; index++) await edit(`Edit ${index}`);
    expect((await versions.readFileVersion(peer, file, id)).content).toEqual(before.content);
    expect(
      await versions.createFileVersion(actor, file, "Before many edits", before.revision, id),
    ).toBe(id);
    await expect(
      versions.createFileVersion(actor, file, "Different", before.revision, id),
    ).rejects.toThrow("different checkpoint");
    await expect(versions.createFileVersion(actor, file, "Stale", before.revision)).rejects.toThrow(
      "file changed",
    );
  },
);
integration(
  "restore is atomic, audited, reversible and preserves current comment routing",
  async () => {
    const target = (await versions.listFileVersions(actor, file)).versions.find(
      (version) => version.name === "Before many edits",
    )!;
    const current = await snapshot();
    await client.query(
      'update "designDocument" set "content"=jsonb_set("content",\'{commentPages}\',\'{"thread":"page-1"}\') where "fileId"=$1',
      [file],
    );
    const before = await snapshot(),
      operation = crypto.randomUUID();
    const result = await restore(target.id, before.revision, operation);
    expect(result.snapshot.content.nodes[1].text).toBe("Direct MCP-style write");
    expect(result.snapshot.content.commentPages).toEqual({ thread: "page-1" });
    const audit = (
      await client.query(
        'select * from "designFileRestore" where "fileId"=$1 and "operationId"=$2',
        [file, operation],
      )
    ).rows[0];
    expect(audit.createdBy).toBe(actor);
    expect(audit.createdByName).toBe(actor);
    expect(audit.restoredVersionId).toBe(target.id);
    expect((await versions.readFileVersion(actor, file, audit.beforeVersionId)).content).toEqual(
      before.content,
    );
    const retry = await restore(target.id, before.revision, operation);
    expect(retry.snapshot.revision).toBe(result.snapshot.revision);
    expect(
      (
        await client.query(
          'select count(*)::int as count from "designFileRestore" where "fileId"=$1',
          [file],
        )
      ).rows[0].count,
    ).toBe(1);
    const undone = await commands.commitDocumentPatch(
      actor,
      file,
      crypto.randomUUID(),
      retry.snapshot.revision,
      invertPatch(result.patch),
      true,
      undefined,
      result.sequence,
    );
    expect(undone.snapshot.content.nodes[1].text).toBe(current.content.nodes[1].text);
    const reopened = await restore(audit.beforeVersionId, undone.snapshot.revision);
    expect(reopened.snapshot.content).toEqual(before.content);
  },
);
integration("two simultaneous restores cannot overwrite a newer accepted revision", async () => {
  const entries = (await versions.listFileVersions(actor, file)).versions,
    current = await snapshot();
  const named = entries.find((version) => version.name === "Before many edits")!;
  const results = await Promise.allSettled([
    restore(entries.at(-1)!.id, current.revision),
    restore(named.id, current.revision, crypto.randomUUID(), peer),
  ]);
  expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
  const failed = results.find((result) => result.status === "rejected") as PromiseRejectedResult;
  expect(failed.reason.message).toContain("file changed");
});
integration("history and restoration enforce membership, roles and file identity", async () => {
  const entry = (await versions.listFileVersions(actor, file)).versions[0],
    current = await snapshot();
  await expect(versions.readFileVersion(outsider, file, entry.id)).rejects.toThrow("access denied");
  await expect(versions.listFileVersions(outsider, file)).rejects.toThrow("access denied");
  await expect(restore(entry.id, current.revision, crypto.randomUUID(), outsider)).rejects.toThrow(
    "access denied",
  );
  await client.query(
    'update "member" set "role"=\'viewer\' where "organizationId"=$1 and "userId"=$2',
    [organization, peer],
  );
  expect((await versions.readFileVersion(peer, file, entry.id)).version.id).toBe(entry.id);
  await expect(versions.createFileVersion(peer, file, "Denied", current.revision)).rejects.toThrow(
    "Editor access",
  );
  await expect(restore(entry.id, current.revision, crypto.randomUUID(), peer)).rejects.toThrow(
    "access denied",
  );
  const foreignFile = `foreign-file-${fixture}`;
  await client.query(
    'insert into "designFile" ("id","organizationId","name","createdBy") values ($1,$2,\'Foreign\',$3)',
    [foreignFile, other, outsider],
  );
  await client.query('insert into "designDocument" ("fileId","content") values ($1,$2::jsonb)', [
    foreignFile,
    JSON.stringify({ ...blankDesignDocument(), legacyConverted: true }),
  ]);
  const foreign = (await versions.listFileVersions(actor, foreignFile)).versions[0];
  await expect(restore(foreign.id, current.revision)).rejects.toThrow("Version not found");
});
integration(
  "history pagination has stable sequence ordering without duplicate entries",
  async () => {
    const current = await snapshot();
    for (let index = 0; index < 25; index++)
      await versions.createFileVersion(actor, file, `Checkpoint ${index}`, current.revision);
    const first = await versions.listFileVersions(actor, file),
      secondPage = await versions.listFileVersions(actor, file, first.nextCursor!);
    expect(first.versions).toHaveLength(20);
    expect(first.nextCursor).toBeTruthy();
    const all = [...first.versions, ...secondPage.versions];
    expect(new Set(all.map((version) => version.id)).size).toBe(all.length);
    expect(
      all.every(
        (version, index) => !index || BigInt(all[index - 1].sequence) > BigInt(version.sequence),
      ),
    ).toBe(true);
  },
);
