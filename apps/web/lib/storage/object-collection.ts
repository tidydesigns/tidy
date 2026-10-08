import type { Client } from "pg";

export const unreferencedObjectsSql = `not exists (select 1 from "designAsset" where "objectKey"=o."objectKey")
  and not exists (select 1 from "githubReviewAsset" where "objectKey"=o."objectKey")
  and not exists (select 1 from "githubCapture" where "objectKey"=o."objectKey")
  and not exists (select 1 from "designFileThumbnail" where "objectKey"=o."objectKey")`;

/** Serialize collection with an uploader's claim, then recheck grace and every reference. */
export async function collectTrackedObject(
  client: Pick<Client, "query">,
  bucket: { delete(key: string): Promise<unknown> },
  key: string,
) {
  await client.query("begin");
  try {
    const locked = await client.query(
      `select o."objectKey" from "designObject" o where o."objectKey"=$1
      and o."lastClaimedAt"<now()-interval '7 days' and ${unreferencedObjectsSql} for update skip locked`,
      [key],
    );
    if (locked.rowCount) {
      await bucket.delete(key);
      await client.query('delete from "designObject" where "objectKey"=$1', [key]);
    }
    await client.query("commit");
    return Boolean(locked.rowCount);
  } catch (error) {
    await client.query("rollback");
    throw error;
  }
}
