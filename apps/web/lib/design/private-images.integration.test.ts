import { afterAll, beforeAll, beforeEach, expect, mock, test } from "bun:test";
import { createHash } from "node:crypto";
import { Client } from "pg";
import { db } from "../db";
import { runWithRequestSignal } from "../request-lifecycle";
import { blankDesignDocument } from "./document";
mock.module("server-only", () => ({}));
const { uploadThumbnailForUser, thumbnailResponseForUser } = await import("./thumbnail-service");
const { assetResponseForUser } = await import("./asset-response");

const testUrl = process.env.IMAGES_TEST_DATABASE_URL,
  setupUrl = process.env.IMAGES_SETUP_DATABASE_URL;
const enabled = Boolean(
  testUrl &&
  setupUrl &&
  process.env.DATABASE_URL === testUrl &&
  new URL(testUrl).hostname === "127.0.0.1" &&
  new URL(setupUrl).hostname === "127.0.0.1" &&
  new URL(testUrl).pathname === "/tidy_images_test" &&
  new URL(setupUrl).pathname === "/tidy_images_test" &&
  new URL(testUrl).port === new URL(setupUrl).port,
);
const integration = enabled ? test : test.skip;
const symbol = Symbol.for("__cloudflare-context__");
const globals = globalThis as unknown as Record<symbol, unknown>;
const assetId = "00000000-0000-4000-8000-000000000011";
const foreignId = "00000000-0000-4000-8000-000000000012";
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRz0AAAAASUVORK5CYII=",
  "base64",
);
const digest = createHash("sha256").update(png).digest("hex"),
  key = `originals/a/${digest}.png`;
const version = "png-v2:3:2026-10-07T12:00:00.000Z";
const url = "https://app.example/api/files/file/thumbnail";
let admin: Client,
  previous: unknown,
  previousCaches: unknown,
  gets = 0,
  puts = 0,
  cacheReads = 0;
let onGet: (() => Promise<void>) | undefined, onPut: (() => Promise<void>) | undefined;
let objectBody: (() => ReadableStream<Uint8Array>) | undefined;
const objects = new Map<string, Buffer>(),
  cached = new Map<string, Response>(),
  waits: Promise<unknown>[] = [];
const request = (
  body: BodyInit | Buffer = new Uint8Array(png),
  selected = version,
  signal?: AbortSignal,
) =>
  new Request(`${url}?version=${encodeURIComponent(selected)}`, {
    method: "POST",
    body: body instanceof Uint8Array ? new Uint8Array(body) : body,
    signal,
    duplex: "half",
  } as RequestInit & { duplex: "half" });
const upload = (actor = "editor", req = request()) => uploadThumbnailForUser(actor, "file", req);
const assetRead = (
  actor = "viewer",
  req = new Request("https://app.example/api/assets/" + assetId),
) => assetResponseForUser(actor, assetId, req);
const thumbRead = (actor = "viewer", req = new Request(url)) =>
  thumbnailResponseForUser(actor, "file", req);
const paused = () => {
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    entered,
    release,
    hook: async () => {
      enter();
      await gate;
    },
  };
};
async function state() {
  return (
    await admin.query(`select jsonb_build_object('thumbnail',(select to_jsonb(t) from "designFileThumbnail" t where "fileId"='file'),
    'claims',(select jsonb_agg(o order by "objectKey") from "designObject" o)) as value`)
  ).rows[0].value;
}
async function blockedBy(client: Client, pid: number) {
  for (let n = 0; n < 100; n++) {
    if (
      (await client.query("select cardinality(pg_blocking_pids($1))>0 as blocked", [pid])).rows[0]
        .blocked
    )
      return;
    await Bun.sleep(5);
  }
  throw new Error("Expected a real PostgreSQL lock wait.");
}
beforeAll(async () => {
  if (!enabled) return;
  previous = globals[symbol];
  previousCaches = globalThis.caches;
  admin = new Client({ connectionString: setupUrl });
  await admin.connect();
});
beforeEach(async () => {
  if (!enabled) return;
  await Promise.all(waits.splice(0));
  objects.clear();
  cached.clear();
  gets = puts = cacheReads = 0;
  onGet = onPut = undefined;
  objectBody = undefined;
  await admin.query(`truncate "user","organization" cascade; truncate "designObject"; update "billingDeployment" set "selfHosted"=true;
    insert into "user" ("id","name","email","emailVerified") values ('editor','Editor','editor@example.test',true),('viewer','Viewer','viewer@example.test',true),('outsider','Outside','outside@example.test',true);
    insert into "organization" ("id","name","slug","createdAt","createdByUserId") values ('a','A','a',now(),'editor'),('b','B','b',now(),'outsider');
    insert into "member" ("id","organizationId","userId","role","createdAt") values ('edit','a','editor','editor',now()),('view','a','viewer','viewer',now()),('both','b','editor','editor',now()),('outside','b','outsider','owner',now());
    insert into "designFile" ("id","organizationId","name","createdBy","updatedAt") values ('file','a','File','editor','2026-10-07T12:00:00.000Z');`);
  await admin.query(
    `insert into "designDocument" ("fileId","revision","content") values ('file',3,$1)`,
    [blankDesignDocument()],
  );
  await admin.query(
    `insert into "designAsset" ("id","organizationId","mimeType","sha256","objectKey","byteSize") values ($1,'a','image/png',$2,$3,$4),($5,'b','image/png',$2,$6,$4)`,
    [assetId, digest, key, png.length, foreignId, `originals/b/${digest}.png`],
  );
  await admin.query(
    `insert into "designFileThumbnail" ("fileId","version","sha256","byteSize","body") values ('file',$1,$2,$3,$4)`,
    [version, digest, png.length, png],
  );
  objects.set(key, png);
  objects.set(`originals/b/${digest}.png`, png);
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: {
      default: {
        match: async (req: Request) => {
          cacheReads++;
          return cached.get(req.url)?.clone();
        },
        put: async (req: Request, value: Response) => {
          cached.set(req.url, value);
        },
      },
    },
  });
  globals[symbol] = {
    env: {
      HYPERDRIVE: { connectionString: testUrl },
      DESIGN_OBJECTS: {
        get: async (selected: string) => {
          gets++;
          await onGet?.();
          const value = objects.get(selected);
          return value
            ? {
                size: value.length,
                body: objectBody?.() ?? new Response(new Uint8Array(value)).body,
                arrayBuffer: async () => Uint8Array.from(value).buffer,
              }
            : null;
        },
        head: async (selected: string) => {
          const value = objects.get(selected);
          return value ? { size: value.length, customMetadata: { sha256: digest } } : null;
        },
        put: async (selected: string, value: Uint8Array) => {
          puts++;
          await onPut?.();
          if (objects.has(selected)) return null;
          objects.set(selected, Buffer.from(value));
          return { etag: "fixture" };
        },
      },
    },
    ctx: {
      waitUntil: (promise: Promise<unknown>) => {
        waits.push(promise);
      },
    },
  };
});
afterAll(async () => {
  if (!enabled) return;
  await Promise.all(waits);
  if (previous === undefined) delete globals[symbol];
  else globals[symbol] = previous;
  if (previousCaches === undefined) Reflect.deleteProperty(globalThis, "caches");
  else Object.defineProperty(globalThis, "caches", { configurable: true, value: previousCaches });
  await admin.end();
  await db.end();
});

integration(
  "restricted login publishes a version-bound thumbnail and serves private viewer images",
  async () => {
    expect((await db.query("select current_user as actor,session_user as login")).rows[0]).toEqual({
      actor: "tidy_runtime_fixture",
      login: "tidy_runtime_fixture",
    });
    expect((await upload()).status).toBe(204);
    const stored = (
      await admin.query(
        `select "objectKey","body","version" from "designFileThumbnail" where "fileId"='file'`,
      )
    ).rows[0];
    expect(stored).toEqual({ objectKey: key, body: null, version });
    const image = await thumbRead();
    expect(Buffer.from(await image.arrayBuffer())).toEqual(png);
    expect(image.headers.get("cache-control")).toBe("private, no-cache");
    expect(image.headers.get("x-content-type-options")).toBe("nosniff");
    expect(image.headers.get("content-security-policy")).toContain("sandbox");
    await Promise.all(waits);
    const reads = gets;
    expect(
      (
        await thumbRead(
          "viewer",
          new Request(url, { headers: { "if-none-match": image.headers.get("etag")! } }),
        )
      ).status,
    ).toBe(304);
    expect((await assetRead()).status).toBe(200);
    expect(gets).toBe(reads);
    expect((await assetResponseForUser("viewer", foreignId, new Request(url))).status).toBe(404);
    expect((await upload("viewer")).status).toBe(403);
  },
);

for (const denial of ["unverified", "unknown-role", "removed", "outsider"]) {
  integration(`images reject ${denial} before cache, conditional replies or R2`, async () => {
    const before = await state();
    if (denial === "unverified")
      await admin.query(
        `update "user" set "emailVerified"=false where "id" in ('editor','viewer')`,
      );
    if (denial === "unknown-role")
      await admin.query(`update "member" set "role"='viewer,owner' where "organizationId"='a'`);
    if (denial === "removed") await admin.query(`delete from "member" where "organizationId"='a'`);
    const reader = denial === "outsider" ? "outsider" : "viewer",
      writer = denial === "outsider" ? "outsider" : "editor";
    expect(
      (await assetRead(reader, new Request(url, { headers: { "if-none-match": `"${digest}"` } })))
        .status,
    ).toBe(404);
    expect((await thumbRead(reader)).status).toBe(404);
    expect((await upload(writer)).status).toBe(403);
    expect(gets + puts + cacheReads).toBe(0);
    expect(await state()).toEqual(before);
  });
}
integration("archives retain viewer thumbnails and reject new thumbnail publication", async () => {
  await admin.query(`update "designFile" set "archivedAt"=now() where "id"='file'`);
  expect((await thumbRead()).status).toBe(200);
  expect((await upload()).status).toBe(403);
  expect(puts).toBe(0);
});
integration(
  "thumbnail versions and actual transport/image bounds fail before storage",
  async () => {
    expect((await upload("editor", request(png, "old"))).status).toBe(409);
    expect((await upload("editor", request(new Uint8Array(2_000_001)))).status).toBe(413);
    expect(
      (await upload("editor", new Request(request(), { headers: { "content-encoding": "gzip" } })))
        .status,
    ).toBe(415);
    const controller = new AbortController();
    controller.abort();
    expect((await upload("editor", request(png, version, controller.signal))).status).toBe(408);
    expect((await upload("editor", request("invalid"))).status).toBe(400);
    const huge = Buffer.from(png);
    huge.writeUInt32BE(1025, 16);
    expect((await upload("editor", request(huge))).status).toBe(400);
    expect(puts).toBe(0);
  },
);

const queuedChanges = {
  membership: `delete from "member" where "id"='edit'`,
  verification: `update "user" set "emailVerified"=false where "id"='editor'`,
  archive: `update "designFile" set "archivedAt"=now() where "id"='file'`,
  parent: `update "designFile" set "organizationId"='b' where "id"='file'`,
  revision: `update "designDocument" set "revision"=4 where "fileId"='file'`,
  version: `update "designFile" set "updatedAt"='2026-10-07T12:01:00Z' where "id"='file'`,
};
for (const [change, sql] of Object.entries(queuedChanges)) {
  integration(
    `queued thumbnail publication rejects changed ${change} without R2 or claims`,
    async () => {
      const lock = new Client({ connectionString: setupUrl });
      await lock.connect();
      let pending: Promise<Response> | undefined;
      try {
        await lock.query("begin");
        await lock.query("set local lock_timeout='500ms'");
        const pid = (await lock.query("select pg_backend_pid() as pid")).rows[0].pid;
        await lock.query("select pg_advisory_xact_lock(hashtextextended('a',0))");
        pending = upload();
        let blocked = false;
        for (let n = 0; n < 100 && !blocked; n++) {
          blocked = (
            await lock.query(
              `select exists(select 1 from pg_locks where locktype='advisory' and not granted and $1=any(pg_blocking_pids(pid))) as blocked`,
              [pid],
            )
          ).rows[0].blocked;
          if (!blocked) await Bun.sleep(5);
        }
        expect(blocked).toBe(true);
        await lock.query(sql);
        await lock.query("commit");
        expect((await pending).status).toBe(
          change === "revision" || change === "version" ? 409 : 403,
        );
        expect(puts).toBe(0);
        expect(
          (await admin.query(`select count(*)::int as count from "designObject"`)).rows[0].count,
        ).toBe(0);
        expect(
          (await admin.query(`select "objectKey" from "designFileThumbnail" where "fileId"='file'`))
            .rows[0].objectKey,
        ).toBeNull();
      } finally {
        await lock.query("rollback");
        await pending;
        await lock.end();
      }
    },
  );
}
for (const [change, sql] of Object.entries(queuedChanges).filter(([name]) => name !== "parent")) {
  integration(
    `admitted thumbnail retains ${change} authority/version through object publication`,
    async () => {
      const pause = paused();
      onPut = pause.hook;
      const publishing = upload();
      await pause.entered;
      const revoker = new Client({ connectionString: setupUrl });
      await revoker.connect();
      let pending: Promise<unknown> | undefined;
      try {
        const pid = (await revoker.query("select pg_backend_pid() as pid")).rows[0].pid;
        pending = revoker.query(sql);
        await blockedBy(admin, pid);
        pause.release();
        expect((await publishing).status).toBe(204);
        await pending;
        expect((await upload()).status).toBe(
          change === "revision" || change === "version" ? 409 : 403,
        );
        expect(puts).toBe(1);
      } finally {
        pause.release();
        await publishing;
        await pending;
        await revoker.end();
      }
    },
  );
}
for (const kind of ["asset", "thumbnail"] as const) {
  integration(`${kind} reads retain viewer membership until all R2 bytes are loaded`, async () => {
    if (kind === "thumbnail") expect((await upload()).status).toBe(204);
    const pause = paused();
    onGet = pause.hook;
    const reading = kind === "asset" ? assetRead() : thumbRead();
    await pause.entered;
    const revoker = new Client({ connectionString: setupUrl });
    await revoker.connect();
    let pending: Promise<unknown> | undefined;
    try {
      const pid = (await revoker.query("select pg_backend_pid() as pid")).rows[0].pid;
      pending = revoker.query(`delete from "member" where "id"='view'`);
      await blockedBy(admin, pid);
      pause.release();
      const response = await reading;
      expect(response.status).toBe(200);
      await pending;
      expect(Buffer.from(await response.arrayBuffer())).toEqual(png);
      await Promise.all(waits);
      const count = gets + cacheReads;
      expect((await (kind === "asset" ? assetRead() : thumbRead())).status).toBe(404);
      expect(gets + cacheReads).toBe(count);
    } finally {
      pause.release();
      await reading;
      await pending;
      await revoker.end();
    }
  });
}
integration("legacy originals and metadata/cache/stream byte ceilings stay bounded", async () => {
  await admin.query(`update "designAsset" set "objectKey"=null,"body"=$1 where "id"=$2`, [
    png,
    assetId,
  ]);
  expect(Buffer.from(await (await assetRead()).arrayBuffer())).toEqual(png);
  expect(gets).toBe(0);
  await admin.query(
    `update "designAsset" set "objectKey"=$1,"body"=null,"byteSize"=3000001 where "id"=$2`,
    [key, assetId],
  );
  expect((await assetRead()).status).toBe(503);
  expect(gets + cacheReads).toBe(0);
  await admin.query(`update "designAsset" set "byteSize"=1 where "id"=$1`, [assetId]);
  objectBody = () => new Response(new Uint8Array(3_000_001)).body!;
  expect((await assetRead()).status).toBe(503);
  objectBody = undefined;
  cached.set(
    `https://app.example/__design-object-cache/${encodeURIComponent(key)}/original/v1`,
    new Response(new Uint8Array(3_000_001)),
  );
  const count = gets;
  expect((await assetRead()).status).toBe(503);
  expect(gets).toBe(count);
});
integration(
  "canceled private retrieval releases authority before a stalled R2 read completes",
  async () => {
    const pause = paused();
    onGet = pause.hook;
    const controller = new AbortController();
    const reading = assetRead("viewer", new Request(url, { signal: controller.signal }));
    await pause.entered;
    controller.abort();
    expect((await reading).status).toBe(503);
    await admin.query("set lock_timeout='500ms'");
    await admin.query(`delete from "member" where "id"='view'`);
    pause.release();
  },
);
integration(
  "canceled thumbnail put may finish externally but cannot later publish database rows",
  async () => {
    const before = await state(),
      pause = paused(),
      controller = new AbortController();
    objects.delete(key);
    onPut = pause.hook;
    const publishing = runWithRequestSignal(controller.signal, () =>
      upload("editor", request(png, version, controller.signal)),
    );
    await pause.entered;
    controller.abort();
    expect((await publishing).status).toBe(503);
    expect(await state()).toEqual(before);
    pause.release();
    await Bun.sleep(5);
    expect(objects.has(key)).toBe(true);
    expect(await state()).toEqual(before);
  },
);
integration(
  "database publication failure rolls back the claim and returns no internal error",
  async () => {
    const before = await state();
    objects.delete(key);
    await admin.query(`create function image_fixture_reject() returns trigger language plpgsql as $$begin raise exception 'private publication failure'; end$$;
    create trigger image_fixture_reject before insert or update on "designFileThumbnail" for each row execute function image_fixture_reject()`);
    try {
      const response = await upload();
      expect(response.status).toBe(503);
      expect(await response.text()).not.toContain("private publication failure");
      expect(await state()).toEqual(before);
      expect(objects.has(key)).toBe(true);
    } finally {
      await admin.query("drop function image_fixture_reject() cascade");
    }
  },
);

integration(
  "hosted image guard rejects before body, cache or object work and charges failed thumbnail requests",
  async () => {
    const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    const context = globals[symbol] as { env: Record<string, unknown> };
    let mode = "denied",
      bodyReads = 0;
    const consumed: string[] = [];
    context.env.BETTER_AUTH_SECRET = "private-images-test-budget-secret-at-least-32-characters";
    context.env.AUTH_GUARD = {
      idFromName: (name: string) => name,
      get: () => ({
        consume: async (key: string) => {
          consumed.push(key);
          if (mode === "unavailable") throw new Error("private guard error");
          return { allowed: mode !== "denied", retryAfter: 23 };
        },
      }),
    };
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: { userAgent: "Cloudflare-Workers" },
    });
    const incoming = () =>
      request(
        new ReadableStream<Uint8Array>(
          {
            pull(controller) {
              bodyReads++;
              controller.enqueue(new Uint8Array(png));
              controller.close();
            },
          },
          { highWaterMark: 0 },
        ),
      );
    try {
      const limited = await upload("editor", incoming());
      expect(limited.status).toBe(429);
      expect(limited.headers.get("retry-after")).toBe("23");
      expect((await assetRead()).status).toBe(429);
      expect((await thumbRead()).status).toBe(429);
      expect(bodyReads + cacheReads + gets + puts).toBe(0);
      mode = "unavailable";
      expect((await upload("editor", incoming())).status).toBe(503);
      expect((await assetRead()).status).toBe(503);
      expect(bodyReads + cacheReads + gets + puts).toBe(0);
      mode = "allowed";
      expect((await upload("editor", request(png, "stale"))).status).toBe(409);
      expect((await upload("editor", request("malformed"))).status).toBe(400);
      expect(consumed).toHaveLength(13);
      expect(consumed.every((value) => /^[a-f0-9]{64}$/.test(value))).toBe(true);
      await admin.query(`update "member" set "role"='viewer' where "id"='edit'`);
      expect((await upload("editor", incoming())).status).toBe(403);
      expect(bodyReads).toBe(0);
      expect(consumed).toHaveLength(13);
    } finally {
      if (originalNavigator) Object.defineProperty(globalThis, "navigator", originalNavigator);
      else Reflect.deleteProperty(globalThis, "navigator");
    }
  },
);

integration(
  "private image concurrency admits four bounded reads and rejects extra work without queuing",
  async () => {
    const pause = paused();
    onGet = pause.hook;
    const pending = Array.from({ length: 5 }, () => assetRead());
    try {
      const unavailable = await Promise.any(pending);
      expect(unavailable.status).toBe(503);
      expect(unavailable.headers.get("retry-after")).toBe("1");
      for (let attempt = 0; attempt < 100 && gets < 4; attempt++) await Bun.sleep(5);
      expect(gets).toBe(4);
    } finally {
      pause.release();
    }
    const responses = await Promise.all(pending);
    expect(responses.filter((r) => r.status === 200)).toHaveLength(4);
    expect((await assetRead()).status).toBe(200);
  },
);

for (const kind of ["asset", "thumbnail"] as const) {
  for (const change of ["parent", "verification"]) {
    integration(
      `${kind} admission retains no locks and rejects queued ${change} changes`,
      async () => {
        const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
        const context = globals[symbol] as { env: Record<string, unknown> };
        const pause = paused();
        let consumed = 0;
        context.env.BETTER_AUTH_SECRET = "private-images-test-budget-secret-at-least-32-characters";
        context.env.AUTH_GUARD = {
          idFromName: (name: string) => name,
          get: () => ({
            consume: async () => {
              consumed++;
              if (consumed === 1) await pause.hook();
              return { allowed: true };
            },
          }),
        };
        Object.defineProperty(globalThis, "navigator", {
          configurable: true,
          value: { userAgent: "Cloudflare-Workers" },
        });
        const reading = kind === "asset" ? assetRead("editor") : thumbRead("editor");
        try {
          await pause.entered;
          await admin.query("set lock_timeout='500ms'");
          if (change === "verification")
            await admin.query(`update "user" set "emailVerified"=false where "id"='editor'`);
          else if (kind === "asset") {
            await admin.query(`delete from "designAsset" where "id"=$1`, [foreignId]);
            await admin.query(`update "designAsset" set "organizationId"='b' where "id"=$1`, [
              assetId,
            ]);
          } else
            await admin.query(`update "designFile" set "organizationId"='b' where "id"='file'`);
          pause.release();
          expect((await reading).status).toBe(404);
          expect(gets + cacheReads).toBe(0);
          expect(consumed).toBe(4);
        } finally {
          pause.release();
          await reading;
          if (originalNavigator) Object.defineProperty(globalThis, "navigator", originalNavigator);
          else Reflect.deleteProperty(globalThis, "navigator");
        }
      },
    );
  }
}
