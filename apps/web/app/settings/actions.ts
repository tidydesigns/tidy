"use server";
import { PublicActionError } from "@/lib/security/public-error";

import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import { revokeOtherAccountSession } from "@/lib/account/sessions";
import { actionError } from "@/lib/action-error";
import {
  changeInvitationRole,
  changeMemberRole,
  leaveOrganization,
  removeMember,
  transferOwnership,
  type OrganizationRole,
} from "@/lib/organizations/membership";

async function account() {
  const requestHeaders = await headers();
  const session = await auth.api.getSession({ headers: requestHeaders });
  if (!session) throw new PublicActionError("Sign in to manage your account.");
  return { session, requestHeaders };
}

export async function updateMemberRole(
  organizationId: string,
  memberId: string,
  role: OrganizationRole,
) {
  try {
    const { session } = await account();
    await changeMemberRole(session.user.id, organizationId, memberId, role);
    return {};
  } catch (error) {
    return { error: actionError(error, "Could not change this member’s role.") };
  }
}
export async function removeOrganizationMember(organizationId: string, memberId: string) {
  try {
    const { session } = await account();
    await removeMember(session.user.id, organizationId, memberId);
    return {};
  } catch (error) {
    return { error: actionError(error, "Could not remove this member.") };
  }
}
export async function leaveCurrentOrganization(organizationId: string) {
  try {
    const { session } = await account();
    await leaveOrganization(session.user.id, organizationId);
    return {};
  } catch (error) {
    return { error: actionError(error, "Could not leave this organization.") };
  }
}
export async function handoffOrganization(organizationId: string, successorId: string) {
  try {
    const { session } = await account();
    await transferOwnership(session.user.id, organizationId, successorId);
    return {};
  } catch (error) {
    return { error: actionError(error, "Could not transfer ownership.") };
  }
}
export async function revokeAccountSession(sessionId: string) {
  try {
    const { session, requestHeaders } = await account();
    await revokeOtherAccountSession(session.user.id, session.session.id, sessionId, requestHeaders);
    return {};
  } catch (error) {
    return { error: actionError(error, "Could not end this session. Sign in again and retry.") };
  }
}

export async function updateInvitationRole(
  organizationId: string,
  invitationId: string,
  role: OrganizationRole,
) {
  try {
    const { session } = await account();
    await changeInvitationRole(session.user.id, organizationId, invitationId, role);
    return {};
  } catch (error) {
    return { error: actionError(error, "Could not change this invitation’s role.") };
  }
}
