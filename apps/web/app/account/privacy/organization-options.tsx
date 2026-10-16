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
    <section data-ph-public-label aria-label="Organizations" className="space-y-4 text-sm">
      {canCreate && (
        <NavigationLink
          href="/onboarding/organization?returnTo=account"
          className="inline-flex min-h-11 items-center rounded-lg border border-primary-grey px-4 font-medium hover:bg-hover-surface focus-visible:outline-2 focus-visible:outline-offset-2"
        >
          <span data-ph-public style={{ display: "contents" }}>
            Create an organization
          </span>
        </NavigationLink>
      )}
      <p className="text-secondary-ink">
        <span data-ph-public style={{ display: "contents" }}>
          To join an organization, open an invitation sent to{" "}
        </span>
        {email}
        <span data-ph-public style={{ display: "contents" }}>
          , or ask an owner to invite you.
        </span>
      </p>
      {invitations === null && (
        <p data-ph-public role="status" className="text-secondary-ink">
          Invitations couldn&#39;t be loaded. You can still use your invitation link.
        </p>
      )}
      {invitations && invitations.length > 0 && (
        <details>
          <summary className="cursor-pointer py-2 font-medium">
            <span data-ph-public style={{ display: "contents" }}>
              Invitations (
            </span>
            {invitations.length}
            <span data-ph-public style={{ display: "contents" }}>
              )
            </span>
          </summary>
          <ul className="max-h-48 space-y-2 overflow-y-auto">
            {invitations.map((invitation) => (
              <li key={invitation.id}>
                <NavigationLink
                  href={`/accept-invitation/${encodeURIComponent(invitation.id)}`}
                  className="inline-flex min-h-9 items-center underline underline-offset-4"
                >
                  <span data-ph-public style={{ display: "contents" }}>
                    Join{" "}
                  </span>
                  {invitation.organizationName || "organization"}
                </NavigationLink>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
