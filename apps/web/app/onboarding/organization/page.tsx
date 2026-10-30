import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { OnboardingShell } from "@/components/onboarding/onboarding-shell";
import { OrganizationForm } from "./organization-form";
import { organizationCreationStatus } from "@/lib/organizations/creation";
import { SignOutButton } from "@/app/sign-out-button";
import { NavigationLink } from "@/components/ui/navigation-link";
import type { Metadata } from "next";

export const metadata: Metadata = { title: "Create your organisation · Tidy" };

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
      <span data-ph-public style={{ display: "contents" }}>
        Back to account
      </span>
    </NavigationLink>
  ) : null;
  if (!creation.canCreateOrganization) {
    const organizations = await auth.api.listOrganizations({ headers: requestHeaders });
    if (organizations.length) redirect("/files");
    // A creator who left their original org may have no current memberships.
    // Don't redirect through /files and loop back to this page.
    return (
      <OnboardingShell
        replayDescription
        replayTitle
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
      replayDescription
      replayTitle
      step={returnToAccount ? undefined : 1}
      title="Create your workspace."
      description={
        returnToAccount
          ? "Name your workspace. You can invite people from Settings."
          : "Name your workspace, then invite your team and connect your coding agent."
      }
    >
      <OrganizationForm inviteTeam={!returnToAccount} />
      {backToAccount}
    </OnboardingShell>
  );
}
