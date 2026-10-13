import "server-only";
import type { PoolClient } from "pg";
import { db } from "@/lib/db";
import { PrivacyError } from "./access";

export async function checkDeletionOwnership(
  userId: string,
  client: Pick<PoolClient, "query"> = db,
) {
  const organizations = (
    await client.query<{ id: string; name: string }>(
      `select o.id,o.name from member m join organization o on o.id=m."organizationId"
       where m."userId"=$1 and m.role='owner' and not exists
       (select 1 from member other where other."organizationId"=m."organizationId"
        and other."userId"<>$1 and other.role='owner') order by o.name,o.id`,
      [userId],
    )
  ).rows;
  if (organizations.length)
    throw new PrivacyError(
      "Transfer ownership or delete these organizations before deleting your account.",
      409,
      "ORGANIZATION_OWNERSHIP_REQUIRED",
      organizations,
    );
}
