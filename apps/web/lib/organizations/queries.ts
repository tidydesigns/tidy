import "server-only";
import { db } from "@/lib/db";
import { VIEW_ROLES_SQL, MANAGE_ROLES_SQL } from "./roles";

export type WorkspaceMember = {
  id: string;
  userId: string;
  name: string;
  email: string;
  role: string;
};

/** The actor predicate is part of the data query, not an assumption made by a page. */
export async function listWorkspaceMembers(userId: string, organizationId: string) {
  const result = await db.query<WorkspaceMember>(
    `select m."id",m."userId",u."name",u."email",m."role"
    from "member" m join "user" u on u."id"=m."userId"
    where m."organizationId"=$2 and exists (
      select 1 from "member" actor join "user" identity on identity."id"=actor."userId" and identity."emailVerified"=true
      where actor."userId"=$1 and actor."organizationId"=m."organizationId" and actor."role" in ${VIEW_ROLES_SQL}
    ) order by lower(u."name"),lower(u."email")`,
    [userId, organizationId],
  );
  return result.rows;
}

export async function listPendingInvitations(userId: string, organizationId: string) {
  const result = await db.query<{ id: string; email: string; role: string }>(
    `select i."id",i."email",i."role" from "invitation" i
    where i."organizationId"=$2 and i."status"='pending' and i."expiresAt">now() and exists (
      select 1 from "member" actor join "user" identity on identity."id"=actor."userId" and identity."emailVerified"=true
      where actor."userId"=$1 and actor."organizationId"=i."organizationId" and actor."role" in ${MANAGE_ROLES_SQL}
    ) order by i."createdAt"`,
    [userId, organizationId],
  );
  return result.rows;
}
