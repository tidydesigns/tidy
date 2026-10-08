import { PublicActionError } from "@/lib/security/public-error";
import "server-only";
import type { PoolClient } from "pg";
import { db } from "@/lib/db";

import { can, canAssignRole, canManageMember, type StoredOrganizationRole } from "./roles";
export type OrganizationRole = StoredOrganizationRole;
type Membership = { id: string; userId: string; role: string };
const hasRole = (role: string, expected: string) => role === expected;

async function withMembership<T>(
  userId: string,
  organizationId: string,
  operation: (client: PoolClient, actor: Membership, members: Membership[]) => Promise<T>,
) {
  const client = await db.connect();
  try {
    await client.query("begin");
    await client.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [organizationId]);
    const organization = await client.query(
      'select "id" from "organization" where "id" = $1 for update',
      [organizationId],
    );
    if (!organization.rowCount) throw new PublicActionError("Organization not found.");
    const verified = await client.query(
      'select "id" from "user" where "id"=$1 and "emailVerified"=true for share',
      [userId],
    );
    if (!verified.rowCount)
      throw new PublicActionError("Verify your email before managing this organization.");
    const members = (
      await client.query<Membership>(
        'select "id", "userId", "role" from "member" where "organizationId" = $1 order by "id" for update',
        [organizationId],
      )
    ).rows;
    const actor = members.find((member) => member.userId === userId);
    if (!actor || !can(actor.role, "view"))
      throw new PublicActionError("You no longer belong to this organization.");
    const result = await operation(client, actor, members);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

function requireManager(actor: Membership) {
  if (!hasRole(actor.role, "owner") && !hasRole(actor.role, "admin"))
    throw new PublicActionError("Only owners and admins can manage members.");
}

function protectOwner(members: Membership[], target: Membership) {
  if (
    hasRole(target.role, "owner") &&
    members.filter((member) => hasRole(member.role, "owner")).length <= 1
  ) {
    throw new PublicActionError("Transfer ownership before removing the last owner.");
  }
}

export async function changeMemberRole(
  userId: string,
  organizationId: string,
  memberId: string,
  role: OrganizationRole,
) {
  if (!["viewer", "editor", "member", "admin"].includes(role))
    throw new PublicActionError("Choose a valid member role.");
  return withMembership(userId, organizationId, async (client, actor, members) => {
    requireManager(actor);
    const target = members.find((member) => member.id === memberId);
    if (!target) throw new PublicActionError("Member not found in this organization.");
    if (hasRole(target.role, "owner") && !hasRole(actor.role, "owner"))
      throw new PublicActionError("Only owners can change ownership.");
    if (
      !canManageMember(actor.role, target.role) ||
      (role === "admin" && !hasRole(actor.role, "owner"))
    )
      throw new PublicActionError("Only owners can manage admins.");
    protectOwner(members, target);
    if (target.userId === userId)
      throw new PublicActionError("Ask another owner to change your role.");
    await client.query(
      'update "member" set "role" = $1 where "id" = $2 and "organizationId" = $3',
      [role, target.id, organizationId],
    );
    return role;
  });
}

async function deleteMembership(client: PoolClient, target: Membership, organizationId: string) {
  await client.query('delete from "member" where "id" = $1 and "organizationId" = $2', [
    target.id,
    organizationId,
  ]);
  await client.query(
    'update "session" set "activeOrganizationId" = null where "userId" = $1 and "activeOrganizationId" = $2',
    [target.userId, organizationId],
  );
}

export async function removeMember(userId: string, organizationId: string, memberId: string) {
  return withMembership(userId, organizationId, async (client, actor, members) => {
    requireManager(actor);
    const target = members.find((member) => member.id === memberId);
    if (!target) throw new PublicActionError("Member not found in this organization.");
    if (target.userId === userId)
      throw new PublicActionError("Use Leave organization to remove your own membership.");
    if (hasRole(target.role, "owner") && !hasRole(actor.role, "owner"))
      throw new PublicActionError("Only owners can remove another owner.");
    if (!canManageMember(actor.role, target.role))
      throw new PublicActionError("Only owners can manage admins.");
    protectOwner(members, target);
    await deleteMembership(client, target, organizationId);
  });
}

export async function leaveOrganization(userId: string, organizationId: string) {
  return withMembership(userId, organizationId, async (client, actor, members) => {
    protectOwner(members, actor);
    await deleteMembership(client, actor, organizationId);
  });
}

export async function transferOwnership(
  userId: string,
  organizationId: string,
  successorId: string,
) {
  return withMembership(userId, organizationId, async (client, actor, members) => {
    if (!hasRole(actor.role, "owner"))
      throw new PublicActionError("Only owners can transfer ownership.");
    const successor = members.find(
      (member) => member.id === successorId && member.userId !== userId,
    );
    if (!successor) throw new PublicActionError("Choose another member of this organization.");
    await client.query(
      'update "member" set "role" = $1 where "id" = $2 and "organizationId" = $3',
      ["owner", successor.id, organizationId],
    );
    await client.query(
      'update "member" set "role" = $1 where "id" = $2 and "organizationId" = $3',
      ["admin", actor.id, organizationId],
    );
  });
}

export async function changeInvitationRole(
  userId: string,
  organizationId: string,
  invitationId: string,
  role: OrganizationRole,
) {
  return withMembership(userId, organizationId, async (client, actor) => {
    requireManager(actor);
    const invitation = (
      await client.query<{ role: string }>(
        `select "role" from "invitation" where "id" = $1 and "organizationId" = $2
      and "status" = 'pending' and "expiresAt" > now() for update`,
        [invitationId, organizationId],
      )
    ).rows[0];
    if (!invitation) throw new PublicActionError("Invitation no longer available.");
    if (!canAssignRole(actor.role, invitation.role) || !canAssignRole(actor.role, role))
      throw new PublicActionError("You cannot assign this role.");
    await client.query('update "invitation" set "role" = $1, "inviterId" = $2 where "id" = $3', [
      role,
      userId,
      invitationId,
    ]);
  });
}
