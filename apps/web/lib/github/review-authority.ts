import { GitHubRequestError } from "./request-error";
import type { PoolClient } from "pg";
import { db } from "@/lib/db";
import { can, type Permission } from "@/lib/organizations/roles";
import { credentialVersionSql } from "./client";
import { lockGitHubHistory } from "./history-limits";

type ProviderAuthority = { installationId: string; githubId: string; credentialVersion: string };
type FileScope = { fileId: string; organizationId: string };

async function checkFileAuthority(
  client: Pick<PoolClient, "query">,
  userId: string,
  scope: FileScope,
  provider: ProviderAuthority,
  permission: Permission,
  lock: boolean,
) {
  const result = await client.query<{ role: string }>(
    `select m."role" from "designFile" f
      join "member" m on m."organizationId"=f."organizationId" and m."userId"=$2
      join "user" u on u."id"=m."userId" and u."emailVerified"=true
      join "githubUser" g on g."userId"=u."id"
      join "githubConnection" c on c."organizationId"=f."organizationId" and c."installationId"=$4 and c."active"=true
      where f."id"=$1 and f."organizationId"=$3 and f."archivedAt" is null
      and g."githubId"=$5 and ${credentialVersionSql}=$6
      ${lock ? "for share of f,m,u,g,c" : ""}`,
    [
      scope.fileId,
      userId,
      scope.organizationId,
      provider.installationId,
      provider.githubId,
      provider.credentialVersion,
    ],
  );
  if (!can(result.rows[0]?.role, permission))
    throw new GitHubRequestError("Review access denied or changed. Try again.", 403);
}

/** Provider lookups happen first. Lock current local authority only when publishing
 * their result, so revocation during the lookup can finish and invalidate it. */
export async function withFileProviderAuthority<T>(
  userId: string,
  scope: FileScope,
  provider: ProviderAuthority,
  permission: Permission,
  work: (client: PoolClient) => Promise<T>,
  options: { historyAdmission?: boolean } = {},
) {
  const client = await db.connect();
  try {
    await client.query("begin");
    if (options.historyAdmission) await lockGitHubHistory(client, scope.organizationId);
    await checkFileAuthority(client, userId, scope, provider, permission, true);
    const value = await work(client);
    await client.query("commit");
    return value;
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function withReviewProviderAuthority<T>(
  userId: string,
  access: ProviderAuthority & {
    review: FileScope & { id: string; repositoryId: string; number: number };
  },
  permission: Permission,
  work: (client: PoolClient) => Promise<T>,
  options: { historyAdmission?: boolean } = {},
) {
  return withFileProviderAuthority(
    userId,
    access.review,
    access,
    permission,
    async (client) => {
      const parent = await client.query(
        `select 1 from "githubReview" where "id"=$1 and "fileId"=$2
      and "organizationId"=$3 and "repositoryId"=$4 and "number"=$5 for share`,
        [
          access.review.id,
          access.review.fileId,
          access.review.organizationId,
          access.review.repositoryId,
          access.review.number,
        ],
      );
      if (!parent.rowCount)
        throw new GitHubRequestError("Review access denied or changed. Try again.", 403);
      return work(client);
    },
    options,
  );
}

export async function checkReviewProviderAuthority(
  userId: string,
  access: Parameters<typeof withReviewProviderAuthority>[1],
) {
  await checkFileAuthority(db, userId, access.review, access, "view", false);
  const parent = await db.query(
    `select 1 from "githubReview" where "id"=$1 and "fileId"=$2
    and "organizationId"=$3 and "repositoryId"=$4 and "number"=$5`,
    [
      access.review.id,
      access.review.fileId,
      access.review.organizationId,
      access.review.repositoryId,
      access.review.number,
    ],
  );
  if (!parent.rowCount)
    throw new GitHubRequestError("Review access denied or changed. Try again.", 403);
}
