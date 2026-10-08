"use client";

import { ImmediateField } from "@/components/ui/immediate-field";
import { useOrganizationNames } from "@/components/workspace/organization-names";
import { authClient } from "@/lib/auth-client";
import { organizationNameSchema } from "@/lib/organizations/name";

export function OrganizationName({ organization }: { organization: { id: string; name: string } }) {
  const { updateName } = useOrganizationNames();
  return (
    <ImmediateField
      label="Organization name"
      value={organization.name}
      maxLength={100}
      required
      onCommit={async (draft) => {
        const parsed = organizationNameSchema.safeParse(draft);
        if (!parsed.success) throw new Error(parsed.error.issues[0].message);
        if (parsed.data === organization.name) return parsed.data;
        const result = await authClient.organization.update({
          organizationId: organization.id,
          data: { name: parsed.data },
        });
        if (result.error || !result.data)
          throw new Error(result.error?.message || "Could not update the organization name.");
        updateName(organization.id, result.data.name);
        return result.data.name;
      }}
    />
  );
}
