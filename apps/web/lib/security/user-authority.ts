import "server-only";
import type { PoolClient } from "pg";
import { PublicActionError } from "./public-error";

export class UserAccessError extends PublicActionError {}

export async function requireVerifiedUser(
  client: Pick<PoolClient, "query">,
  userId: string,
  lock = false,
) {
  const result = await client.query(
    `select "id" from "user" where "id"=$1 and "emailVerified"=true ${lock ? "for share" : ""}`,
    [userId],
  );
  if (result.rows.length !== 1)
    throw new UserAccessError("Account access denied. Sign in with a verified email.");
}
