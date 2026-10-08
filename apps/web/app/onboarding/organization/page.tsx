import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { OnboardingShell } from "@/components/onboarding/onboarding-shell";
import { OrganizationForm } from "./organization-form";
import { organizationCreationStatus } from "@/lib/organizations/creation";
import { SignOutButton } from "@/app/sign-out-button";

export default async function OrganizationPage() {
  const requestHeaders = await headers();
  const session = await auth.api.getSession({ headers: requestHeaders });
  if (!session) redirect("/sign-up");
  const creation = await organizationCreationStatus(session.user.id);
  if (!creation.ready) throw new Error("Organization creation is not configured.");
  if (!creation.canCreateOrganization) {
    const organizations = await auth.api.listOrganizations({ headers: requestHeaders });
    if (organizations.length) redirect("/files");
    // A creator who left their original org may have no current memberships.
    // Don't redirect through /files and loop back to this page.
    return (
      <OnboardingShell
        step={1}
        title="You already created an organisation."
        description="Ask an organisation owner to invite you to their workspace."
      >
        <SignOutButton />
      </OnboardingShell>
    );
  }

  return (
    <OnboardingShell
      step={1}
      title="Create your organisation."
      description="Give your space a name. You can invite people in the next step."
    >
      <OrganizationForm />
    </OnboardingShell>
  );
}
