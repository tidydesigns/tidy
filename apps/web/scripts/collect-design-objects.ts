// Default: report orphan candidates. --apply requires explicit database/bucket targets.
import { S3Client } from "bun";
import { Client } from "pg";
import {
  collectTrackedObject,
  unreferencedObjectsSql as unreferenced,
} from "../lib/storage/object-collection";
const args = new Set(process.argv.slice(2));
const value = (name: string) =>
  [...args].find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1);
const apply = args.has("--apply");
const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required.");
const database = new URL(connectionString);
const target = `${database.hostname}:${database.port || "5432"}${database.pathname}`;
const bucketName = process.env.DESIGN_OBJECTS_BUCKET ?? "tidy-design-objects";
if (apply && (value("--target") !== target || value("--bucket") !== bucketName))
  throw new Error(`Confirm --target=${target} and --bucket=${bucketName}.`);
const client = new Client({ connectionString });
await client.connect();
try {
  let bucket: S3Client | undefined;
  if (apply) {
    const account = process.env.CLOUDFLARE_ACCOUNT_ID,
      accessKeyId = process.env.R2_ACCESS_KEY_ID,
      secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
    if (!account || !accessKeyId || !secretAccessKey)
      throw new Error("R2 operator credentials are required.");
    bucket = new S3Client({
      bucket: bucketName,
      endpoint: `https://${account}.r2.cloudflarestorage.com`,
      region: "auto",
      accessKeyId,
      secretAccessKey,
    });
  }
  let after = "",
    candidates = 0,
    removed = 0;
  for (;;) {
    const rows = await client.query<{ objectKey: string }>(
      `select o."objectKey" from "designObject" o
      where o."lastClaimedAt"<now()-interval '7 days' and o."objectKey">$1 and ${unreferenced} order by o."objectKey" limit 100`,
      [after],
    );
    if (!rows.rows.length) break;
    for (const row of rows.rows) {
      after = row.objectKey;
      candidates++;
      if (!bucket) continue;
      if (await collectTrackedObject(client, bucket, row.objectKey)) removed++;
    }
    console.log(JSON.stringify({ candidates, removed, apply }));
  }
  console.log(JSON.stringify({ candidates, removed, apply }));
} finally {
  await client.end();
}
