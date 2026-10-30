import { db } from "@/lib/db";
import { EDIT_ROLES_SQL } from "@/lib/organizations/roles";
import { PublicActionError } from "@/lib/security/public-error";

/** One metadata query, instead of a separate file query per workspace. */
export async function captureDestinations(userId: string) {
  const result = await db.query<{
    id: string;
    name: string;
    files: { id: string; name: string }[];
  }>(
    `select o."id",o."name",coalesce(jsonb_agg(jsonb_build_object('id',f."id",'name',f."name")
      order by f."updatedAt" desc,f."id") filter(where f."id" is not null),'[]'::jsonb) as files
     from "organization" o join "member" m on m."organizationId"=o."id" and m."userId"=$1 and m."role" in ${EDIT_ROLES_SQL}
     join "user" u on u."id"=m."userId" and u."emailVerified"=true
     left join "designFile" f on f."organizationId"=o."id" and f."archivedAt" is null
     group by o."id",o."name" order by o."name",o."id"`,
    [userId],
  );
  return result.rows;
}

/** Capturing rechecks only the selected destination, without downloading every file name. */
export async function authorizeCaptureDestination(
  userId: string,
  organizationId: string,
  fileId?: string,
) {
  const result = await db.query(
    `select 1 from "member" m join "user" u on u."id"=m."userId" and u."emailVerified"=true
     where m."userId"=$1 and m."organizationId"=$2 and m."role" in ${EDIT_ROLES_SQL}
       and ($3::text is null or exists(select 1 from "designFile" f where f."id"=$3
         and f."organizationId"=m."organizationId" and f."archivedAt" is null))`,
    [userId, organizationId, fileId ?? null],
  );
  if (!result.rowCount) throw new PublicActionError("Destination not found or access denied.");
}
