import type { Client } from "pg";
import { unreferencedObjectsSql } from "./object-collection";

export type OrphanStore = "design" | "feedback";
export type ObjectStamp = { etag: string; size: number; lastModified: Date };
export type ReconciliationBucket = {
  head(key: string): Promise<ObjectStamp | null>;
  delete(key: string): Promise<unknown>;
};
const graceMs = 7 * 24 * 60 * 60 * 1000;

/** Only the key grammars published by this application belong to this collector. */
function identity(store: OrphanStore, key: string) {
  if (store === "feedback") {
    const match =
      /^feedback\/([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/[0-2]$/i.exec(
        key,
      );
    return match ? { lock: `feedback-upload:${match[1].toLowerCase()}`, id: match[1] } : null;
  }
  const match = /^originals\/([^/]+)\/[a-f0-9]{64}\.(png|jpg|webp|svg)$/.exec(key);
  if (!match) return null;
  try {
    const organizationId = decodeURIComponent(match[1]);
    if (!organizationId || encodeURIComponent(organizationId) !== match[1]) return null;
    // Same organization lock held by enforceStoragePlan on all design claims/references.
    return { lock: organizationId, id: organizationId };
  } catch {
    return null;
  }
}

export type ReconciliationResult =
  | "unknown-key"
  | "busy"
  | "retained"
  | "missing"
  | "changed"
  | "candidate"
  | "removed";

/** Operator-only. Recheck the live object and references while excluding publication.
 * Design registry entries belong to collectTrackedObject, never this collector.
 * A listing alone is never permission to delete. */
export async function reconcileOrphanObject(
  client: Pick<Client, "query">,
  bucket: ReconciliationBucket,
  store: OrphanStore,
  key: string,
  listed: ObjectStamp,
  apply = false,
): Promise<ReconciliationResult> {
  const target = identity(store, key);
  if (!target) return "unknown-key";
  await client.query(apply ? "begin" : "begin read only");
  try {
    await client.query("set local statement_timeout='10s'");
    await client.query("set local lock_timeout='2s'");
    const lock = await client.query<{ locked: boolean; now: number }>(
      'select pg_try_advisory_xact_lock(hashtextextended($1,0)) as locked, (extract(epoch from clock_timestamp())*1000)::float8 as "now"',
      [target.lock],
    );
    let result: ReconciliationResult = "busy";
    if (lock.rows[0]?.locked) {
      const keep =
        store === "design"
          ? await client.query(
              `select 1 where exists (select 1 from "designObject" where "objectKey"=$1)
          or not (${unreferencedObjectsSql.replaceAll('o."objectKey"', "$1")})`,
              [key],
            )
          : await client.query(
              `select 1 from "feedbackUpload" where "id"=$1
              or "attachments" @> jsonb_build_array(jsonb_build_object('key',$2::text)) limit 1`,
              [target.id, key],
            );
      result = "retained";
      if (!keep.rowCount) {
        const live = await bucket.head(key);
        const now = lock.rows[0].now;
        if (!Number.isFinite(now)) throw new Error("Database clock is unavailable.");
        if (!live) result = "missing";
        else if (
          !live.etag ||
          !Number.isSafeInteger(live.size) ||
          live.size < 0 ||
          !Number.isFinite(live.lastModified.getTime()) ||
          !Number.isFinite(listed.lastModified.getTime()) ||
          live.etag !== listed.etag ||
          live.size !== listed.size ||
          live.lastModified.getTime() !== listed.lastModified.getTime()
        )
          result = "changed";
        else if (live.lastModified.getTime() >= now - graceMs) result = "retained";
        else if (!apply) result = "candidate";
        else {
          await bucket.delete(key);
          result = "removed";
        }
      }
    }
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  }
}
