import { tryGetCurrentAuthEndpointContext } from "@better-auth/core/context";
import type { BetterAuthPlugin } from "better-auth";
import { APIError } from "better-auth/api";
import { db } from "@/lib/db";
import { inDatabaseScope } from "@/lib/database-scope";
import { requireOrganizationPermission } from "./authorization";
import { canAssignRole } from "./roles";

export const INVITATION_LIMITS = {
  pending: 100,
  retained: 1000,
  retentionDays: 30,
  members: 1000,
} as const;

async function admitInvitation<T>(data: Record<string, unknown>, write: () => Promise<T>) {
  const { organizationId, inviterId, email, role } = data;
  if (
    ![organizationId, inviterId, email, role].every(
      (value) => typeof value === "string" && value.length > 0,
    )
  )
    throw new APIError("BAD_REQUEST", { message: "Invalid invitation." });
  const client = await db.connect();
  try {
    await client.query("begin");
    const organization = await client.query(
      'select "id" from "organization" where "id"=$1 for update',
      [organizationId],
    );
    if (!organization.rowCount)
      throw new APIError("FORBIDDEN", { message: "Workspace access denied." });
    const actorRole = await requireOrganizationPermission(
      inviterId as string,
      organizationId as string,
      "manage",
      client,
    );
    if (!canAssignRole(actorRole, role as string))
      throw new APIError("FORBIDDEN", { message: "You cannot invite this role." });
    // Pending and accepted handoffs remain until their expiry; retained terminal records
    // can be reclaimed after 30 days. This never removes a live invitation.
    await client.query(
      `delete from "invitation" where "organizationId"=$1
      and "expiresAt" < now()-$2*interval '1 day'`,
      [organizationId, INVITATION_LIMITS.retentionDays],
    );
    const usage = (
      await client.query<{ pending: number; retained: number; duplicate: boolean }>(
        `select
      count(*) filter (where "status"='pending' and "expiresAt">now())::int as pending,
      count(*)::int as retained,
      coalesce(bool_or("status"='pending' and "expiresAt">now() and lower("email")=lower($2)),false) as duplicate
      from "invitation" where "organizationId"=$1`,
        [organizationId, email],
      )
    ).rows[0];
    if (usage.duplicate)
      throw new APIError("BAD_REQUEST", {
        message: "This email already has a pending invitation.",
      });
    if (usage.pending >= INVITATION_LIMITS.pending)
      throw new APIError("FORBIDDEN", {
        code: "INVITATION_LIMIT",
        message:
          "This workspace has reached its pending invitation limit. Cancel unused invitations before inviting more people.",
      });
    if (usage.retained >= INVITATION_LIMITS.retained)
      throw new APIError("FORBIDDEN", {
        code: "INVITATION_LIMIT",
        message:
          "This workspace has reached its invitation history limit. Wait for old records to expire before inviting more people.",
      });
    const result = await inDatabaseScope(client, write);
    await client.query("commit");
    await result.afterCommit();
    return result.value;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

/** Better Auth transitions the invitation before entering its member transaction.
 * Revalidate the exact grant here and hold authority locks through both the
 * membership insert and active-organization session update. */
async function acceptInvitation<T>(
  invitationId: string,
  userId: string,
  sessionId: string,
  write: () => Promise<T>,
) {
  const client = await db.connect();
  const denied = () =>
    new APIError("FORBIDDEN", {
      message: "This invitation can no longer grant access. Ask an admin for a new invitation.",
    });
  try {
    await client.query("begin");
    const target = (
      await client.query<{ organizationId: string }>(
        'select "organizationId" from "invitation" where "id"=$1',
        [invitationId],
      )
    ).rows[0];
    if (!target) throw denied();
    await client.query('select "id" from "organization" where "id"=$1 for update', [
      target.organizationId,
    ]);
    const invitation = (
      await client.query<{ inviterId: string; email: string; role: string }>(
        `select "inviterId","email","role" from "invitation"
      where "id"=$1 and "organizationId"=$2 and "status"='accepted' and "expiresAt">now() for update`,
        [invitationId, target.organizationId],
      )
    ).rows[0];
    if (!invitation) throw denied();
    const session = await client.query(
      'select "id" from "session" where "id"=$1 and "userId"=$2 and "expiresAt">now() for share',
      [sessionId, userId],
    );
    if (!session.rowCount) throw denied();
    // Lock users in deterministic order, including verification and email binding.
    const users = (
      await client.query<{ id: string; email: string; emailVerified: boolean }>(
        'select "id","email","emailVerified" from "user" where "id"=any($1::text[]) order by "id" for share',
        [[userId, invitation.inviterId]],
      )
    ).rows;
    const recipient = users.find((user) => user.id === userId);
    if (
      !recipient?.emailVerified ||
      recipient.email.toLowerCase() !== invitation.email.toLowerCase()
    )
      throw denied();
    const inviter = (
      await client.query<{ role: string }>(
        'select "role" from "member" where "organizationId"=$1 and "userId"=$2 for share',
        [target.organizationId, invitation.inviterId],
      )
    ).rows[0];
    if (
      !users.find((user) => user.id === invitation.inviterId)?.emailVerified ||
      !inviter ||
      !canAssignRole(inviter.role, invitation.role)
    )
      throw denied();
    const usage = (
      await client.query<{ count: number; existing: boolean }>(
        `select count(*)::int as count, coalesce(bool_or("userId"=$2),false) as existing from "member" where "organizationId"=$1`,
        [target.organizationId, userId],
      )
    ).rows[0];
    if (usage.existing)
      throw new APIError("BAD_REQUEST", { message: "You already belong to this workspace." });
    if (usage.count >= INVITATION_LIMITS.members)
      throw new APIError("FORBIDDEN", { message: "This workspace has reached its member limit." });
    const result = await inDatabaseScope(client, write);
    await client.query("commit");
    await result.afterCommit();
    return result.value;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

/** Keep Better Auth's adapter identity and compose its insert with our admission transaction. */
export const invitationAdmissionPlugin = {
  id: "invitation-admission",
  init(context) {
    const adapter = context.adapter;
    const transaction = adapter.transaction.bind(adapter);
    adapter.transaction = async (callback) => {
      const endpoint = tryGetCurrentAuthEndpointContext();
      if (endpoint?.path !== "/organization/accept-invitation") return transaction(callback);
      const invitationId = endpoint.body?.invitationId;
      const userId = endpoint.context.session?.user.id;
      const sessionId = endpoint.context.session?.session.id;
      if (typeof invitationId !== "string" || !userId || !sessionId)
        throw new APIError("UNAUTHORIZED");
      // Supply the same adapter inside our scoped PostgreSQL transaction: opening
      // a second Kysely transaction here would commit independently of our locks.
      return acceptInvitation(invitationId, userId, sessionId, () => callback(adapter));
    };
    const create = adapter.create;
    Object.defineProperty(adapter, "create", {
      ...Object.getOwnPropertyDescriptor(adapter, "create"),
      value: async (...args: unknown[]) => {
        const input = args[0] as { model?: string; data?: Record<string, unknown> } | undefined;
        const write = () => Reflect.apply(create, adapter, args);
        if (input?.model === "invitation" && input.data) return admitInvitation(input.data, write);
        return write();
      },
    });
  },
} satisfies BetterAuthPlugin;
