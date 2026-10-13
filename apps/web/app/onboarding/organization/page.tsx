import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { OnboardingShell } from "@/components/onboarding/onboarding-shell";
import { OrganizationForm } from "./organization-form";
import { organizationCreationStatus } from "@/lib/organizations/creation";
import { SignOutButton } from "@/app/sign-out-button";
import { NavigationLink } from "@/components/ui/navigation-link";

export default async function OrganizationPage({
  searchParams,
}: PageProps<"/onboarding/organization">) {
  const requestHeaders = await headers();
  const session = await auth.api.getSession({ headers: requestHeaders });
  if (!session) redirect("/sign-up");
  const creation = await organizationCreationStatus(session.user.id);
  if (!creation.ready) throw new Error("Organization creation is not configured.");
  const returnToAccount = (await searchParams).returnTo === "account";
  const backToAccount = returnToAccount ? (
    <NavigationLink
      href="/account/privacy"
      className="mt-6 inline-flex min-h-9 items-center text-sm font-medium underline underline-offset-4"
    >
      Back to account
    </NavigationLink>
  ) : null;
  if (!creation.canCreateOrganization) {
    const organizations = await auth.api.listOrganizations({ headers: requestHeaders });
    if (organizations.length) redirect("/files");
    // A creator who left their original org may have no current memberships.
    // Don't redirect through /files and loop back to this page.
    return (
      <OnboardingShell
        step={returnToAccount ? undefined : 1}
        title="You already created an organisation."
        description="Ask an organisation owner to invite you to their workspace."
      >
        <SignOutButton />
        {backToAccount}
      </OnboardingShell>
    );
  }

  return (
    <OnboardingShell
      step={returnToAccount ? undefined : 1}
      title="Create your organisation."
      description={
        returnToAccount
          ? "Give your space a name. You can invite people from Settings."
          : "Give your space a name. You can invite people in the next step."
      }
    >
      <OrganizationForm inviteTeam={!returnToAccount} />
      {backToAccount}
    </OnboardingShell>
  );
}
