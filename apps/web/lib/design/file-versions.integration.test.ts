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
integration(
  "committed edits and retries acknowledge while the realtime room is stalled",
  async () => {
    const services = await import("./document-service");
    const id = `relay-${fixture}`;
    const key = Symbol.for("__cloudflare-context__");
    const globals = globalThis as unknown as Record<symbol, unknown>;
    const previous = globals[key];
    const deliveries: Promise<unknown>[] = [];
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let pending: Promise<unknown> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let relayed = 0;
    try {
      await client.query(
        'insert into "designFile" ("id","organizationId","name","createdBy") values ($1,$2,$1,$3)',
        [id, organization, actor],
      );
      await client.query(
        'insert into "designDocument" ("fileId","content") values ($1,$2::jsonb)',
        [id, JSON.stringify(initial())],
      );
      globals[key] = {
        env: {
          HYPERDRIVE: { connectionString: url },
          FILE_ROOMS: {
            getByName: () => ({
              sync: () => {
                relayed++;
                return held;
              },
            }),
          },
        },
        ctx: { waitUntil: (task: Promise<unknown>) => deliveries.push(task) },
      };
      pending = (async () => {
        const before = initial();
        const patch = diffDocument(before, {
          ...before,
          nodes: before.nodes.map((node) =>
            node.id === "text" ? { ...node, text: "Immediate receipt" } : node,
          ),
        });
        const operation = crypto.randomUUID();
        const first = await commands.commitDocumentPatch(actor, id, operation, 1, patch, false);
        const retry = await commands.commitDocumentPatch(actor, id, operation, 1, patch, false);
        expect(retry.snapshot.revision).toBe(first.snapshot.revision);
        const next = await services.patchDocumentNode(actor, id, first.snapshot.revision, "text", {
          text: "Next edit",
        });
        const stored = (
          await client.query(
            'select "revision","content" from "designDocument" where "fileId"=$1',
            [id],
          )
        ).rows[0];
        expect(stored.revision).toBe(next.revision);
        expect(stored.content.nodes[1].text).toBe("Next edit");
        expect(
          (
            await client.query(
              'select count(*)::int as count from "designRealtimeOperation" where "fileId"=$1 and "operationId"=$2',
              [id, operation],
            )
          ).rows[0].count,
        ).toBe(1);
        expect(relayed).toBe(3);
        expect(deliveries).toHaveLength(3);
        return "acknowledged";
      })();
      const result = await Promise.race([
        pending,
        new Promise<string>((resolve) => {
          timer = setTimeout(() => resolve("waiting for relay"), 1500);
        }),
      ]);
      expect(result).toBe("acknowledged");
    } finally {
      clearTimeout(timer);
      release();
      await pending?.catch(() => {});
      await Promise.all(deliveries);
      if (previous === undefined) delete globals[key];
      else globals[key] = previous;
      await client.query('delete from "designFile" where "id"=$1', [id]);
    }
  },
);
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

integration(
  "history accounting bounds named versions and lets automatic edits continue at capacity",
  async () => {
    const limited = `limited-${fixture}`;
    await client.query(
      'insert into "designFile" ("id","organizationId","name","createdBy") values ($1,$2,\'Limited\',$3)',
      [limited, organization, actor],
    );
    await client.query('insert into "designDocument" ("fileId","content") values ($1,$2::jsonb)', [
      limited,
      JSON.stringify(initial()),
    ]);
    try {
      await client.query(
        `insert into "designFileVersion" ("fileId","revision","content","name","kind","createdBy")
      select d."fileId",d."revision",d."content",'Checkpoint '||n,'named',$2
      from "designDocument" d cross join generate_series(1,200) n where d."fileId"=$1`,
        [limited, actor],
      );
      await expect(versions.createFileVersion(actor, limited, "Overflow", 1)).rejects.toThrow(
        "file_history_capacity",
      );
      const version = (await versions.listFileVersions(actor, limited)).versions[0];
      await expect(
        commands.commitDocumentPatch(
          actor,
          limited,
          crypto.randomUUID(),
          1,
          [],
          false,
          undefined,
          undefined,
          undefined,
          { versionId: version.id, expectedRevision: 1 },
        ),
      ).rejects.toThrow("file_history_capacity");
      expect(
        (await client.query('select "revision" from "designDocument" where "fileId"=$1', [limited]))
          .rows[0].revision,
      ).toBe(1);
      await client.query(
        'update "designFileVersion" set "createdAt"=now()-interval \'6 minutes\' where "fileId"=$1',
        [limited],
      );
      await client.query('update "designDocument" set "revision"="revision"+1 where "fileId"=$1', [
        limited,
      ]);
      expect(
        (
          await client.query('select "versions" from "fileHistoryUsage" where "fileId"=$1', [
            limited,
          ])
        ).rows[0].versions,
      ).toBe(200);
      expect(
        (await client.query('select "revision" from "designDocument" where "fileId"=$1', [limited]))
          .rows[0].revision,
      ).toBe(2);
      await expect(
        client.query('update "designFileVersion" set "content"=\'{}\'::jsonb where "id"=$1', [
          version.id,
        ]),
      ).rejects.toThrow("immutable");
    } finally {
      await client.query('delete from "designFile" where "id"=$1', [limited]);
    }
    const totals = (
      await client.query(
        `select u."bytes", (select coalesce(sum(v."byteSize"),0) from "designFileVersion" v join "designFile" f on f."id"=v."fileId" where f."organizationId"=u."organizationId") as actual
    from "organizationHistoryUsage" u where u."organizationId"=$1`,
        [organization],
      )
    ).rows[0];
    expect(totals.bytes).toBe(totals.actual);
  },
);

integration(
  "concurrent files roll workspace history within one byte allowance and duplicate inserts do not charge it",
  async () => {
    const concurrent = `concurrent-${fixture}`;
    await client.query(
      'insert into "designFile" ("id","organizationId","name","createdBy") values ($1,$2,\'Concurrent\',$3)',
      [concurrent, organization, actor],
    );
    await client.query('insert into "designDocument" ("fileId","content") values ($1,$2::jsonb)', [
      concurrent,
      JSON.stringify(initial()),
    ]);
    try {
      const size = Number(
        (
          await client.query(
            'select max("byteSize") as bytes from "designFileVersion" where "fileId"=any($1::text[])',
            [[file, concurrent]],
          )
        ).rows[0].bytes,
      );
      // Simulate existing history near the workspace ceiling without allocating 1 GB.
      await client.query(
        'update "organizationHistoryUsage" set "bytes"=1000000000-$2 where "organizationId"=$1',
        [organization, size],
      );
      const current = await snapshot();
      const results = await Promise.allSettled([
        versions.createFileVersion(actor, file, "Racing A", current.revision),
        versions.createFileVersion(actor, concurrent, "Racing B", 1),
      ]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(2);
      const usage = Number(
        (
          await client.query(
            'select "bytes" from "organizationHistoryUsage" where "organizationId"=$1',
            [organization],
          )
        ).rows[0].bytes,
      );
      expect(usage).toBeLessThanOrEqual(1_000_000_000);
      const accepted = results.find(
        (r) => r.status === "fulfilled",
      ) as PromiseFulfilledResult<string>;
      const acceptedFile = results[0].status === "fulfilled" ? file : concurrent;
      await client.query(
        `insert into "designFileVersion" ("id","fileId","revision","content","kind")
      select "id","fileId","revision","content",'automatic' from "designFileVersion" where "id"=$1 on conflict do nothing`,
        [accepted.value],
      );
      expect(
        Number(
          (
            await client.query(
              'select "bytes" from "organizationHistoryUsage" where "organizationId"=$1',
              [organization],
            )
          ).rows[0].bytes,
        ),
      ).toBe(usage);
      expect((await versions.readFileVersion(actor, acceptedFile, accepted.value)).version.id).toBe(
        accepted.value,
      );
    } finally {
      await client.query(
        `update "organizationHistoryUsage" u set "bytes"=(select coalesce(sum(v."byteSize"),0) from "designFileVersion" v join "designFile" f on f."id"=v."fileId" where f."organizationId"=u."organizationId") where u."organizationId"=$1`,
        [organization],
      );
      await client.query('delete from "designFile" where "id"=$1', [concurrent]);
    }
  },
);

integration("workspace moves transfer history usage and respect destination capacity", async () => {
  await client.query("begin");
  try {
    const usage = async (id: string) =>
      Number(
        (
          await client.query(
            'select coalesce((select "bytes" from "organizationHistoryUsage" where "organizationId"=$1),0) as bytes',
            [id],
          )
        ).rows[0].bytes,
      );
    const before = await usage(organization),
      destination = await usage(other);
    const bytes = Number(
      (await client.query('select "bytes" from "fileHistoryUsage" where "fileId"=$1', [file]))
        .rows[0].bytes,
    );
    await client.query('update "designFile" set "organizationId"=$2 where "id"=$1', [file, other]);
    expect(await usage(organization)).toBe(before - bytes);
    expect(await usage(other)).toBe(destination + bytes);
    expect(
      (
        await client.query(
          'select distinct "organizationId" from "designFileVersion" where "fileId"=$1',
          [file],
        )
      ).rows,
    ).toEqual([{ organizationId: other }]);
    await client.query('update "designFile" set "organizationId"=$2 where "id"=$1', [
      file,
      organization,
    ]);
    expect(await usage(organization)).toBe(before);
    expect(await usage(other)).toBe(destination);
    await client.query(
      'update "organizationHistoryUsage" set "bytes"=1000000000 where "organizationId"=$1',
      [other],
    );
    await client.query("savepoint capacity");
    await expect(
      client.query('update "designFile" set "organizationId"=$2 where "id"=$1', [file, other]),
    ).rejects.toThrow("file_history_capacity");
    await client.query("rollback to savepoint capacity");
    expect(await usage(organization)).toBe(before);
    expect(
      (await client.query('select "organizationId" from "designFile" where "id"=$1', [file]))
        .rows[0].organizationId,
    ).toBe(organization);
  } finally {
    await client.query("rollback");
  }
});

integration(
  "per-file history bytes stop named snapshots without charging the workspace",
  async () => {
    await client.query("begin");
    try {
      const before = (
        await client.query(
          'select "bytes" from "organizationHistoryUsage" where "organizationId"=$1',
          [organization],
        )
      ).rows[0].bytes;
      await client.query(`update "designFileVersion" set "kind"='named' where "fileId"=$1`, [file]);
      await client.query('update "fileHistoryUsage" set "bytes"=128000000 where "fileId"=$1', [
        file,
      ]);
      await client.query("savepoint capacity");
      await expect(
        client.query(
          `insert into "designFileVersion" ("fileId","revision","content","name","kind")
      select "fileId","revision","content",'Too large','named' from "designDocument" where "fileId"=$1`,
          [file],
        ),
      ).rejects.toThrow("file_history_capacity");
      await client.query("rollback to savepoint capacity");
      expect(
        (
          await client.query(
            'select "bytes" from "organizationHistoryUsage" where "organizationId"=$1',
            [organization],
          )
        ).rows[0].bytes,
      ).toBe(before);
    } finally {
      await client.query("rollback");
    }
  },
);

integration("workspace deletion cascades history and its accounting together", async () => {
  await client.query("begin");
  try {
    await client.query('delete from "organization" where "id"=$1', [organization]);
    for (const [table, column, id] of [
      ["organizationHistoryUsage", "organizationId", organization],
      ["fileHistoryUsage", "fileId", file],
      ["designFileVersion", "fileId", file],
    ]) {
      expect(
        (await client.query(`select 1 from "${table}" where "${column}"=$1`, [id])).rowCount,
      ).toBe(0);
    }
  } finally {
    await client.query("rollback");
  }
});

integration(
  "rolling history preserves named checkpoints and both ends of an active restore",
  async () => {
    const rolling = `rolling-${fixture}`;
    await client.query(
      'insert into "designFile" ("id","organizationId","name","createdBy") values ($1,$2,\'Rolling\',$3)',
      [rolling, organization, actor],
    );
    await client.query('insert into "designDocument" ("fileId","content") values ($1,$2::jsonb)', [
      rolling,
      JSON.stringify(initial()),
    ]);
    try {
      const target = (await versions.listFileVersions(actor, rolling)).versions[0];
      const named = await versions.createFileVersion(actor, rolling, "Keep this", 1);
      await client.query(
        `insert into "designFileVersion" ("fileId","revision","content","kind")
      select "fileId","revision","content",case when n%2=0 then 'automatic' else 'beforeRestore' end
      from "designDocument" cross join generate_series(1,198) n where "fileId"=$1`,
        [rolling],
      );
      const oldestRolling = (
        await client.query(
          `select "id" from "designFileVersion" where "fileId"=$1 and "id"<>$2 and "kind"<>'named' order by "sequence" limit 1`,
          [rolling, target.id],
        )
      ).rows[0].id;
      await client.query(
        'update "designFileVersion" set "createdAt"=now()-interval \'6 minutes\' where "fileId"=$1',
        [rolling],
      );
      const operation = crypto.randomUUID();
      await commands.commitDocumentPatch(
        actor,
        rolling,
        operation,
        1,
        [],
        false,
        undefined,
        undefined,
        undefined,
        { versionId: target.id, expectedRevision: 1 },
      );
      const receipt = (
        await client.query(
          'select "beforeVersionId" from "designFileRestore" where "fileId"=$1 and "operationId"=$2',
          [rolling, operation],
        )
      ).rows[0];
      expect(receipt).toBeTruthy();
      for (const id of [target.id, named, receipt.beforeVersionId])
        expect((await versions.readFileVersion(actor, rolling, id)).version.id).toBe(id);
      expect(
        (await client.query('select 1 from "designFileVersion" where "id"=$1', [oldestRolling]))
          .rowCount,
      ).toBe(0);
      const latest = (await versions.listFileVersions(actor, rolling)).versions[0];
      expect(latest.kind).toBe("automatic");
      expect(latest.revision).toBe(2);
      const usage = (
        await client.query(
          `select u."versions",u."bytes",count(v.*)::int as actual_count,sum(v."byteSize") as actual_bytes
      from "fileHistoryUsage" u join "designFileVersion" v on v."fileId"=u."fileId" where u."fileId"=$1 group by u."fileId"`,
          [rolling],
        )
      ).rows[0];
      expect(usage.versions).toBe(200);
      expect(usage.versions).toBe(usage.actual_count);
      expect(usage.bytes).toBe(usage.actual_bytes);
    } finally {
      await client.query('delete from "designFile" where "id"=$1', [rolling]);
    }
  },
);

integration("checkpoint creation rejects unverified accounts at the service boundary", async () => {
  await client.query('update "user" set "emailVerified"=false where "id"=$1', [actor]);
  try {
    const current = await snapshot();
    const count = (
      await client.query('select 1 from "designFileVersion" where "fileId"=$1', [file])
    ).rowCount;
    await expect(
      versions.createFileVersion(actor, file, "Unverified", current.revision),
    ).rejects.toMatchObject({ status: 403 });
    expect(
      (await client.query('select 1 from "designFileVersion" where "fileId"=$1', [file])).rowCount,
    ).toBe(count);
  } finally {
    await client.query('update "user" set "emailVerified"=true where "id"=$1', [actor]);
  }
});

integration("workspace rolling skips a file locked by another editor", async () => {
  const org = `rolling-lock-${fixture}`,
    older = `${org}-a`,
    newer = `${org}-b`;
  const locker = new pg.Client({ connectionString: process.env.VERSION_SETUP_DATABASE_URL ?? url });
  await locker.connect();
  try {
    await client.query(
      'insert into "organization" ("id","name","slug","createdAt","createdByUserId") values ($1,$1,$1,now(),$2)',
      [org, peer],
    );
    for (const id of [older, newer]) {
      await client.query(
        'insert into "designFile" ("id","organizationId","name","createdBy") values ($1,$2,$1,$3)',
        [id, org, actor],
      );
      await client.query(
        'insert into "designDocument" ("fileId","content") values ($1,$2::jsonb)',
        [id, JSON.stringify(initial())],
      );
    }
    await locker.query("begin");
    await locker.query('select 1 from "designFile" where "id"=$1 for update', [older]);
    await client.query("begin");
    await client.query("set local lock_timeout='250ms'");
    await client.query(
      'update "organizationHistoryUsage" set "bytes"=1000000000 where "organizationId"=$1',
      [org],
    );
    await client.query(
      `insert into "designFileVersion" ("fileId","revision","content","kind","name")
      select "fileId","revision","content",'named','Current' from "designDocument" where "fileId"=$1`,
      [newer],
    );
    expect(
      (await client.query('select 1 from "designFileVersion" where "fileId"=$1', [older])).rowCount,
    ).toBe(1);
    expect(
      (await client.query('select "kind" from "designFileVersion" where "fileId"=$1', [newer]))
        .rows,
    ).toEqual([{ kind: "named" }]);
  } finally {
    await client.query("rollback");
    await locker.query("rollback");
    await locker.end();
    await client.query('delete from "organization" where "id"=$1', [org]);
  }
});

integration(
  "edits and checkpoints recheck a workspace move after preflight admission",
  async () => {
    const locker = new pg.Client({
      connectionString: process.env.VERSION_SETUP_DATABASE_URL ?? url,
    });
    await locker.connect();
    const pid = (await locker.query("select pg_backend_pid() as pid")).rows[0].pid;
    try {
      await client.query(
        'insert into "organization_billing" ("organizationId","stripeStatus","stripePriceId") values ($1,\'active\',\'price_multiplayer_fixture\')',
        [other],
      );
      await client.query(
        'update "member" set "role"=\'editor\' where "organizationId"=$1 and "userId"=$2',
        [other, actor],
      );
      for (const kind of ["edit", "checkpoint"]) {
        const id = `moving-${kind}-${fixture}`;
        let pending: Promise<unknown> | undefined;
        try {
          await client.query(
            'insert into "designFile" ("id","organizationId","name","createdBy") values ($1,$2,$1,$3)',
            [id, organization, actor],
          );
          await client.query(
            'insert into "designDocument" ("fileId","content") values ($1,$2::jsonb)',
            [id, JSON.stringify(blankDesignDocument())],
          );
          await locker.query("begin");
          await locker.query('select 1 from "designFile" where "id"=$1 for update', [id]);
          pending = (
            kind === "edit"
              ? commands.commitDocumentPatch(actor, id, crypto.randomUUID(), 1, [], false)
              : versions.createFileVersion(actor, id, "Checkpoint", 1)
          ).then(
            () => null,
            (error: unknown) => error,
          );
          let blocked = false;
          for (let i = 0; i < 100 && !blocked; i++) {
            blocked = (
              await client.query(
                "select exists(select 1 from pg_stat_activity where $1=any(pg_blocking_pids(pid))) as blocked",
                [pid],
              )
            ).rows[0].blocked;
            if (!blocked) await new Promise((resolve) => setTimeout(resolve, 10));
          }
          expect(blocked).toBe(true);
          await locker.query('update "designFile" set "organizationId"=$2 where "id"=$1', [
            id,
            other,
          ]);
          await locker.query("commit");
          const result = await pending;
          expect(result).toBeInstanceOf(Error);
          expect((result as Error).message).toMatch(/moved|access/i);
          expect(
            (await client.query('select "revision" from "designDocument" where "fileId"=$1', [id]))
              .rows[0].revision,
          ).toBe(1);
          expect(
            (
              await client.query(
                'select 1 from "designFileVersion" where "fileId"=$1 and "kind"=\'named\'',
                [id],
              )
            ).rowCount,
          ).toBe(0);
        } finally {
          await locker.query("rollback");
          await pending;
          await client.query('delete from "designFile" where "id"=$1', [id]);
        }
      }
    } finally {
      await locker.end();
      await client.query(
        'update "member" set "role"=\'viewer\' where "organizationId"=$1 and "userId"=$2',
        [other, actor],
      );
      await client.query('delete from "organization_billing" where "organizationId"=$1', [other]);
    }
  },
);

integration(
  "agent palettes and layer links commit together, with conflicts and invalid edits rolled back",
  async () => {
    const services = await import("./document-service");
    const id = `token-${fixture}`;
    const before = parseDesignDocument({
      ...initial(),
      tokens: { ink: "#123456" },
      designTokens: { border: { type: "color", alias: "ink" } },
    });
    await client.query(
      'insert into "designFile" ("id","organizationId","name","createdBy") values ($1,$2,\'Tokens\',$3)',
      [id, organization, actor],
    );
    await client.query('insert into "designDocument" ("fileId","content") values ($1,$2::jsonb)', [
      id,
      JSON.stringify(before),
    ]);
    const read = async () =>
      (
        await client.query('select "revision","content" from "designDocument" where "fileId"=$1', [
          id,
        ])
      ).rows[0];
    const saved = await services.patchDocumentNodes(
      actor,
      id,
      1,
      [
        { nodeId: "frame", changes: { style: { fillToken: "paper" } } },
        { nodeId: "text", changes: { style: { colorToken: "ink" } } },
      ],
      {
        designTokens: {
          paper: { type: "color", value: "#ffffff80" },
          ink: { type: "color", value: "#123456" },
        },
      },
    );
    expect(saved.revision).toBe(2);
    expect(saved.document.nodes[0].style.fillToken).toBe("paper");
    expect(saved.document.nodes[1].style.colorToken).toBe("ink");
    expect(saved.document.designTokens?.paper).toEqual({ type: "color", value: "#ffffff80" });
    expect(saved.document.designTokens?.border).toEqual({ type: "color", alias: "ink" });
    expect(saved.document.tokens).toEqual({});
    const committed = await read();
    expect(committed).toEqual({ revision: saved.revision, content: saved.document });
    await expect(
      services.patchDocumentNode(
        actor,
        id,
        1,
        "frame",
        {},
        {
          designTokens: { stale: { type: "color", value: "#000000" } },
        },
      ),
    ).rejects.toThrow("Refresh before editing");
    await expect(
      services.patchDocumentNode(
        actor,
        id,
        2,
        "frame",
        {},
        {
          designTokens: { ink: { type: "color", alias: "border" } },
        },
      ),
    ).rejects.toThrow();
    await expect(
      services.patchDocumentNode(
        outsider,
        id,
        2,
        "frame",
        {},
        {
          designTokens: { denied: { type: "color", value: "#000000" } },
        },
      ),
    ).rejects.toThrow("access denied");
    await expect(
      services.patchDocumentNode(
        actor,
        id,
        2,
        "missing",
        {},
        {
          designTokens: { orphaned: { type: "color", value: "#000000" } },
        },
      ),
    ).rejects.toThrow("Layer not found");
    expect(await read()).toEqual(committed);
    const updated = await services.patchDocumentNode(
      actor,
      id,
      2,
      "frame",
      {},
      {
        designTokens: { paper: { type: "color", value: "#f5f1e9" } },
      },
    );
    expect(updated.revision).toBe(3);
    expect(updated.document.nodes[0].style.fillToken).toBe("paper");
    expect(updated.document.designTokens?.paper).toEqual({ type: "color", value: "#f5f1e9" });
  },
);
