import { NavigationLink } from "@/components/ui/navigation-link";

export function AccountOrganizationOptions({
  email,
  canCreate,
  invitations,
}: {
  email: string;
  canCreate: boolean;
  invitations: { id: string; organizationName?: string }[] | null;
}) {
  return (
    <section aria-label="Organizations" className="space-y-4 text-sm">
      {canCreate && (
        <NavigationLink
          href="/onboarding/organization?returnTo=account"
          className="inline-flex min-h-11 items-center rounded-lg border border-primary-grey px-4 font-medium hover:bg-hover-surface focus-visible:outline-2 focus-visible:outline-offset-2"
        >
          Create an organization
        </NavigationLink>
      )}
      <p className="text-secondary-ink">
        To join an organization, open an invitation sent to {email}, or ask an owner to invite you.
      </p>
      {invitations === null && (
        <p role="status" className="text-secondary-ink">
          Invitations couldn’t be loaded. You can still use your invitation link.
        </p>
      )}
      {invitations && invitations.length > 0 && (
        <details>
          <summary className="cursor-pointer py-2 font-medium">
            Invitations ({invitations.length})
          </summary>
          <ul className="max-h-48 space-y-2 overflow-y-auto">
            {invitations.map((invitation) => (
              <li key={invitation.id}>
                <NavigationLink
                  href={`/accept-invitation/${encodeURIComponent(invitation.id)}`}
                  className="inline-flex min-h-9 items-center underline underline-offset-4"
                >
                  Join {invitation.organizationName || "organization"}
                </NavigationLink>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
