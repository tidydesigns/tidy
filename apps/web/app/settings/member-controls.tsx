"use client";

import { useErrorNotice } from "@/lib/use-error-notice";
import { UserFacingError } from "@tidy/ui/errors";

import { memberList, memberRow } from "@/components/workspace/page-layout";

import { useState, type Dispatch, type SetStateAction } from "react";
import { ConfirmAction } from "@/components/ui/confirm-action";
import { SelectMenu } from "@/components/ui/select-menu";
import { removeOrganizationMember, updateMemberRole } from "./actions";
import { canManageMember, canAssignRole, roleLabel } from "@/lib/organizations/roles";
import type { Member } from "./settings-tabs";
import type { OrganizationRole } from "@/lib/organizations/membership";

export function MemberControls({
  organizationId,
  members,
  userId,
  role,
  onChange,
}: {
  organizationId: string;
  members: Member[];
  userId: string;
  role: string;
  onChange: Dispatch<SetStateAction<Member[]>>;
}) {
  const [pendingId, setPendingId] = useState("");
  const [, setError] = useErrorNotice("", "account_update");
  const owner = role.split(",").includes("owner");
  const manager = owner || role.split(",").includes("admin");

  async function changeRole(member: Member, next: OrganizationRole) {
    const notifyError = setError("");
    setPendingId(member.id);

    try {
      const result = await updateMemberRole(organizationId, member.id, next);
      if (result.error) throw new UserFacingError(result.error);
      onChange((current) =>
        current.map((item) => (item.id === member.id ? { ...item, role: next } : item)),
      );
    } catch (error) {
      notifyError(error, "Could not change this member's role.");
    } finally {
      setPendingId("");
    }
  }

  return (
    <>
      <ul className={memberList}>
        {members.map((member) => {
          const memberIsOwner = member.role.split(",").includes("owner");
          const canManage =
            manager && member.userId !== userId && canManageMember(role, member.role);
          return (
            <li key={member.id} className={memberRow}>
              <div className="min-w-0">
                <p className="font-medium">{member.name}</p>
                <p className="break-all text-sm text-secondary-ink">{member.email}</p>
              </div>
              <div className="flex items-center gap-3">
                {canManage && !memberIsOwner ? (
                  <SelectMenu
                    replayOptions
                    label={`Role for ${member.name}`}
                    value={member.role === "member" ? "editor" : member.role}
                    disabled={Boolean(pendingId)}
                    options={[
                      { value: "viewer", label: "Viewer" },
                      { value: "editor", label: "Editor" },
                      { value: "admin", label: "Admin" },
                    ].filter((option) => canAssignRole(role, option.value))}
                    onChange={(value) => void changeRole(member, value as OrganizationRole)}
                    className="w-32"
                  />
                ) : (
                  <span className="text-sm capitalize text-secondary-ink">
                    {roleLabel(member.role)}
                  </span>
                )}
                {canManage && (
                  <ConfirmAction
                    replayLabel
                    label="Remove member"
                    title={`Remove ${member.name}?`}
                    disabled={Boolean(pendingId)}
                    onConfirm={async () => {
                      const result = await removeOrganizationMember(organizationId, member.id);
                      if (result.error) throw new UserFacingError(result.error);
                      onChange((current) => current.filter((item) => item.id !== member.id));
                    }}
                  >
                    <span data-ph-public style={{ display: "contents" }}>
                      They will lose access to this organization and its files.
                    </span>
                  </ConfirmAction>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </>
  );
}
