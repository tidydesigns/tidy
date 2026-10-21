export const metadata = { title: "Your account · Tidy" };
import { PrivacyChoicesButton } from "@/components/privacy/privacy-choices-button";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { organizationCreationStatus } from "@/lib/organizations/creation";
import { SignOutButton } from "@/app/sign-out-button";
import { TidyLogo } from "@/components/ui/tidy-logo";
import { AccountOrganizationOptions } from "./organization-options";
import { PrivacyControls } from "./privacy-controls";

function activeInvitations(
  invitations: { id: string; organizationName?: string; expiresAt: Date }[] | null,
) {
  const now = Date.now();
  return (
    invitations
      ?.filter((invitation) => new Date(invitation.expiresAt).getTime() > now)
      .map(({ id, organizationName }) => ({ id, organizationName })) ?? null
  );
}

export default async function AccountPrivacyPage() {
  const requestHeaders = await headers();
  const account = await auth.api.getSession({
    headers: requestHeaders,
    query: { disableCookieCache: true },
  });
  if (!account) redirect("/login?next=/account/privacy");
  const organizations = await auth.api.listOrganizations({ headers: requestHeaders });
  if (organizations.length) redirect("/settings#account-data");
  const [creation, invitations] = await Promise.all([
    organizationCreationStatus(account.user.id),
    account.user.emailVerified
      ? auth.api.listUserInvitations({ headers: requestHeaders }).catch(() => null)
      : Promise.resolve([]),
  ]);
  return (
    <main className="mx-auto max-w-2xl space-y-8 px-6 py-12 pb-24">
      <div className="flex items-center justify-between gap-6">
        <TidyLogo />
        <SignOutButton />
      </div>
      <div className="space-y-3">
        <h1 data-ph-public className="text-3xl font-semibold">
          Your account
        </h1>
        <p className="text-sm text-secondary-ink">
          <span data-ph-public style={{ display: "contents" }}>
            You&#39;re signed in as{" "}
          </span>
          {account.user.email}
          <span data-ph-public style={{ display: "contents" }}>
            . You don&#39;t belong to an organization.
          </span>
        </p>
      </div>
      <AccountOrganizationOptions
        email={account.user.email}
        canCreate={creation.ready && creation.canCreateOrganization}
        invitations={activeInvitations(invitations)}
      />
      <PrivacyControls email={account.user.email} />
      <PrivacyChoicesButton />
    </main>
  );
}
