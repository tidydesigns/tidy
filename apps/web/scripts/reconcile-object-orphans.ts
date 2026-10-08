// Operator-only inventory by default. No public endpoint and no credentials in arguments.
import { createReconciliationBucket } from "../lib/storage/s3-reconciliation";
import { Client } from "pg";
import {
  reconcileOrphanObject,
  type OrphanStore,
  type ObjectStamp,
} from "../lib/storage/orphan-reconciliation";

const args = process.argv.slice(2);
const value = (name: string) =>
  args.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1);
if (
  args.some(
    (arg) =>
      arg !== "--apply" &&
      arg !== "--writes-paused" &&
      !/^--(store|target|bucket|after|limit)=/.test(arg),
  )
)
  throw new Error(
    "Use --store=design|feedback, --apply, --writes-paused, --target=..., --bucket=..., --after=... and --limit=1..1000.",
  );
const store = value("--store") as OrphanStore;
if (store !== "design" && store !== "feedback")
  throw new Error("Choose --store=design or --store=feedback.");
const apply = args.includes("--apply");
// A database connection loss could release its fence with an R2 DELETE still in
// flight. Operator-enforced write quiescence is required throughout an apply run.
if (apply && !args.includes("--writes-paused"))
  throw new Error(
    "Pause and drain uploads, document/agent asset publication and operator backfills, then confirm --writes-paused.",
  );
const limit = Number(value("--limit") ?? 100);
if (!Number.isInteger(limit) || limit < 1 || limit > 1000)
  throw new Error("Limit must be 1..1000 objects.");
const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required.");
const database = new URL(connectionString);
const target = `${database.hostname}:${database.port || "5432"}${database.pathname}`;
const bucketName =
  store === "design"
    ? (process.env.DESIGN_OBJECTS_BUCKET ?? "tidy-design-objects")
    : (process.env.FEEDBACK_IMAGES_BUCKET ?? "tidy-feedback-images");
if (apply && (value("--target") !== target || value("--bucket") !== bucketName))
  throw new Error(`Confirm --target=${target} and --bucket=${bucketName}.`);
const account = process.env.CLOUDFLARE_ACCOUNT_ID;
const accessKeyId = process.env.R2_ACCESS_KEY_ID;
const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
if (!account || !accessKeyId || !secretAccessKey)
  throw new Error("R2 operator credentials are required.");
const bucket = createReconciliationBucket({
  bucket: bucketName,
  endpoint: `https://${account}.r2.cloudflarestorage.com`,
  region: "auto",
  accessKeyId,
  secretAccessKey,
});
const client = new Client({
  connectionString,
  connectionTimeoutMillis: 10_000,
  query_timeout: 10_000,
});
await client.connect();
try {
  // The collector relies on these database writers sharing the organization lock.
  if (store === "design") {
    const schema = await client.query<{ count: string }>(`select count(*) from pg_trigger t
      join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace
      join pg_proc p on p.oid=t.tgfoid join pg_namespace pn on pn.oid=p.pronamespace
      where n.nspname='public' and pn.nspname='public' and p.proname='enforceStoragePlan'
      and c.relname in ('designObject','designAsset','githubReviewAsset','githubCapture','designFileThumbnail')
      and not t.tgisinternal and t.tgenabled in ('O','A')
      and pg_get_functiondef(p.oid) like '%pg_advisory_xact_lock(hashtextextended(org, 0))%'`);
    if (Number(schema.rows[0].count) !== 5)
      throw new Error(
        "Reviewed design storage lock/thumbnail migration must be applied before reconciliation.",
      );
  }
  const page = await bucket.list({
    prefix: store === "design" ? "originals/" : "feedback/",
    maxKeys: limit,
    startAfter: value("--after"),
  });
  const counts: Record<string, number> = {};
  let after = value("--after") ?? "";
  for (const object of page.contents ?? []) {
    const listed: ObjectStamp = {
      etag: object.eTag ?? "",
      size: object.size ?? -1,
      lastModified: new Date(object.lastModified ?? ""),
    };
    const result = await reconcileOrphanObject(client, bucket, store, object.key, listed, apply);
    counts[result] = (counts[result] ?? 0) + 1;
    after = object.key;
  }
  // The cursor contains a private object key: store it only in restricted operator logs.
  console.log(
    JSON.stringify({
      store,
      target,
      bucket: bucketName,
      apply,
      scanned: (page.contents ?? []).length,
      counts,
      more: Boolean(page.isTruncated),
      after,
    }),
  );
} finally {
  await client.end();
}
