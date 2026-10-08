// Explicit operator tool. Default mode only inventories rows; it never writes.
import { S3Client } from "bun";
import { Client } from "pg";
import { designObjectKey } from "../lib/storage/design-objects";
import { imageDigest, verifiedObject } from "../lib/storage/object-migration";

const args = new Set(process.argv.slice(2));
const value = (name: string) =>
  [...args].find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1);
const mode = args.has("--apply")
  ? "apply"
  : args.has("--prune")
    ? "prune"
    : args.has("--verify")
      ? "verify"
      : "check";
if (["--apply", "--prune", "--verify"].filter((flag) => args.has(flag)).length > 1)
  throw new Error("Choose one operation per run.");
const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required.");
const database = new URL(connectionString);
const target = `${database.hostname}:${database.port || "5432"}${database.pathname}`;
if (mode !== "check" && value("--target") !== target)
  throw new Error(`Confirm the database with --target=${target}.`);
const bucketName = process.env.DESIGN_OBJECTS_BUCKET ?? "tidy-design-objects";
const client = new Client({ connectionString });
const tables = [
  {
    name: "designFileThumbnail",
    identity: 'a."fileId"',
    keys: ['"fileId"'],
    organization: 'f."organizationId"',
    join: 'join "designFile" f on f."id"=a."fileId"',
  },
  {
    name: "designAsset",
    identity: 'a."id"',
    keys: ['"id"'],
    organization: 'a."organizationId"',
    join: "",
  },
  {
    name: "githubReviewAsset",
    identity: 'a."reviewId" || chr(9) || a."assetId"',
    keys: ['"reviewId"', '"assetId"'],
    organization: 'r."organizationId"',
    join: 'join "githubReview" r on r."id"=a."reviewId"',
  },
  {
    name: "githubCapture",
    identity: 'a."id"',
    keys: ['"id"'],
    organization: 'r."organizationId"',
    join: 'join "githubReview" r on r."id"=a."reviewId"',
  },
];
await client.connect();
try {
  if (mode === "check") {
    for (const table of tables) {
      const result = await client.query(`select count(*)::int as total,
        count(*) filter (where "objectKey" is null)::int as pending,
        count(*) filter (where "body" is not null)::int as database_copies,
        coalesce(sum(octet_length("body")),0)::text as database_bytes from "${table.name}"`);
      console.log(JSON.stringify({ table: table.name, ...result.rows[0] }));
    }
  } else {
    const account = process.env.CLOUDFLARE_ACCOUNT_ID;
    const accessKeyId = process.env.R2_ACCESS_KEY_ID;
    const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
    if (!account || !accessKeyId || !secretAccessKey)
      throw new Error(
        "Set CLOUDFLARE_ACCOUNT_ID, R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY for this operator run.",
      );
    if (value("--bucket") !== bucketName)
      throw new Error(`Confirm the bucket with --bucket=${bucketName}.`);
    const bucket = new S3Client({
      bucket: bucketName,
      endpoint: `https://${account}.r2.cloudflarestorage.com`,
      region: "auto",
      accessKeyId,
      secretAccessKey,
    });
    for (const table of tables) {
      let after = "",
        processed = 0;
      for (;;) {
        const filter =
          mode === "apply"
            ? 'a."objectKey" is null'
            : mode === "prune"
              ? 'a."objectKey" is not null and a."body" is not null'
              : 'a."objectKey" is not null';
        const result = await client.query<{
          identity: string;
          organizationId: string;
          mimeType: string;
          body: Buffer | null;
          objectKey: string | null;
          byteSize: string | null;
          sha256: string | null;
        }>(
          `select ${table.identity} as identity, ${table.organization} as "organizationId", a."mimeType", a."body", a."objectKey", a."byteSize", a."sha256"
           from "${table.name}" a ${table.join} where ${filter} and ${table.identity}>$1 order by ${table.identity} limit 10`,
          [after],
        );
        if (!result.rows.length) break;
        for (const row of result.rows) {
          const sha256 = row.body ? imageDigest(row.body) : row.sha256;
          const byteSize = row.body?.byteLength ?? Number(row.byteSize);
          if (!sha256 || !byteSize) throw new Error("A row is missing verification metadata.");
          if (row.sha256 && row.sha256 !== sha256) throw new Error("Database asset hash mismatch.");
          const key = row.objectKey ?? designObjectKey(row.organizationId, sha256, row.mimeType);
          const object = bucket.file(key);
          if (mode === "apply") {
            if (!row.body) throw new Error("Unmigrated asset has no database bytes.");
            await client.query(
              `insert into "designObject" ("objectKey","organizationId","mimeType","sha256","byteSize") values ($1,$2,$3,$4,$5)
              on conflict ("objectKey") do update set "lastClaimedAt"=now()`,
              [key, row.organizationId, row.mimeType, sha256, byteSize],
            );
            if (!(await object.exists())) await object.write(row.body, { type: row.mimeType });
          }
          await verifiedObject(key, { sha256, byteSize }, (key) => bucket.file(key).arrayBuffer());
          const keys = row.identity.split("\t");
          const predicate = table.keys.map((column, i) => `${column}=$${i + 1}`).join(" and ");
          if (mode === "apply") {
            await client.query(
              `update "${table.name}" set "objectKey"=$${keys.length + 1}, "sha256"=$${keys.length + 2}, "byteSize"=$${keys.length + 3}
              where ${predicate} and "objectKey" is null and "body"=$${keys.length + 4} and "mimeType"=$${keys.length + 5}`,
              [...keys, key, sha256, byteSize, row.body, row.mimeType],
            );
          } else if (mode === "prune") {
            await client.query(
              `update "${table.name}" set "body"=null where ${predicate} and "objectKey"=$${keys.length + 1} and "sha256"=$${keys.length + 2}`,
              [...keys, key, sha256],
            );
          }
          processed++;
          after = row.identity;
        }
        console.log(JSON.stringify({ table: table.name, mode, processed }));
      }
    }
  }
} finally {
  await client.end();
}
