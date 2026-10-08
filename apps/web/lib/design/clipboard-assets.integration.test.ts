import { afterAll, beforeAll, beforeEach, expect, mock, test } from "bun:test";
import { createHash } from "node:crypto";
import { Client } from "pg";
import { db } from "../db";
import { runWithRequestSignal } from "../request-lifecycle";

mock.module("server-only", () => ({}));
const { transferClipboardAssets } = await import("./clipboard-assets");
const testUrl = process.env.CLIPBOARD_TEST_DATABASE_URL;
const setupUrl = process.env.CLIPBOARD_SETUP_DATABASE_URL;
const enabled = Boolean(
  testUrl &&
  setupUrl &&
  process.env.DATABASE_URL === testUrl &&
  new URL(testUrl).hostname === "127.0.0.1" &&
  new URL(testUrl).pathname === "/tidy_clipboard_test" &&
  new URL(setupUrl).hostname === "127.0.0.1" &&
  new URL(setupUrl).pathname === "/tidy_clipboard_test" &&
  new URL(setupUrl).port === new URL(testUrl).port,
);
const integration = enabled ? test : test.skip;
const sourceOrg = "a-source",
  targetOrg = "b-target",
  foreignOrg = "c-foreign";
const sourceId = "00000000-0000-4000-8000-000000000001",
  secondId = "00000000-0000-4000-8000-000000000002",
  targetId = "00000000-0000-4000-8000-000000000003",
  foreignId = "00000000-0000-4000-8000-000000000004";
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRz0AAAAASUVORK5CYII=",
  "base64",
);
const second = Buffer.concat([png, Buffer.from([1])]);
const symbol = Symbol.for("__cloudflare-context__");
const globals = globalThis as unknown as Record<symbol, unknown>;
let previous: unknown, admin: Client, gets: number, puts: number;
let onGet: ((key: string) => Promise<void>) | undefined,
  onPut: ((key: string) => Promise<void>) | undefined;
const objects = new Map<string, { bytes: Buffer; sha256: string; declaredSize?: number }>();
const keyFor = (org: string, bytes: Buffer) =>
  `originals/${org}/${createHash("sha256").update(bytes).digest("hex")}.png`;
const sourceKey = keyFor(sourceOrg, png);
const input = (assetIds = [sourceId], sourceFile = "source-file") => ({ sourceFile, assetIds });
const copy = (
  assetIds = [sourceId],
  actor = "dual",
  target = "target-file",
  source = "source-file",
) => transferClipboardAssets(actor, target, input(assetIds, source));
async function addAsset(id: string, org: string, bytes: Buffer, legacy = false) {
  const digest = createHash("sha256").update(bytes).digest("hex"),
    key = keyFor(org, bytes);
  await admin.query(
    `insert into "designAsset" ("id","organizationId","mimeType","sha256","body","objectKey","byteSize") values ($1,$2,'image/png',$3,$4,$5,$6)`,
    [id, org, digest, legacy ? bytes : null, legacy ? null : key, bytes.length],
  );
  if (!legacy) objects.set(key, { bytes, sha256: digest });
}
async function state() {
  return (
    await admin.query(
      `select jsonb_build_object(
    'assets',(select jsonb_agg(a order by "id") from "designAsset" a where "organizationId"=$1),
    'claims',(select jsonb_agg(o order by "objectKey") from "designObject" o where "organizationId"=$1)
  ) as value`,
      [targetOrg],
    )
  ).rows[0].value;
}
async function waitForBlock(client: Client, pid: number) {
  let blocked = false;
  for (let attempt = 0; attempt < 100 && !blocked; attempt++) {
    blocked = (await client.query("select cardinality(pg_blocking_pids($1))>0 as blocked", [pid]))
      .rows[0].blocked;
    if (!blocked) await Bun.sleep(5);
  }
  expect(blocked).toBe(true);
}
beforeAll(async () => {
  if (!enabled) return;
  previous = globals[symbol];
  admin = new Client({ connectionString: setupUrl });
  await admin.connect();
});
beforeEach(async () => {
  if (!enabled) return;
  objects.clear();
  gets = 0;
  puts = 0;
  onGet = undefined;
  onPut = undefined;
  await admin.query(`truncate "user","organization" cascade; truncate "designObject";
    update "billingDeployment" set "selfHosted"=true;
    insert into "user" ("id","name","email","emailVerified") values
      ('dual','Dual','dual@example.test',true),('owner','Owner','owner@example.test',true),('outsider','Outside','outside@example.test',true);
    insert into "organization" ("id","name","slug","createdAt","createdByUserId") values
      ('a-source','Source','source',now(),'owner'),('b-target','Target','target',now(),'dual'),('c-foreign','Foreign','foreign',now(),'outsider');
    insert into "member" ("id","organizationId","userId","role","createdAt") values
      ('source-viewer','a-source','dual','viewer',now()),('target-editor','b-target','dual','editor',now()),('foreign-owner','c-foreign','dual','owner',now()),
      ('source-owner','a-source','owner','owner',now()),('outside','c-foreign','outsider','owner',now());
    insert into "designFile" ("id","organizationId","name","createdBy") values
      ('source-file','a-source','Source','owner'),('target-file','b-target','Target','dual'),('same-target','a-source','Same','owner');`);
  await addAsset(sourceId, sourceOrg, png);
  await addAsset(secondId, sourceOrg, second);
  await addAsset(targetId, targetOrg, second);
  await addAsset(foreignId, foreignOrg, png);
  globals[symbol] = {
    env: {
      HYPERDRIVE: { connectionString: testUrl },
      DESIGN_OBJECTS: {
        get: async (key: string) => {
          gets++;
          await onGet?.(key);
          const value = objects.get(key);
          return value
            ? {
                size: value.declaredSize ?? value.bytes.length,
                body: new Response(new Uint8Array(value.bytes)).body,
                arrayBuffer: async () => Uint8Array.from(value.bytes).buffer,
              }
            : null;
        },
        head: async (key: string) => {
          const value = objects.get(key);
          return value
            ? { size: value.bytes.length, customMetadata: { sha256: value.sha256 } }
            : null;
        },
        put: async (key: string, bytes: Uint8Array) => {
          puts++;
          await onPut?.(key);
          if (objects.has(key)) return null;
          const body = Buffer.from(bytes);
          objects.set(key, {
            bytes: body,
            sha256: createHash("sha256").update(body).digest("hex"),
          });
          return { etag: "fixture" };
        },
      },
    },
    ctx: {},
  };
});
afterAll(async () => {
  if (!enabled) return;
  if (previous === undefined) delete globals[symbol];
  else globals[symbol] = previous;
  await admin.end();
  await db.end();
});

integration(
  "actual restricted login copies R2 originals for source viewers into target ownership",
  async () => {
    const role = (await db.query("select current_user as actor,session_user as login")).rows[0];
    expect(role).toEqual({ actor: "tidy_runtime_fixture", login: "tidy_runtime_fixture" });
    const result = await copy([sourceId, sourceId]);
    expect(Object.keys(result)).toEqual([sourceId]);
    expect(result[sourceId]).not.toBe(sourceId);
    expect(puts).toBe(1);
    expect(gets).toBe(1);
    const asset = (
      await admin.query(
        'select "organizationId","objectKey","body" from "designAsset" where "id"=$1',
        [result[sourceId]],
      )
    ).rows[0];
    expect(asset.organizationId).toBe(targetOrg);
    expect(asset.objectKey).toBe(keyFor(targetOrg, png));
    expect(asset.body).toBeNull();
    expect(objects.get(asset.objectKey)?.bytes).toEqual(png);
    expect(JSON.stringify(result)).not.toContain("originals/");
    expect(await copy()).toEqual(result);
    expect(puts).toBe(1);
  },
);
integration(
  "same-organization reuse requires current target editing but reads no originals",
  async () => {
    await admin.query(`update "member" set "role"='editor' where "id"='source-viewer'`);
    expect(await copy([sourceId], "dual", "same-target")).toEqual({ [sourceId]: sourceId });
    expect(gets).toBe(0);
    expect(puts).toBe(0);
    await admin.query(`update "member" set "role"='viewer' where "id"='source-viewer'`);
    await expect(copy([sourceId], "dual", "same-target")).rejects.toThrow("access denied");
    expect(gets).toBe(0);
  },
);
integration(
  "legacy originals use authorized database fallback without loading foreign assets",
  async () => {
    await admin.query('delete from "designAsset" where "id"=$1', [sourceId]);
    await addAsset(sourceId, sourceOrg, png, true);
    const result = await copy();
    expect(objects.get(keyFor(targetOrg, png))?.bytes).toEqual(png);
    expect(gets).toBe(0);
    expect(
      (
        await admin.query('select "organizationId" from "designAsset" where "id"=$1', [
          result[sourceId],
        ])
      ).rows[0].organizationId,
    ).toBe(targetOrg);
    const before = await state();
    await expect(copy([sourceId, foreignId])).rejects.toThrow("inaccessible");
    expect(await state()).toEqual(before);
    expect(gets).toBe(0);
  },
);
for (const denial of [
  "unverified",
  "unknown-source-role",
  "unknown-target-role",
  "removed-source",
  "target-viewer",
  "outsider",
  "source-archived",
  "target-archived",
] as const) {
  integration(`clipboard rejects ${denial} before object reads or destination writes`, async () => {
    if (denial === "unverified")
      await admin.query(`update "user" set "emailVerified"=false where "id"='dual'`);
    if (denial === "unknown-source-role")
      await admin.query(`update "member" set "role"='viewer,owner' where "id"='source-viewer'`);
    if (denial === "unknown-target-role")
      await admin.query(`update "member" set "role"='editor,owner' where "id"='target-editor'`);
    if (denial === "removed-source")
      await admin.query(`delete from "member" where "id"='source-viewer'`);
    if (denial === "target-viewer")
      await admin.query(`update "member" set "role"='viewer' where "id"='target-editor'`);
    if (denial === "source-archived")
      await admin.query(`update "designFile" set "archivedAt"=now() where "id"='source-file'`);
    if (denial === "target-archived")
      await admin.query(`update "designFile" set "archivedAt"=now() where "id"='target-file'`);
    const before = await state();
    await expect(copy([sourceId], denial === "outsider" ? "outsider" : "dual")).rejects.toThrow(
      "access denied",
    );
    expect(gets).toBe(0);
    expect(puts).toBe(0);
    expect(await state()).toEqual(before);
  });
}
for (const revoke of [
  "source-membership",
  "verification",
  "source-archive",
  "target-role",
  "target-parent",
] as const) {
  integration(
    `queued copy rechecks ${revoke} after admission without retaining stale locks`,
    async () => {
      const blocker = new Client({ connectionString: setupUrl });
      await blocker.connect();
      let pending: Promise<unknown> | undefined;
      try {
        await blocker.query("begin");
        await blocker.query("set local lock_timeout='500ms'");
        const pid = (await blocker.query("select pg_backend_pid() as pid")).rows[0].pid;
        await blocker.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [sourceOrg]);
        pending = copy().then(
          (value) => value,
          (error) => error,
        );
        let blocked = false;
        for (let attempt = 0; attempt < 100 && !blocked; attempt++) {
          blocked = (
            await blocker.query(
              `select exists(select 1 from pg_locks l where l.locktype='advisory' and not l.granted and $1=any(pg_blocking_pids(l.pid))) as blocked`,
              [pid],
            )
          ).rows[0].blocked;
          if (!blocked) await Bun.sleep(5);
        }
        expect(blocked).toBe(true);
        if (revoke === "source-membership")
          await blocker.query(`delete from "member" where "id"='source-viewer'`);
        if (revoke === "verification")
          await blocker.query(`update "user" set "emailVerified"=false where "id"='dual'`);
        if (revoke === "source-archive")
          await blocker.query(
            `update "designFile" set "archivedAt"=now() where "id"='source-file'`,
          );
        if (revoke === "target-role")
          await blocker.query(`update "member" set "role"='viewer' where "id"='target-editor'`);
        if (revoke === "target-parent")
          await blocker.query(
            `update "designFile" set "organizationId"='c-foreign' where "id"='target-file'`,
          );
        await blocker.query("commit");
        expect(((await pending) as Error).message).toContain("access denied");
        expect(gets).toBe(0);
        expect(puts).toBe(0);
        expect((await admin.query('select 1 from "designObject"')).rowCount).toBe(0);
      } finally {
        await blocker.query("rollback").catch(() => {});
        await pending?.catch(() => {});
        await blocker.end();
      }
    },
  );
}
integration(
  "admitted source-byte reads exclude source revocation until destination publication",
  async () => {
    const revoker = new Client({ connectionString: setupUrl });
    await revoker.connect();
    let arrived!: () => void,
      finish!: () => void,
      pending: Promise<unknown> | undefined,
      reading: Promise<Record<string, string>> | undefined;
    const entered = new Promise<void>((resolve) => {
        arrived = resolve;
      }),
      release = new Promise<void>((resolve) => {
        finish = resolve;
      });
    onGet = async () => {
      arrived();
      await release;
    };
    try {
      reading = copy();
      await entered;
      const pid = (await revoker.query("select pg_backend_pid() as pid")).rows[0].pid;
      await revoker.query("set lock_timeout='2s'");
      pending = revoker.query(`delete from "member" where "id"='source-viewer'`);
      await waitForBlock(admin, pid);
      finish();
      const result = await reading;
      await pending;
      expect(
        (
          await admin.query('select "organizationId" from "designAsset" where "id"=$1', [
            result[sourceId],
          ])
        ).rows[0].organizationId,
      ).toBe(targetOrg);
      const reads = gets;
      await expect(copy()).rejects.toThrow("access denied");
      expect(gets).toBe(reads);
    } finally {
      finish();
      await reading?.catch(() => {});
      await pending?.catch(() => {});
      await revoker.end();
    }
  },
);
integration(
  "opposing cross-workspace copies share stable admission order without deadlocks",
  async () => {
    await admin.query(`update "member" set "role"='editor' where "id"='source-viewer'`);
    const [forward, reverse] = await Promise.all([
      copy(),
      copy([targetId], "dual", "source-file", "target-file"),
    ]);
    expect(
      (
        await admin.query('select "organizationId" from "designAsset" where "id"=$1', [
          forward[sourceId],
        ])
      ).rows[0].organizationId,
    ).toBe(targetOrg);
    expect(reverse[targetId]).toBe(secondId);
  },
);
integration(
  "partial copy failure rolls back all destination rows/claims and preserves immutable retry bytes",
  async () => {
    const before = await state();
    onGet = async (key) => {
      if (key === keyFor(sourceOrg, second)) throw new Error("second original unavailable");
    };
    await expect(copy([sourceId, secondId])).rejects.toThrow("unavailable");
    expect(await state()).toEqual(before);
    expect(objects.has(keyFor(targetOrg, png))).toBe(true);
    onGet = undefined;
    const result = await copy([sourceId, secondId]);
    expect(result[secondId]).toBe(targetId);
    expect(
      (await admin.query('select 1 from "designObject" where "organizationId"=$1', [targetOrg]))
        .rowCount,
    ).toBe(1);
  },
);
integration(
  "bigint aggregate and per-image/count ceilings reject before original retrieval",
  async () => {
    const ids = Array.from(
      { length: 9 },
      (_, i) => `00000000-0000-4000-8000-${String(i + 10).padStart(12, "0")}`,
    );
    for (const id of ids)
      await admin.query(
        `insert into "designAsset" ("id","organizationId","mimeType","sha256","objectKey","byteSize") values ($1,$2,'image/png',$1,$1,2000000)`,
        [id, sourceOrg],
      );
    await expect(copy(ids)).rejects.toThrow("16 MB");
    expect(gets).toBe(0);
    expect(puts).toBe(0);
    await admin.query('update "designAsset" set "byteSize"=2000001 where "id"=$1', [sourceId]);
    await expect(copy()).rejects.toThrow("smaller selection");
    expect(gets).toBe(0);
    const tooMany = Array.from(
      { length: 101 },
      (_, i) => `00000000-0000-4000-8000-${String(i + 100).padStart(12, "0")}`,
    );
    await expect(copy(tooMany)).rejects.toThrow("too many images");
    expect(gets).toBe(0);
  },
);
integration(
  "unknown legacy sizes and understated streamed bytes never publish a destination asset",
  async () => {
    objects.set(sourceKey, { bytes: Buffer.alloc(2_000_001), sha256: "fixture", declaredSize: 1 });
    await admin.query('update "designAsset" set "byteSize"=1 where "id"=$1', [sourceId]);
    const before = await state();
    await expect(copy()).rejects.toThrow("too large");
    expect(puts).toBe(0);
    expect(await state()).toEqual(before);
    await admin.query('alter table "designAsset" disable trigger "designAsset_plan"');
    try {
      await admin.query('update "designAsset" set "byteSize"=null where "id"=$1', [sourceId]);
    } finally {
      await admin.query('alter table "designAsset" enable trigger "designAsset_plan"');
    }
    const reads = gets;
    await expect(copy()).rejects.toThrow("unknown sizes");
    expect(gets).toBe(reads);
    expect(puts).toBe(0);
  },
);
integration(
  "caller cancellation during source retrieval releases authority without destination writes",
  async () => {
    let arrived!: () => void, finish!: () => void;
    const entered = new Promise<void>((resolve) => {
        arrived = resolve;
      }),
      release = new Promise<void>((resolve) => {
        finish = resolve;
      });
    onGet = async () => {
      arrived();
      await release;
    };
    const abort = new AbortController();
    const reading = runWithRequestSignal(abort.signal, () => copy()).then(
      (value) => value,
      (error) => error,
    );
    await entered;
    abort.abort(new Error("caller canceled"));
    expect(((await reading) as Error).message).toContain("caller canceled");
    finish();
    expect(puts).toBe(0);
    expect((await admin.query('select 1 from "designObject"')).rowCount).toBe(0);
  },
);
integration(
  "canceled R2 publication cannot later commit an asset even when the object put completes",
  async () => {
    let arrived!: () => void, finish!: () => void, completed!: () => void;
    const entered = new Promise<void>((resolve) => {
        arrived = resolve;
      }),
      release = new Promise<void>((resolve) => {
        finish = resolve;
      }),
      done = new Promise<void>((resolve) => {
        completed = resolve;
      });
    onPut = async () => {
      arrived();
      await release;
      completed();
    };
    const abort = new AbortController();
    const before = await state();
    const copying = runWithRequestSignal(abort.signal, () => copy()).then(
      (value) => value,
      (error) => error,
    );
    await entered;
    abort.abort(new Error("publication canceled"));
    expect(((await copying) as Error).message).toContain("publication canceled");
    finish();
    await done;
    await Bun.sleep(5);
    expect(await state()).toEqual(before);
    expect(objects.has(keyFor(targetOrg, png))).toBe(true);
  },
);

integration(
  "hosted budget failure and malformed requests stop before input/object work under restricted auth",
  async () => {
    const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    const context = globals[symbol] as { env: Record<string, unknown> };
    const { MutationBudgetError } = await import("../security/mutation-budget");
    const { ClipboardBudgetUnavailableError } = await import("./clipboard-budget");
    let mode = "denied",
      loaded = false;
    const consumed: { key: string; window: number }[] = [];
    context.env.BETTER_AUTH_SECRET = "clipboard-test-budget-secret-at-least-32-characters";
    context.env.AUTH_GUARD = {
      idFromName: (name: string) => name,
      get: () => ({
        consume: async (key: string, rule: { window: number }) => {
          consumed.push({ key, window: rule.window });
          if (mode === "unavailable") throw new Error("private guard failure");
          return { allowed: mode !== "denied", retryAfter: 19 };
        },
      }),
    };
    Object.defineProperty(globalThis, "navigator", {
      value: { userAgent: "Cloudflare-Workers" },
      configurable: true,
    });
    const load = async () => {
      loaded = true;
      return input();
    };
    const before = await state();
    try {
      await expect(transferClipboardAssets("dual", "target-file", load)).rejects.toBeInstanceOf(
        MutationBudgetError,
      );
      expect(loaded).toBe(false);
      mode = "unavailable";
      await expect(transferClipboardAssets("dual", "target-file", load)).rejects.toBeInstanceOf(
        ClipboardBudgetUnavailableError,
      );
      expect(loaded).toBe(false);
      mode = "allowed";
      await expect(
        transferClipboardAssets("dual", "target-file", async () => {
          throw new Error("Malformed transport");
        }),
      ).rejects.toThrow("Malformed transport");
      await expect(
        transferClipboardAssets("dual", "target-file", {
          sourceFile: "source-file",
          assetIds: ["invalid"],
        }),
      ).rejects.toThrow("Invalid clipboard");
      expect(consumed).toHaveLength(10);
      expect(consumed.every((row) => /^[a-f0-9]{64}$/.test(row.key))).toBe(true);
      await admin.query(`update "member" set "role"='viewer' where "id"='target-editor'`);
      await expect(transferClipboardAssets("dual", "target-file", load)).rejects.toThrow(
        "access denied",
      );
      expect(loaded).toBe(false);
      expect(consumed).toHaveLength(10);
      expect(gets).toBe(0);
      expect(puts).toBe(0);
      expect(await state()).toEqual(before);
    } finally {
      if (originalNavigator) Object.defineProperty(globalThis, "navigator", originalNavigator);
      else Reflect.deleteProperty(globalThis, "navigator");
    }
  },
);
