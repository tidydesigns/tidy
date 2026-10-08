import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { OnboardingShell } from "@/components/onboarding/onboarding-shell";
import { TeamInvites } from "./team-invites";

function pendingInvites(
  invitations: {
    id: string;
    email: string;
    status: string;
    role: string | null;
    expiresAt: Date;
  }[],
) {
  const now = Date.now();
  return invitations
    .filter(
      (invitation) =>
        invitation.status === "pending" && new Date(invitation.expiresAt).getTime() > now,
    )
    .map(({ id, email, role }) => ({ id, email, role }));
}

export default async function TeamPage({ searchParams }: PageProps<"/onboarding/team">) {
  const requestHeaders = await headers();
  const session = await auth.api.getSession({ headers: requestHeaders });
  if (!session) redirect("/login");

  const organizations = await auth.api.listOrganizations({ headers: requestHeaders });
  if (organizations.length === 0) redirect("/onboarding/organization");

  const requestedId = (await searchParams).organizationId;
  const organization = organizations.find((item) => item.id === requestedId) ?? organizations[0];
  const { role } = await auth.api.getActiveMemberRole({
    headers: requestHeaders,
    query: { organizationId: organization.id },
  });
  if (!role.split(",").some((item) => item === "owner" || item === "admin")) redirect("/");
  const invitations = await auth.api.listInvitations({
    headers: requestHeaders,
    query: { organizationId: organization.id },
  });

  return (
    <OnboardingShell
      step={2}
      title="Invite your team."
      description={`Bring others into ${organization.name}, or continue on your own. You can invite people later.`}
    >
      <TeamInvites
        organizationId={organization.id}
        actorRole={role}
        currentEmail={session.user.email}
        initialInvites={pendingInvites(invitations)}
      />
    </OnboardingShell>
  );
}
