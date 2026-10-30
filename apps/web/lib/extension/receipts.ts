import { db } from "@/lib/db";
import { EDIT_ROLES_SQL } from "@/lib/organizations/roles";
import { PublicActionError } from "@/lib/security/public-error";
import { importResultSchema, type CaptureReceipt } from "@tidy/design/web-capture";

export class CaptureInProgressError extends PublicActionError {
  constructor() {
    super("This capture is already processing.");
  }
}

/** Recheck current ownership and access on every receipt read; IDs are not credentials. */
export async function captureReceipt(
  userId: string,
  requestId: string,
): Promise<CaptureReceipt | null> {
  const result = await db.query<{ status: string; requestResult: unknown }>(
    `select i."status",i."requestResult" from "designImport" i
     join "member" m on m."organizationId"=i."organizationId" and m."userId"=$2 and m."role" in ${EDIT_ROLES_SQL}
     join "user" u on u."id"=m."userId" and u."emailVerified"=true
     where i."id"=$1 and i."userId"=$2 and i."requestHash" is not null and i."expiresAt">now()
       and (i."fileId" is null or exists(select 1 from "designFile" f where f."id"=i."fileId"
         and f."organizationId"=i."organizationId" and f."archivedAt" is null))`,
    [requestId, userId],
  );
  const row = result.rows[0];
  if (!row) return null;
  if (row.status === "committed")
    return { state: "done", result: importResultSchema.parse(row.requestResult) };
  return { state: row.status === "staging" ? "pending" : "failed" };
}
