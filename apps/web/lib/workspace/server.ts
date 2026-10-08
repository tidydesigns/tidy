import { can } from "@/lib/organizations/roles";
import "server-only";

import { cache } from "react";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { observeOperation } from "@/lib/operation-observability";

// Request-scoped memoization only: pages still authorize on every request,
// including navigation when Next reuses the workspace layout on the client.
export const workspaceAccount = cache(async () => {
  const requestHeaders = await headers();
  const session = await observeOperation(requestHeaders, "workspace.session", () =>
    auth.api.getSession({ headers: requestHeaders }),
  );
  if (!session) redirect("/login");
  const organizations = await observeOperation(requestHeaders, "workspace.organizations", () =>
    auth.api.listOrganizations({ headers: requestHeaders }),
  );
  if (!organizations.length) redirect("/onboarding/organization");
  return { requestHeaders, session, organizations };
});

const workspaceRole = cache(async (organizationId: string) => {
  const { requestHeaders } = await workspaceAccount();
  return observeOperation(requestHeaders, "workspace.role", () =>
    auth.api.getActiveMemberRole({ headers: requestHeaders, query: { organizationId } }),
  );
});

export const getWorkspace = cache(async (organizationId?: string) => {
  const account = await workspaceAccount();
  const organization =
    account.organizations.find((item) => item.id === organizationId) ??
    account.organizations.find(
      (item) => item.id === account.session.session.activeOrganizationId,
    ) ??
    account.organizations[0];
  const { role } = await workspaceRole(organization.id);
  return {
    ...account,
    organization,
    role,
    canInvite: can(role, "manage"),
  };
});
