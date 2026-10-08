import { db } from "@/lib/db";
import { inDatabaseScope } from "@/lib/database-scope";
import { EDIT_ROLES_SQL, VIEW_ROLES_SQL } from "@/lib/organizations/roles";
import { reserveClipboardTransfer } from "./clipboard-budget";

export class ClipboardAccessError extends Error {
  constructor() {
    super("Source or destination file not found or access denied.");
  }
}
export type ClipboardAccess = { sourceOrganizationId: string; targetOrganizationId: string };

/** Charge authorized destination attempts before loading/parsing transport input. */
export async function admitClipboardTransfer(userId: string, fileId: string) {
  const result = await db.query<{ organizationId: string }>(
    `select f."organizationId" from "designFile" f
    join "member" m on m."organizationId"=f."organizationId" and m."userId"=$2 and m."role" in ${EDIT_ROLES_SQL}
    join "user" u on u."id"=m."userId" and u."emailVerified"=true
    where f."id"=$1 and f."archivedAt" is null`,
    [fileId, userId],
  );
  if (!result.rows[0]) throw new ClipboardAccessError();
  await reserveClipboardTransfer(userId, result.rows[0].organizationId);
}

/** Discovery retains no product locks. Lock both admissions in a stable order,
 * then recheck and retain both live file authorities through all image publication. */
export async function withClipboardAccess<T>(
  userId: string,
  sourceFile: string,
  targetFile: string,
  work: (access: ClipboardAccess) => Promise<T>,
) {
  const ids = [...new Set([sourceFile, targetFile])];
  const discovered = await db.query<{ id: string; organizationId: string }>(
    `select f."id",f."organizationId" from "designFile" f
    join "member" m on m."organizationId"=f."organizationId" and m."userId"=$2 and m."role" in ${VIEW_ROLES_SQL}
    join "user" u on u."id"=m."userId" and u."emailVerified"=true
    where f."id"=any($1::text[]) and f."archivedAt" is null
    and (f."id"<>$3 or m."role" in ${EDIT_ROLES_SQL})`,
    [ids, userId, targetFile],
  );
  const source = discovered.rows.find((row) => row.id === sourceFile);
  const target = discovered.rows.find((row) => row.id === targetFile);
  if (!source || !target || discovered.rows.length !== ids.length) throw new ClipboardAccessError();
  const client = await db.connect();
  try {
    await client.query("begin");
    // Opposing cross-workspace copies must take the same order, including quota triggers.
    for (const org of [...new Set([source.organizationId, target.organizationId])].sort())
      await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [org]);
    const access = await client.query(
      `select f."id" from "designFile" f
      join "member" m on m."organizationId"=f."organizationId" and m."userId"=$3 and m."role" in ${VIEW_ROLES_SQL}
      join "user" u on u."id"=m."userId" and u."emailVerified"=true
      where f."archivedAt" is null
      and ((f."id"=$1 and f."organizationId"=$4) or (f."id"=$2 and f."organizationId"=$5))
      and (f."id"<>$2 or m."role" in ${EDIT_ROLES_SQL})
      order by f."id" for share of f,m,u`,
      [sourceFile, targetFile, userId, source.organizationId, target.organizationId],
    );
    if (access.rows.length !== ids.length) throw new ClipboardAccessError();
    const scoped = await inDatabaseScope(client, () =>
      work({
        sourceOrganizationId: source.organizationId,
        targetOrganizationId: target.organizationId,
      }),
    );
    await client.query("commit");
    await scoped.afterCommit();
    return scoped.value;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}
