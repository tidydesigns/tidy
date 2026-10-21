import { reportHandledError } from "@/lib/handled-error";
import { roleLabel } from "@/lib/organizations/roles";
import { NavigationLink as Link } from "@/components/ui/navigation-link";
import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import { AuthShell } from "@/components/auth/auth-shell";
import { AcceptInvitation, SwitchAccountButton } from "./accept-invitation";

export default async function InvitationPage({ params }: PageProps<"/accept-invitation/[id]">) {
  const { id } = await params;
  const requestHeaders = await headers();
  const session = await auth.api.getSession({ headers: requestHeaders });
  const next = `/accept-invitation/${id}`;

  if (!session) {
    return (
      <AuthShell
        title="You've been invited."
        description="Sign in or create an account with the email address that received your invitation."
      >
        <div className="mt-10 space-y-5">
          <Link
            href={`/login?next=${encodeURIComponent(next)}`}
            className="flex h-12 w-full items-center justify-center rounded-lg bg-primary-orange px-4 text-sm font-semibold text-on-brand hover:bg-primary-orange/90"
          >
            <span data-ph-public style={{ display: "contents" }}>
              Sign in to accept
            </span>
          </Link>
          <p className="text-center text-sm text-primary-black/70">
            <span data-ph-public style={{ display: "contents" }}>
              New to Tidy?
            </span>{" "}
            <Link
              href={`/sign-up?next=${encodeURIComponent(next)}`}
              className="font-medium text-primary-black underline decoration-primary-orange underline-offset-4"
            >
              <span data-ph-public style={{ display: "contents" }}>
                Create an account
              </span>
            </Link>
          </p>
        </div>
      </AuthShell>
    );
  }

  let invitation: Awaited<ReturnType<typeof auth.api.getInvitation>> | null = null;
  try {
    invitation = await auth.api.getInvitation({ headers: requestHeaders, query: { id } });
  } catch (cause) {
    reportHandledError(cause);
    // Better Auth rejects expired, accepted, and wrong-recipient invitations.
  }

  if (!invitation) {
    return (
      <AuthShell
        title="Invitation unavailable."
        description="This link may have expired, or it may be for a different email address."
      >
        <div className="mt-10 flex items-center gap-6">
          <SwitchAccountButton invitationId={id} />
          <Link
            href="/"
            className="text-sm font-medium underline decoration-primary-orange underline-offset-4"
          >
            <span data-ph-public style={{ display: "contents" }}>
              Go to Tidy
            </span>
          </Link>
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      title={`Join ${invitation.organizationName}.`}
      description={`You've been invited as ${roleLabel(invitation.role)} with ${invitation.email}. This gives access to every file in this workspace.`}
    >
      <AcceptInvitation invitationId={id} />
    </AuthShell>
  );
}
