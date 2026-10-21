"use client";
import { UserFacingError, errorMessage } from "@tidy/ui/errors";

import { ImmediateField } from "@/components/ui/immediate-field";
import { useOrganizationNames } from "@/components/workspace/organization-names";
import { authClient } from "@/lib/auth-client";
import { organizationNameSchema } from "@/lib/organizations/name";

export function OrganizationName({ organization }: { organization: { id: string; name: string } }) {
  const { updateName } = useOrganizationNames();
  return (
    <ImmediateField
      replayLabel
      label="Organization name"
      value={organization.name}
      maxLength={100}
      required
      onCommit={async (draft) => {
        const parsed = organizationNameSchema.safeParse(draft);
        if (!parsed.success) throw new UserFacingError(parsed.error.issues[0].message);
        if (parsed.data === organization.name) return parsed.data;
        const result = await authClient.organization.update({
          organizationId: organization.id,
          data: { name: parsed.data },
        });
        if (result.error || !result.data)
          throw new UserFacingError(
            errorMessage(result.error, "Could not update the organization name."),
            { cause: result.error ?? result },
          );
        updateName(organization.id, result.data.name);
        return result.data.name;
      }}
    />
  );
}
