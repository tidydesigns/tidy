import { GitHubRequestError } from "./request-error";
import { publicGitHubMessage } from "./public-error";
import { MANAGE_ROLES_SQL } from "@/lib/organizations/roles";
import { requireVerifiedUser } from "@/lib/security/user-authority";
import { requireOrganizationPermission } from "@/lib/organizations/authorization";
import { requestWork } from "@/lib/request-work";
import { db } from "@/lib/db";
import { githubConfigured, githubConfig } from "./config";
import {
  boundedGitHubOperation,
  credentialVersionSql,
  githubRequest,
  paginated,
  userAuthorization,
} from "./client";
import { VIEW_ROLES_SQL } from "@/lib/organizations/roles";

export type Installation = {
  id: number;
  app_id: number;
  account: { login: string };
  suspended_at: string | null;
};
export type Repository = { id: number; full_name: string; permissions?: { admin?: boolean } };
export type ConnectionStatus = {
  configured: boolean;
  ready: boolean;
  login: string | null;
  connections: { installationId: string; account: string; active: boolean }[];
  installations: Installation[];
  error: string | null;
  installUrl: string;
};
export async function githubSchemaReady() {
  return requestWork("githubSchemaReady", async () => {
    const result = await db.query<{ ready: boolean }>(
      `select to_regclass('public."githubReview"') is not null and to_regclass('public."githubOAuthState"') is not null as ready`,
    );
    return result.rows[0]?.ready === true;
  });
}
export async function requireSchema() {
  if (!(await githubSchemaReady()))
    throw new Error("GitHub integration needs the approved database migration.");
}
export async function organizationAccess(userId: string, organizationId: string, admin = false) {
  await requireOrganizationPermission(userId, organizationId, admin ? "manage" : "view");
}
export const connectionStatus = boundedGitHubOperation(async function connectionStatus(
  userId: string,
  organizationId: string,
): Promise<ConnectionStatus> {
  await organizationAccess(userId, organizationId);
  const configured = githubConfigured();
  const ready = await githubSchemaReady();
  if (!ready)
    return {
      configured,
      ready,
      login: null,
      connections: [],
      installations: [],
      error: null,
      installUrl: `https://github.com/apps/${githubConfig().slug}/installations/new`,
    };
  const [user, connections] = await Promise.all([
    db.query<{ login: string }>(`select "login" from "githubUser" where "userId" = $1`, [userId]),
    db.query<{ installationId: string; account: string; active: boolean }>(
      `select "installationId", "account", "active" from "githubConnection" where "organizationId" = $1 order by "account"`,
      [organizationId],
    ),
  ]);
  let installations: Installation[] = [];
  let error: string | null = null;
  if (user.rowCount && configured) {
    try {
      const authorization = await userAuthorization(userId);
      installations = (
        await paginated<Installation>(authorization.token, "/user/installations", "installations")
      ).filter((item) => String(item.app_id) === githubConfig().appId && !item.suspended_at);
      const current = await db.query(
        `select 1 from "githubUser" g where "userId"=$1
        and g."githubId"=$2 and ${credentialVersionSql}=$3`,
        [userId, authorization.githubId, authorization.credentialVersion],
      );
      if (!current.rowCount) {
        installations = [];
        error = "GitHub connection changed. Try again.";
      }
    } catch (e) {
      installations = [];
      error = publicGitHubMessage(e);
    }
  }
  await organizationAccess(userId, organizationId);
  return {
    configured,
    ready,
    login: user.rows[0]?.login ?? null,
    connections: connections.rows,
    installations,
    error,
    installUrl: `https://github.com/apps/${githubConfig().slug}/installations/new`,
  };
});
export const attachInstallation = boundedGitHubOperation(async function attachInstallation(
  userId: string,
  organizationId: string,
  installationId: number,
) {
  await requireSchema();
  await organizationAccess(userId, organizationId, true);
  const authorization = await userAuthorization(userId);
  const { token } = authorization;
  const installation = (
    await paginated<Installation>(token, "/user/installations", "installations")
  ).find(
    (item) =>
      item.id === installationId &&
      String(item.app_id) === githubConfig().appId &&
      !item.suspended_at,
  );
  if (!installation)
    throw new GitHubRequestError("Install this GitHub App on an account you can access first.");
  // Fetch from GitHub, never trust an installation ID or account from a callback/query string.
  await githubRequest(token, `/user/installations/${installationId}/repositories?per_page=1`);
  // Provider I/O may outlive a role change. Bind publication to live authority.
  const saved = await db.query(
    `insert into "githubConnection" ("organizationId", "installationId", "account")
    select $1,$2,$3 from "member" m join "user" u on u."id"=m."userId" and u."emailVerified"=true
    join "githubUser" g on g."userId"=u."id"
    where m."organizationId"=$1 and m."userId"=$4 and m."role" in ${MANAGE_ROLES_SQL}
    and g."githubId"=$5 and ${credentialVersionSql}=$6
    on conflict ("organizationId", "installationId") do update set "account" = excluded."account", "active" = true`,
    [
      organizationId,
      installationId,
      installation.account.login,
      userId,
      authorization.githubId,
      authorization.credentialVersion,
    ],
  );
  if (!saved.rowCount) throw new GitHubRequestError("Organisation access denied.", 403);
});
export const repositoryAccess = boundedGitHubOperation(async function repositoryAccess(
  userId: string,
  organizationId: string,
  repositoryId: string | number,
) {
  await organizationAccess(userId, organizationId);
  const authorization = await userAuthorization(userId);
  const { token } = authorization;
  const connections = await db.query<{ installationId: string }>(
    `select "installationId" from "githubConnection" where "organizationId" = $1 and "active" = true`,
    [organizationId],
  );
  for (const connection of connections.rows) {
    const repositories = await paginated<Repository>(
      token,
      `/user/installations/${connection.installationId}/repositories`,
      "repositories",
    );
    const repository = repositories.find((item) => String(item.id) === String(repositoryId));
    if (repository) {
      const live = await db.query(
        `select 1 from "member" m
        join "user" u on u."id"=m."userId" and u."emailVerified"=true
        join "githubUser" g on g."userId"=u."id"
        join "githubConnection" c on c."organizationId"=m."organizationId" and c."active"=true
        where m."organizationId"=$1 and m."userId"=$2 and m."role" in ${VIEW_ROLES_SQL}
        and c."installationId"=$3 and g."githubId"=$4 and ${credentialVersionSql}=$5`,
        [
          organizationId,
          userId,
          connection.installationId,
          authorization.githubId,
          authorization.credentialVersion,
        ],
      );
      if (!live.rowCount)
        throw new GitHubRequestError("Repository access denied or changed. Try again.", 403);
      return { ...authorization, repository, installationId: connection.installationId };
    }
  }
  throw new GitHubRequestError(
    "Repository access was removed, or its installation is not linked to this organisation.",
  );
});

export async function disconnectGithubUser(userId: string) {
  const client = await db.connect();
  try {
    await client.query("begin");
    await client.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [
      `github-states:${userId}`,
    ]);
    await requireVerifiedUser(client, userId, true);
    await client.query('delete from "githubUser" where "userId"=$1', [userId]);
    await client.query('delete from "githubOAuthState" where "userId"=$1', [userId]);
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}
