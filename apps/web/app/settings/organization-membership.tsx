"use client";

import { navigateWithFreshSession } from "@/lib/navigation/actions";
import { useId, useState } from "react";
import { ConfirmAction } from "@/components/ui/confirm-action";
import { SelectMenu } from "@/components/ui/select-menu";
import { handoffOrganization, leaveCurrentOrganization } from "./actions";
import type { Member } from "./settings-tabs";

export function OrganizationMembership({
  organization,
  members,
  userId,
  role,
  onTransfer,
}: {
  organization: { id: string; name: string };
  members: Member[];
  userId: string;
  role: string;
  onTransfer: (successorId: string) => void;
}) {
  const id = useId();
  const [successorId, setSuccessorId] = useState("");
  const owner = role.split(",").includes("owner");
  const successors = members.filter((member) => member.userId !== userId);
  const lastOwner =
    owner && members.filter((member) => member.role.split(",").includes("owner")).length === 1;
  const successor = successors.find((member) => member.id === successorId);
  if (lastOwner && successors.length === 0) return null;

  return (
    <div className="mt-10 space-y-6 border-t border-primary-grey pt-6">
      {owner && successors.length > 0 && (
        <div>
          <span id={id} className="block text-sm font-medium">
            Transfer ownership to
          </span>
          <div className="mt-2 flex flex-wrap items-center gap-3">
            <SelectMenu
              label="Transfer ownership to"
              labelledBy={id}
              value={successorId}
              onChange={setSuccessorId}
              options={[
                { value: "", label: "Choose a member" },
                ...successors.map((member) => ({
                  value: member.id,
                  label: `${member.name} (${member.email})`,
                })),
              ]}
              className="w-72 max-w-full"
            />
            <ConfirmAction
              label="Transfer ownership"
              title={`Make ${successor?.name ?? "this member"} an owner?`}
              disabled={!successor}
              onConfirm={async () => {
                if (!successor) return;
                const result = await handoffOrganization(organization.id, successor.id);
                if (result.error) throw new Error(result.error);
                onTransfer(successor.id);
                setSuccessorId("");
              }}
            >
              You will become an admin of {organization.name}. {successor?.name} will have owner
              access, including the ability to delete the organization.
            </ConfirmAction>
          </div>
        </div>
      )}
      {lastOwner ? (
        <p className="text-sm text-secondary-ink">
          Transfer ownership before leaving this organization.
        </p>
      ) : (
        <ConfirmAction
          label="Leave organization"
          title={`Leave ${organization.name}?`}
          onConfirm={async () => {
            const result = await leaveCurrentOrganization(organization.id);
            if (result.error) throw new Error(result.error);
            await navigateWithFreshSession("/files");
          }}
        >
          You will lose access to its files. An owner or admin will need to invite you to return.
        </ConfirmAction>
      )}
    </div>
  );
}
