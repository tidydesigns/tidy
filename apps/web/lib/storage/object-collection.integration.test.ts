import { beforeAll, afterAll, describe, expect, test } from "bun:test";
import { Client } from "pg";
import { createReconciliationBucket } from "./s3-reconciliation";
import { resolve } from "node:path";
import { collectTrackedObject } from "./object-collection";
import { reconcileOrphanObject, type ObjectStamp } from "./orphan-reconciliation";
const url = process.env.MULTIPLAYER_TEST_DATABASE_URL;
const enabled = Boolean(
  url &&
  process.env.DATABASE_URL === url &&
  ["localhost", "127.0.0.1"].includes(new URL(url).hostname) &&
  ["/tidy_storage_test", "/tidy_multiplayer_test"].includes(new URL(url).pathname),
);
const id = `gc-${crypto.randomUUID()}`,
  key = (name: string) => `${id}/${name}`;
let client: Client;
describe.skipIf(!enabled)("local Postgres object collection", () => {
  beforeAll(async () => {
    client = new Client({ connectionString: url });
    await client.connect();
    await client.query(
      `insert into "user" ("id","name","email","emailVerified") values ($1,$1,$2,true)`,
      [id, `${id}@localhost.test`],
    );
    await client.query(
      `insert into "organization" ("id","name","slug","createdAt","createdByUserId") values ($1,$1,$1,now(),$1)`,
      [id],
    );
    await client.query(
      `insert into "designFile" ("id","organizationId","name","createdBy") values ($1,$1,$1,$1)`,
      [id],
    );
    await client.query(
      `insert into "githubConnection" ("organizationId","installationId","account") values ($1,1,'local')`,
      [id],
    );
    await client.query(
      `insert into "githubReview" ("id","fileId","organizationId","installationId","repositoryId","repository","number","title","url","state","branch","baseSha","headSha","linkedSha","revision","frameIds","frameKey","content","createdBy")
      values ($1,$1,$1,1,1,'local/test',1,'test','https://example.test','open','local','base','head','head',1,'[]','test','{}',$1)`,
      [id],
    );
    for (const name of ["live", "review", "capture", "thumbnail", "recent", "orphan", "racing"])
      await client.query(
        `insert into "designObject" ("objectKey","organizationId","mimeType","sha256","byteSize","lastClaimedAt") values ($1,$2,'image/png',$3,1,now()-interval '8 days')`,
        [key(name), id, "a".repeat(64)],
      );
    await client.query(`update "designObject" set "lastClaimedAt"=now() where "objectKey"=$1`, [
      key("recent"),
    ]);
    await client.query(
      `insert into "designAsset" ("id","organizationId","mimeType","sha256","objectKey","byteSize") values ($1,$2,'image/png',$3,$4,1)`,
      [id, id, "a".repeat(64), key("live")],
    );
    await client.query(
      `insert into "githubReviewAsset" ("reviewId","assetId","mimeType","objectKey") values ($1,'deleted-live-asset','image/png',$2)`,
      [id, key("review")],
    );
    await client.query(
      `insert into "githubCapture" ("id","reviewId","frameId","sha","route","width","height","mimeType","sha256","objectKey") values ($1,$1,'frame','head','/',1,1,'image/png',$2,$3)`,
      [id, "a".repeat(64), key("capture")],
    );
    await client.query(
      `insert into "designFileThumbnail" ("fileId","version","sha256","objectKey","byteSize") values ($1,'1:local',$2,$3,1)`,
      [id, "a".repeat(64), key("thumbnail")],
    );
  });
  afterAll(async () => {
    if (!client) return;
    await client.query(`delete from "organization" where "id"=$1`, [id]);
    await client.query(`delete from "designObject" where "organizationId"=$1`, [id]);
    await client.query(`delete from "user" where "id"=$1`, [id]);
    await client.end();
  });
  test("live, review-only, capture, thumbnail and recent claims are retained", async () => {
    const deleted: string[] = [],
      bucket = {
        delete: async (key: string) => {
          deleted.push(key);
        },
      };
    for (const name of ["live", "review", "capture", "thumbnail", "recent"])
      expect(await collectTrackedObject(client, bucket, key(name))).toBe(false);
    expect(await collectTrackedObject(client, bucket, key("orphan"))).toBe(true);
    expect(deleted).toEqual([key("orphan")]);
  });
  test("reconciliation reports and removes only old untracked objects in known key namespaces", async () => {
    const stamp = { etag: "old", size: 1, lastModified: new Date(Date.now() - 8 * 86400_000) };
    let deletes = 0;
    const bucket = {
      head: async () => stamp,
      delete: async () => {
        deletes++;
      },
    };
    const designKey = `originals/${encodeURIComponent(id)}/${"c".repeat(64)}.png`;
    const feedbackKey = `feedback/${crypto.randomUUID()}/0`;
    for (const [store, objectKey] of [
      ["design", designKey],
      ["feedback", feedbackKey],
    ] as const) {
      expect(await reconcileOrphanObject(client, bucket, store, objectKey, stamp)).toBe(
        "candidate",
      );
      expect(deletes).toBe(0);
      expect(await reconcileOrphanObject(client, bucket, store, objectKey, stamp, true)).toBe(
        "removed",
      );
      deletes = 0;
    }
    for (const objectKey of [
      "other/file",
      "originals/%oops/" + "c".repeat(64) + ".png",
      "originals/%67c/" + "c".repeat(64) + ".png",
    ])
      expect(await reconcileOrphanObject(client, bucket, "design", objectKey, stamp, true)).toBe(
        "unknown-key",
      );
    expect(
      await reconcileOrphanObject(
        client,
        bucket,
        "feedback",
        feedbackKey.replace(/0$/, "3"),
        stamp,
        true,
      ),
    ).toBe("unknown-key");
    expect(deletes).toBe(0);
  });
  test("the real S3 adapter preserves listing/head revisions and identifies missing objects", async () => {
    const uploadId = crypto.randomUUID(),
      objectKey = `feedback/${uploadId}/0`;
    const stamp = new Date(Date.now() - 8 * 86400_000);
    stamp.setMilliseconds(0);
    let exists = true,
      deletes = 0;
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(request) {
        if (request.method === "DELETE") {
          exists = false;
          deletes++;
          return new Response(null, { status: 204 });
        }
        if (request.method === "HEAD")
          return exists
            ? new Response(null, {
                headers: {
                  ETag: '"fixture-etag"',
                  "Content-Length": "1",
                  "Last-Modified": stamp.toUTCString(),
                },
              })
            : new Response(null, { status: 404 });
        return new Response(
          `<ListBucketResult><Name>fixture</Name><IsTruncated>false</IsTruncated><Contents><Key>${objectKey}</Key><LastModified>${stamp.toISOString()}</LastModified><ETag>"fixture-etag"</ETag><Size>1</Size></Contents></ListBucketResult>`,
          { headers: { "Content-Type": "application/xml" } },
        );
      },
    });
    try {
      const bucket = createReconciliationBucket({
        bucket: "fixture",
        endpoint: server.url.toString(),
        region: "auto",
        accessKeyId: "fixture-key",
        secretAccessKey: "fixture-secret",
      });
      const object = (await bucket.list({ prefix: "feedback/", maxKeys: 1 })).contents![0];
      const listed = {
        etag: object.eTag!,
        size: object.size!,
        lastModified: new Date(object.lastModified!),
      };
      const adapter = bucket;
      expect(await reconcileOrphanObject(client, adapter, "feedback", objectKey, listed)).toBe(
        "candidate",
      );
      expect(deletes).toBe(0);
      expect(
        await reconcileOrphanObject(client, adapter, "feedback", objectKey, listed, true),
      ).toBe("removed");
      expect(deletes).toBe(1);
      expect(
        await reconcileOrphanObject(client, adapter, "feedback", objectKey, listed, true),
      ).toBe("missing");
      expect(deletes).toBe(1);
    } finally {
      server.stop(true);
    }
  });
  test("operator CLI defaults to reporting and rejects unconfirmed mutation targets", () => {
    const database = new URL(url!);
    const target = `${database.hostname}:${database.port}${database.pathname}`;
    for (const [store, flags, error] of [
      ["design", [], null],
      ["feedback", ["--apply"], "Pause and drain"],
      [
        "feedback",
        ["--apply", "--writes-paused", "--target=wrong", "--bucket=tidy-feedback-images"],
        "Confirm --target",
      ],
      [
        "feedback",
        ["--apply", "--writes-paused", `--target=${target}`, "--bucket=tidy-feedback-images"],
        null,
      ],
    ] as const) {
      const objectKey =
        store === "design"
          ? `originals/${encodeURIComponent(id)}/${"b".repeat(64)}.png`
          : `feedback/${crypto.randomUUID()}/0`;
      const child = Bun.spawnSync(
        [
          process.execPath,
          "--eval",
          `
        import { mock } from "bun:test";
        const key = ${JSON.stringify(objectKey)}, stamp = new Date(Date.now()-8*86400000);
        mock.module("./lib/storage/s3-reconciliation.ts", () => ({ createReconciliationBucket: () => ({
          async list(options) { if (options.maxKeys !== 1) throw new Error("Page limit lost"); return { isTruncated:false, contents:[{key,eTag:"fixture",size:1,lastModified:stamp.toISOString()}] }; },
          async head() { return {etag:"fixture",size:1,lastModified:stamp}; },
          async delete() { console.log("DELETED"); }
        }) }));
        process.argv = [process.execPath, "operator", ${["--store=" + store, "--limit=1", ...flags].map((flag) => JSON.stringify(flag)).join(",")}];
        await import("./scripts/reconcile-object-orphans.ts");
      `,
        ],
        {
          cwd: resolve(import.meta.dir, "../.."),
          env: {
            ...process.env,
            DATABASE_URL: url!,
            CLOUDFLARE_ACCOUNT_ID: "fixture",
            R2_ACCESS_KEY_ID: "fixture",
            R2_SECRET_ACCESS_KEY: "fixture",
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const stdout = new TextDecoder().decode(child.stdout),
        stderr = new TextDecoder().decode(child.stderr);
      if (error) {
        expect(child.exitCode).not.toBe(0);
        expect(stderr).toContain(error);
        expect(stdout).not.toContain("DELETED");
      } else {
        expect(child.exitCode, stderr).toBe(0);
        const report = JSON.parse(stdout.trim().split("\n").at(-1)!);
        expect(report.scanned).toBe(1);
        expect(report.counts).toEqual(
          flags.some((flag) => flag === "--apply") ? { removed: 1 } : { candidate: 1 },
        );
        expect(stdout.includes("DELETED")).toBe(flags.some((flag) => flag === "--apply"));
      }
    }
  });
  test("reconciliation retains design references without registry rows, tracked claims, and feedback metadata", async () => {
    const stamp = { etag: "old", size: 1, lastModified: new Date(Date.now() - 8 * 86400_000) };
    const bucket = {
      head: async () => {
        throw new Error("Referenced objects must not reach R2.");
      },
      delete: async () => {
        throw new Error("Cannot delete a reference.");
      },
    };
    const keys = ["live", "review", "capture", "thumbnail"].map(
      (name, index) => `originals/${encodeURIComponent(id)}/${String(index + 1).repeat(64)}.png`,
    );
    await client.query('update "designAsset" set "objectKey"=$1 where "id"=$2', [keys[0], id]);
    await client.query(
      'update "githubReviewAsset" set "objectKey"=$1, "sha256"=$3, "byteSize"=1 where "reviewId"=$2',
      [keys[1], id, "a".repeat(64)],
    );
    await client.query('update "githubCapture" set "objectKey"=$1, "byteSize"=1 where "id"=$2', [
      keys[2],
      id,
    ]);
    await client.query('update "designFileThumbnail" set "objectKey"=$1 where "fileId"=$2', [
      keys[3],
      id,
    ]);
    for (const objectKey of keys)
      expect(await reconcileOrphanObject(client, bucket, "design", objectKey, stamp, true)).toBe(
        "retained",
      );
    const trackedKey = `originals/${encodeURIComponent(id)}/${"d".repeat(64)}.png`;
    await client.query(
      'insert into "designObject" ("objectKey","organizationId","mimeType","sha256","byteSize") values ($1,$2,\'image/png\',$3,1)',
      [trackedKey, id, "d".repeat(64)],
    );
    expect(await reconcileOrphanObject(client, bucket, "design", trackedKey, stamp, true)).toBe(
      "retained",
    );
    const uploadId = crypto.randomUUID();
    await client.query(
      'insert into "feedbackUpload" ("id","userId","fingerprint","attachments") values ($1,$2,\'local\',\'[]\')',
      [uploadId, id],
    );
    expect(
      await reconcileOrphanObject(
        client,
        bucket,
        "feedback",
        `feedback/${uploadId}/0`,
        stamp,
        true,
      ),
    ).toBe("retained");
    const legacyKey = `feedback/${crypto.randomUUID()}/0`;
    await client.query('update "feedbackUpload" set "attachments"=$2 where "id"=$1', [
      uploadId,
      JSON.stringify([{ key: legacyKey, size: 1 }]),
    ]);
    expect(await reconcileOrphanObject(client, bucket, "feedback", legacyKey, stamp, true)).toBe(
      "retained",
    );
  });
  test("reconciliation rechecks object revision, age, missing objects and invalid metadata", async () => {
    const objectKey = `feedback/${crypto.randomUUID()}/0`;
    const old = { etag: "old", size: 1, lastModified: new Date(Date.now() - 8 * 86400_000) };
    let live: ObjectStamp | null = old;
    const bucket = {
      head: async () => live,
      delete: async () => {
        throw new Error("Stale inventory is not permission to delete.");
      },
    };
    for (const replacement of [
      { ...old, etag: "new" },
      { ...old, size: 2 },
      { ...old, lastModified: new Date() },
      { ...old, lastModified: new Date("invalid") },
    ]) {
      live = replacement;
      expect(await reconcileOrphanObject(client, bucket, "feedback", objectKey, old, true)).toBe(
        "changed",
      );
    }
    live = { ...old, lastModified: new Date() };
    expect(await reconcileOrphanObject(client, bucket, "feedback", objectKey, live, true)).toBe(
      "retained",
    );
    const operatorClock = Date.now;
    try {
      Date.now = () => operatorClock() + 30 * 86400_000;
      expect(await reconcileOrphanObject(client, bucket, "feedback", objectKey, live, true)).toBe(
        "retained",
      );
    } finally {
      Date.now = operatorClock;
    }
    live = null;
    expect(await reconcileOrphanObject(client, bucket, "feedback", objectKey, old, true)).toBe(
      "missing",
    );
  });
  for (const store of ["design", "feedback"] as const) {
    test(`${store} reconciliation skips an uncommitted publisher and rechecks after rollback`, async () => {
      const uploader = new Client({ connectionString: url });
      await uploader.connect();
      const uploadId = crypto.randomUUID();
      const objectKey =
        store === "design"
          ? `originals/${encodeURIComponent(id)}/${"e".repeat(64)}.png`
          : `feedback/${uploadId}/0`;
      const old = { etag: "old", size: 1, lastModified: new Date(Date.now() - 8 * 86400_000) };
      const bucket = { head: async () => old, delete: async () => {} };
      try {
        await uploader.query("begin");
        if (store === "design")
          await uploader.query(
            'insert into "designObject" ("objectKey","organizationId","mimeType","sha256","byteSize") values ($1,$2,\'image/png\',$3,1)',
            [objectKey, id, "e".repeat(64)],
          );
        else {
          await uploader.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [
            `feedback-upload:${uploadId}`,
          ]);
          await uploader.query(
            'insert into "feedbackUpload" ("id","userId","fingerprint","attachments") values ($1,$2,\'local\',\'[]\')',
            [uploadId, id],
          );
        }
        expect(await reconcileOrphanObject(client, bucket, store, objectKey, old, true)).toBe(
          "busy",
        );
        await uploader.query("rollback");
        expect(await reconcileOrphanObject(client, bucket, store, objectKey, old, true)).toBe(
          "removed",
        );
      } finally {
        await uploader.query("rollback");
        await uploader.end();
      }
    });
    test(`${store} publication waits until an in-progress deletion has finished`, async () => {
      const uploader = new Client({ connectionString: url });
      await uploader.connect();
      const uploadId = crypto.randomUUID();
      const objectKey =
        store === "design"
          ? `originals/${encodeURIComponent(id)}/${"f".repeat(64)}.png`
          : `feedback/${uploadId}/0`;
      const old = { etag: "old", size: 1, lastModified: new Date(Date.now() - 8 * 86400_000) };
      let enter!: () => void, finish!: () => void;
      const entered = new Promise<void>((resolve) => {
        enter = resolve;
      });
      const finishDelete = new Promise<void>((resolve) => {
        finish = resolve;
      });
      let exists = true,
        published = false;
      const collection = reconcileOrphanObject(
        client,
        {
          head: async () => old,
          delete: async () => {
            enter();
            await finishDelete;
            exists = false;
          },
        },
        store,
        objectKey,
        old,
        true,
      );
      await entered;
      const publication = (async () => {
        await uploader.query("begin");
        if (store === "design")
          await uploader.query(
            'insert into "designObject" ("objectKey","organizationId","mimeType","sha256","byteSize") values ($1,$2,\'image/png\',$3,1)',
            [objectKey, id, "f".repeat(64)],
          );
        else {
          await uploader.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [
            `feedback-upload:${uploadId}`,
          ]);
          await uploader.query(
            'insert into "feedbackUpload" ("id","userId","fingerprint","attachments") values ($1,$2,\'local\',\'[]\')',
            [uploadId, id],
          );
        }
        exists = true;
        published = true;
        await uploader.query("commit");
      })();
      try {
        await Bun.sleep(20);
        expect(published).toBe(false);
        finish();
        expect(await collection).toBe("removed");
        await publication;
        expect(exists).toBe(true);
        expect(
          await reconcileOrphanObject(
            client,
            {
              head: async () => {
                throw new Error("Publication must retain bytes.");
              },
              delete: async () => {},
            },
            store,
            objectKey,
            old,
            true,
          ),
        ).toBe("retained");
      } finally {
        finish();
        await Promise.allSettled([collection, publication]);
        await uploader.end();
      }
    });
  }
  for (const failure of ["bucket", "commit-response"] as const)
    test(`orphan reconciliation recovers from ${failure} failure using fresh inventory`, async () => {
      const objectKey = `feedback/${crypto.randomUUID()}/0`;
      const old = { etag: "old", size: 1, lastModified: new Date(Date.now() - 8 * 86400_000) };
      let exists = true;
      const faulty = new Proxy(client, {
        get(target, property) {
          if (property === "query")
            return async (...args: unknown[]) => {
              const result = await Reflect.apply(target.query, target, args);
              if (failure === "commit-response" && args[0] === "commit")
                throw new Error("Commit acknowledgment lost.");
              return result;
            };
          const value = Reflect.get(target, property);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      await expect(
        reconcileOrphanObject(
          faulty,
          {
            head: async () => old,
            delete: async () => {
              if (failure === "bucket") throw new Error("Unavailable");
              exists = false;
            },
          },
          "feedback",
          objectKey,
          old,
          true,
        ),
      ).rejects.toBeDefined();
      expect(exists).toBe(failure === "bucket");
      expect(
        await reconcileOrphanObject(
          client,
          {
            head: async () => (exists ? old : null),
            delete: async () => {
              exists = false;
            },
          },
          "feedback",
          objectKey,
          old,
          true,
        ),
      ).toBe(failure === "bucket" ? "removed" : "missing");
      expect(exists).toBe(false);
    });
  test("an upload claim waits for collection and recreates its registry before upload", async () => {
    const uploader = new Client({ connectionString: url });
    await uploader.connect();
    let enter!: () => void, finish!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const continueDelete = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const collection = collectTrackedObject(
      client,
      {
        delete: async () => {
          enter();
          await continueDelete;
        },
      },
      key("racing"),
    );
    await entered;
    let claimed = false;
    const claim = uploader
      .query(
        `insert into "designObject" ("objectKey","organizationId","mimeType","sha256","byteSize") values ($1,$2,'image/png',$3,1) on conflict ("objectKey") do update set "lastClaimedAt"=now()`,
        [key("racing"), id, "a".repeat(64)],
      )
      .then(() => {
        claimed = true;
      });
    try {
      await Bun.sleep(20);
      expect(claimed).toBe(false);
      finish();
      expect(await collection).toBe(true);
      await claim;
      expect(
        await collectTrackedObject(
          client,
          {
            delete: async () => {
              throw new Error("A fresh upload cannot be collected.");
            },
          },
          key("racing"),
        ),
      ).toBe(false);
    } finally {
      finish();
      await uploader.end();
    }
  });
  for (const failure of ["bucket", "database-delete", "commit-response"] as const)
    test(`collection recovers from ${failure} failure without losing its retry boundary`, async () => {
      const objectKey = key(failure);
      await client.query(
        `insert into "designObject" ("objectKey","organizationId","mimeType","sha256","byteSize","lastClaimedAt") values ($1,$2,'image/png',$3,1,now()-interval '8 days')`,
        [objectKey, id, "b".repeat(64)],
      );
      let exists = true;
      const bucket = {
        delete: async () => {
          if (failure === "bucket") throw new Error("bucket unavailable");
          exists = false;
        },
      };
      // Only the fault is simulated. Locks, deletes, rollback and commit run on Postgres.
      const faulty = new Proxy(client, {
        get(target, property) {
          if (property === "query")
            return async (...args: unknown[]) => {
              if (
                failure === "database-delete" &&
                String(args[0]).startsWith('delete from "designObject"')
              )
                throw new Error("database delete failed");
              const result = await Reflect.apply(target.query, target, args);
              if (failure === "commit-response" && args[0] === "commit")
                throw new Error("commit acknowledgment lost");
              return result;
            };
          const value = Reflect.get(target, property);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      await expect(collectTrackedObject(faulty, bucket, objectKey)).rejects.toBeDefined();
      expect(exists).toBe(failure === "bucket");
      expect(
        (await client.query('select 1 from "designObject" where "objectKey"=$1', [objectKey]))
          .rowCount,
      ).toBe(failure === "commit-response" ? 0 : 1);
      const retry = await collectTrackedObject(
        client,
        {
          delete: async () => {
            exists = false;
          },
        },
        objectKey,
      );
      expect(retry).toBe(failure !== "commit-response");
      expect(exists).toBe(false);
      expect(
        (await client.query('select 1 from "designObject" where "objectKey"=$1', [objectKey]))
          .rowCount,
      ).toBe(0);
    });
});
