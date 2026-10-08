import type { PoolClient } from "pg";

export const DOCUMENT_HISTORY_LIMITS = {
  operations: 1000,
  bytes: 16_000_000,
  operationBytes: 2_000_000,
  days: 7,
} as const;

export class ExpiredDocumentEdit extends Error {
  constructor() {
    super(
      "This edit's retry window has expired. The latest file must be synchronized before editing again.",
    );
  }
}

/** Caller owns the file/document locks. Never delete a receipt without its replay cutoff. */
export async function retainDocumentHistory(client: Pick<PoolClient, "query">, fileId: string) {
  await client.query(
    `with ranked as (
      select "operationId", "requestRevision", row_number() over newest as position,
        sum("byteSize") over newest as bytes, "createdAt"
      from "designRealtimeOperation" where "fileId"=$1
      window newest as (order by "revision" desc, "operationId" rows unbounded preceding)
    ), removed as (
      delete from "designRealtimeOperation" o using ranked r
      where o."fileId"=$1 and o."operationId"=r."operationId"
        and (r.position > $2 or r.bytes > $3 or r."createdAt" < now() - $4 * interval '1 day')
      returning o."requestRevision"
    )
    update "designRealtimeState" set "replayFloorRevision"=greatest("replayFloorRevision",
      (select max("requestRevision")+1 from removed)) where "fileId"=$1`,
    [
      fileId,
      DOCUMENT_HISTORY_LIMITS.operations,
      DOCUMENT_HISTORY_LIMITS.bytes,
      DOCUMENT_HISTORY_LIMITS.days,
    ],
  );
}
